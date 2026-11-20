import type { ApiError as ResponseApiError } from './client.js'
import { completionUsage } from './compatibleChunk.js'
import {
  hasOpenAiThinkingToggle,
  streamsOpenAiResponses,
  usesOpenAiResponses,
} from './openAiModels.js'
import { asRecord, publicSourceUrl } from './searchCitations.js'
import { readServerSentEvents } from './sse.js'
import type { CreateMessageRequest, MessageStreamEvent, StopReason } from './types.js'

/** Responses takes typed input items and a distinct output cap. Replay visible conversation only. */
export function responsesPayload(model: string, body: CreateMessageRequest, webSearch = false) {
  const input: { role: string; content: unknown }[] = []
  if (body.system) {
    input.push({ role: 'developer', content: body.system })
  }
  for (const message of body.messages) {
    if (message.role === 'latest_reminder') {
      continue
    }
    if (typeof message.content === 'string') {
      input.push({ role: message.role, content: message.content })
    } else if (message.role === 'user') {
      const content = message.content.map((b) =>
        b.type === 'text'
          ? { type: 'input_text', text: b.text }
          : { type: b.type === 'image' ? 'input_image' : 'input_file', file_id: b.source.file_id }
      )
      if (content.length) {
        input.push({ role: 'user', content })
      }
    } else {
      const content = message.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
      if (content) {
        input.push({ role: 'assistant', content })
      }
    }
  }
  return {
    model,
    input,
    store: false,
    stream: !usesOpenAiResponses(model) || streamsOpenAiResponses(model),
    ...(webSearch && { tools: [{ type: 'web_search' }] }),
    ...(body.max_tokens !== undefined && { max_output_tokens: body.max_tokens }),
    ...(hasOpenAiThinkingToggle(model)
      ? {
          reasoning: {
            effort: body.thinking?.type === 'enabled' ? 'medium' : 'none',
            ...(body.thinking?.type === 'enabled' && { summary: 'auto' }),
          },
        }
      : usesOpenAiResponses(model) &&
        body.thinking?.type === 'enabled' && { reasoning: { summary: 'auto' } }),
  }
}

