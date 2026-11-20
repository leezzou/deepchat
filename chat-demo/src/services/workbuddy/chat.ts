import type { ChatAccess } from '../api/access.js'
import type { CreateMessageRequest, MessageStreamEvent, StopReason } from '../api/types.js'
import { readServerSentEvents } from '../api/sse.js'
import { workBuddyFetch } from './bridge.js'
import { searchQuestion, searchSources, withSearchEvidence } from './search.js'
import { createId } from '../../utils/id.js'
import { isWorkBuddyModel } from './models.js'

export function workBuddyMessages(body: CreateMessageRequest) {
  const rows: { role: string; content: string }[] = []
  if (body.system) {
    rows.push({ role: 'system', content: body.system })
  }
  for (const message of body.messages) {
    if (message.role === 'latest_reminder') {
      rows.push({ role: 'system', content: message.content })
      continue
    }
    if (typeof message.content === 'string') {
      rows.push({ role: message.role, content: message.content })
      continue
    }
    if (message.content.some((part) => part.type === 'document' || part.type === 'image')) {
      throw new Error('WorkBuddy · 此通道仅支持文字消息 / Text messages only')
    }
    const content = message.content
      .map((part) => (part.type === 'text' ? part.text : ''))
      .filter(Boolean)
      .join('\n')
    if (content) {
      rows.push({ role: message.role, content })
    }
  }
  return rows
}

function serviceError(data: unknown, status?: number) {
  const body = data && typeof data === 'object' ? (data as Record<string, unknown>) : {}
  const details =
    body.error && typeof body.error === 'object' ? (body.error as Record<string, unknown>) : body
  const code = details.code ?? details.type
  const message =
    details.message ??
    details.msg ??
    details.error_msg ??
    (typeof body.error === 'string' ? body.error : '')
  const safe = (v: unknown) =>
    typeof v === 'string' || typeof v === 'number'
      ? String(v)
          .replace(/Bearer\s+\S+|\beyJ[\w-]+\.[\w-]+\.[\w-]+/gi, '[redacted]')
          .slice(0, 300)
      : ''
  return new Error(
    ['WorkBuddy', status && `HTTP ${status}`, safe(code), safe(message)].filter(Boolean).join(' · ')
  )
}

export async function* streamWorkBuddy(
  access: Extract<ChatAccess, { source: 'workbuddy' }>,
  body: CreateMessageRequest,
  signal: AbortSignal,
  onDispatch?: () => void
): AsyncGenerator<MessageStreamEvent> {
  if (!isWorkBuddyModel(access.model)) {
    throw new Error('WorkBuddy · Unsupported model')
  }
  let messages = workBuddyMessages(body)
  const thinking = body.thinking.type === 'enabled'
  const search = body.tools.some((tool) => tool.type === 'deepseek_web_search')
  const requestId = `wb-${createId()}`
  let index = -1
  signal.throwIfAborted()
  yield { type: 'message_start', message: { id: requestId, model: access.model } }
  if (search) {
    const question = searchQuestion(messages)
    const toolId = `wb-search-${requestId}`
    yield {
      type: 'content_block_start',
      index: ++index,
      content_block: {
        type: 'server_tool_use',
        id: toolId,
        name: 'deepseek_web_search',
        kind: 'search',
        caller: { type: 'direct' },
        input: { action: 'search', queries: [question.query] },
      },
    }
    yield { type: 'content_block_stop', index }
    let sources
    try {
      const response = await workBuddyFetch(
        access.model,
        access.revision,
        { op: 'search', query: question.query },
        signal
      )
      const data = await response.json().catch(() => null)
      if (!response.ok || data?.error || (data?.code != null && data.code !== 0)) {
        throw serviceError(data, response.status)
      }
      sources = searchSources(data)
    } catch (error) {
      signal.throwIfAborted()
      yield {
        type: 'content_block_start',
        index: ++index,
        content_block: {
          type: 'web_search_tool_result',
          tool_use_id: toolId,
          kind: 'search',
          content: [{ type: 'web_search_tool_result_error', error_code: 'unavailable' }],
        },
      }
      yield { type: 'content_block_stop', index }
      throw new Error(
        `WorkBuddy 搜索 / Search · ${error instanceof Error ? error.message : String(error)}`
      )
    }
    yield {
      type: 'content_block_start',
      index: ++index,
      content_block: {
        type: 'web_search_tool_result',
        tool_use_id: toolId,
        kind: 'search',
        content: sources,
      },
    }
    yield { type: 'content_block_stop', index }
    messages = withSearchEvidence(messages, question.index, sources)
  }
  signal.throwIfAborted()
  onDispatch?.()
  const response = await workBuddyFetch(
    access.model,
    access.revision,
    { op: 'chat', messages, thinking },
    signal
  )
  if (
    !response.ok ||
    !response.body ||
    !response.headers.get('Content-Type')?.toLowerCase().includes('text/event-stream')
  ) {
    const error = await response.json().catch(() => null)
    throw serviceError(error, response.status)
  }
  let block: 'text' | 'thinking' | undefined
  let sawThinking = false
  let finished = false
  let reason: StopReason = 'end_turn'
  for await (const frame of readServerSentEvents(response.body, signal)) {
    if (frame.data === '[DONE]') {
      finished = true
      break
    }
    const chunk = JSON.parse(frame.data)
    if (!chunk || typeof chunk !== 'object') {
      throw new Error('WorkBuddy · Invalid response')
    }
    if (chunk.model != null && chunk.model !== access.model) {
      throw new Error('WorkBuddy · 腾讯返回了不同的模型 / Model mismatch')
    }
    if (frame.event === 'error' || chunk.error || (chunk.code != null && chunk.code !== 0)) {
      throw serviceError(chunk)
    }
    const choice = chunk.choices?.[0]
    if (!choice) {
      continue
    }
    if (choice.finish_reason) {
      finished = true
      if (choice.finish_reason === 'length') {
        reason = 'max_tokens'
      }
      if (choice.finish_reason === 'content_filter' || choice.finish_reason === 'refusal') {
        reason = 'refusal'
      }
    }
    for (const kind of ['thinking', 'text'] as const) {
      const text = kind === 'thinking' ? choice.delta?.reasoning_content : choice.delta?.content
      if (typeof text !== 'string' || !text) {
        continue
      }
      if (kind === 'thinking') {
        sawThinking = true
      }
      if (block !== kind) {
        if (block) {
          yield { type: 'content_block_stop', index }
        }
        block = kind
        index++
        yield {
          type: 'content_block_start',
          index,
          content_block:
            kind === 'text'
              ? { type: 'text', text: '' }
              : { type: 'thinking', thinking: '', signature: '' },
        }
      }
      yield {
        type: 'content_block_delta',
        index,
        delta:
          kind === 'text'
            ? { type: 'text_delta', text }
            : { type: 'thinking_delta', thinking: text },
      }
    }
  }
  signal.throwIfAborted()
  if (!finished) {
    throw new Error('WorkBuddy · 回复连接中断 / Interrupted response')
  }
  if (block) {
    yield { type: 'content_block_stop', index }
  }
  if (!block && reason !== 'refusal') {
    throw new Error('WorkBuddy · 腾讯未返回回复内容 / Empty reply')
  }
  yield {
    type: 'message_delta',
    delta: { stop_reason: reason, stop_sequence: null },
    ...(thinking && !sawThinking && reason !== 'refusal' ? { workBuddyReasoningUnavailable: true } : {}),
  }
  yield { type: 'message_stop' }
}