type BlockKind = 'text' | 'thinking'
type Row = Record<string, unknown>
/** Consume only documented public output, summary_text and URL citations. Completed snapshots can repeat preceding deltas. */
export async function* openAiResponseEvents(
  response: Response,
  model: string,
  signal: AbortSignal,
  summaries: boolean,
  ApiError: typeof ResponseApiError
): AsyncGenerator<MessageStreamEvent> {
  const blocks = new Map<string, { index: number; text: string }>()
  const seenLinks = new Set<string>()
  let refused = false
  function* append(
    key: string,
    kind: BlockKind,
    text: unknown,
    snapshot = false
  ): Generator<MessageStreamEvent> {
    if (typeof text !== 'string' || !text || (kind === 'thinking' && !summaries)) {
      return
    }
    let block = blocks.get(key)
    const value =
      snapshot && block ? (text.startsWith(block.text) ? text.slice(block.text.length) : '') : text
    if (!value) {
      return
    }
    if (!block) {
      block = { index: blocks.size, text: '' }
      blocks.set(key, block)
      yield {
        type: 'content_block_start',
        index: block.index,
        content_block:
          kind === 'text'
            ? { type: 'text', text: '' }
            : { type: 'thinking', thinking: '', signature: '' },
      }
    }
    block.text += value
    yield {
      type: 'content_block_delta',
      index: block.index,
      delta:
        kind === 'text'
          ? { type: 'text_delta', text: value }
          : { type: 'thinking_delta', thinking: value },
    }
  }
  function* link(key: string, value: unknown): Generator<MessageStreamEvent> {
    const annotation = asRecord(value),
      url = publicSourceUrl(annotation.url),
      block = blocks.get(key)
    if (annotation.type !== 'url_citation' || !block || !url || seenLinks.has(url)) {
      return
    }
    seenLinks.add(url)
    yield {
      type: 'content_block_delta',
      index: block.index,
      delta: {
        type: 'citations_delta',
        citation: {
          type: 'web_search_result_location',
          url,
          title: typeof annotation.title === 'string' ? annotation.title : null,
          cited_text: '',
          encrypted_index: '',
        },
      },
    }
  }
  function* snapshot(row: Row): Generator<MessageStreamEvent> {
    if (!Array.isArray(row.output)) {
      return
    }
    for (const [index, value] of row.output.entries()) {
      const item = asRecord(value)
      const parts =
        item.type === 'message'
          ? item.content
          : item.type === 'reasoning'
            ? item.summary
            : undefined
      if (!Array.isArray(parts)) {
        continue
      }
      for (const [i, v] of parts.entries()) {
        const p = asRecord(v),
          key = `${index}/${i}`
        if (item.type === 'reasoning' && p.type === 'summary_text') {
          yield* append(key, 'thinking', p.text, true)
        }
        if (item.type === 'message' && p.type === 'refusal') {
          refused = true
          yield* append(key, 'text', p.refusal, true)
        }
        if (item.type === 'message' && p.type === 'output_text') {
          yield* append(key, 'text', p.text, true)
          if (Array.isArray(p.annotations)) {
            for (const a of p.annotations) {
              yield* link(key, a)
            }
          }
        }
      }
    }
  }
  function* finish(row: Row): Generator<MessageStreamEvent> {
    const usage = completionUsage(row.usage)
    if (usage) {
      yield { type: 'message_usage', usage }
    }
    yield* snapshot(row)
    const error = asRecord(row.error)
    if (row.status === 'failed' || row.error) {
      throw new ApiError('stream', typeof error.message === 'string' ? error.message : '')
    }
    const incomplete = asRecord(row.incomplete_details).reason
    let reason: StopReason
    if (row.status === 'completed') {
      reason = refused ? 'refusal' : 'end_turn'
    } else if (row.status === 'incomplete' && incomplete === 'max_output_tokens') {
      reason = 'max_tokens'
    } else if (row.status === 'incomplete' && incomplete === 'content_filter') {
      reason = 'refusal'
    } else {
      throw new ApiError('interrupted', '')
    }
    for (const block of blocks.values()) {
      yield { type: 'content_block_stop', index: block.index }
    }
    yield {
      type: 'message_delta',
      delta: { stop_reason: reason, stop_sequence: null },
      ...(usage && { usage }),
    }
    yield { type: 'message_stop' }
  }
  signal.throwIfAborted()
  yield { type: 'message_start', message: { id: `openai-${Date.now().toString(36)}`, model } }
  const type = response.headers.get('content-type') ?? ''
  if (type.includes('application/json')) {
    const row = asRecord(await response.json())
    signal.throwIfAborted()
    yield* finish(row)
    return
  }
  if (!response.body || !type.includes('text/event-stream')) {
    throw new ApiError('protocol', '')
  }
  for await (const frame of readServerSentEvents(response.body, signal)) {
    signal.throwIfAborted()
    let e: Row
    try {
      e = asRecord(JSON.parse(frame.data))
    } catch {
      throw new ApiError('protocol', '')
    }
    const key = `${e.output_index}/${e.content_index ?? e.summary_index}`
    switch (e.type) {
      case 'response.output_text.delta':
        yield* append(key, 'text', e.delta)
        break
      case 'response.output_text.done':
        yield* append(key, 'text', e.text, true)
        break
      case 'response.output_text.annotation.added':
        yield* link(key, e.annotation)
        break
      case 'response.reasoning_summary_text.delta':
        yield* append(key, 'thinking', e.delta)
        break
      case 'response.reasoning_summary_text.done':
        yield* append(key, 'thinking', e.text, true)
        break
      case 'response.refusal.delta':
      case 'response.refusal.done':
        refused = true
        yield* append(key, 'text', e.delta ?? e.refusal, e.type === 'response.refusal.done')
        break
      case 'response.failed':
      case 'response.incomplete':
      case 'response.completed':
        yield* finish(asRecord(e.response))
        return
      case 'error':
        throw new ApiError('stream', typeof e.message === 'string' ? e.message : '')
    }
  }
  throw new ApiError('interrupted', '')
}
