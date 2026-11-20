import type { ChatAccess } from '../api/access.js'
import type {
  CreateMessageRequest,
  MessageStreamEvent,
  MessageUsage,
  StopReason,
} from '../api/types.js'
import {
  completionStop,
  completionUsage,
  mergeCompletionUsage,
  reasoningText,
} from '../api/compatibleChunk.js'
import { readServerSentEvents } from '../api/sse.js'
import { workBuddyFetch } from './bridge.js'
import { retrieve } from './retrieve.js'
import { AnswerBlocks } from './answer.js'
import type { SearchHit } from './search.js'
import { createId } from '../../utils/id.js'
import { isWorkBuddyModel } from './models.js'
import { serviceError, workBuddyChunk, workBuddyResponseModel } from './responseModel.js'

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
  let nextIndex = 0
  let hits: SearchHit[] = []
  let ids = new Set<string>()
  signal.throwIfAborted()
  yield { type: 'message_start', message: { id: requestId, model: access.model } }
  if (search) {
    const result = yield* retrieve(access, body, messages, requestId, signal)
    ;({ messages, nextIndex, hits, ids } = result)
  }
  signal.throwIfAborted()
  const checkModel = workBuddyResponseModel(access.model)
  onDispatch?.()
  const response = await workBuddyFetch(
    access.model,
    access.revision,
    {
      op: 'chat',
      messages,
      thinking,
      ...(body.max_tokens !== undefined && { max_tokens: body.max_tokens }),
    },
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
  const origin = response.headers.get('X-DeepChat-WorkBuddy-Origin')
  let responseModel: string | undefined
  const blocks = new AnswerBlocks(nextIndex - 1, hits, ids, search)
  let finished = false
  let reason: StopReason = 'end_turn'
  let usage: MessageUsage | undefined
  for await (const frame of readServerSentEvents(response.body, signal)) {
    if (frame.data === '[DONE]') {
      finished = true
      break
    }
    const chunk = workBuddyChunk(frame)
    responseModel = checkModel(chunk.model, origin) ?? responseModel
    const counters = completionUsage(chunk.usage)
    if (counters) {
      usage = mergeCompletionUsage(usage, counters)
      yield { type: 'message_usage', usage }
    }
    const choice = chunk.choices?.[0]
    if (!choice) {
      continue
    }
    const end = completionStop(choice.finish_reason)
    if (end === 'interrupted') {
      throw new Error('WorkBuddy · 回复连接中断 / Interrupted response')
    }
    if (end) {
      finished = true
      if (reason !== 'refusal') {
        reason = end
      }
    }
    const refusal = choice.delta?.refusal
    if (typeof refusal === 'string' && refusal.trim()) {
      reason = 'refusal'
    }
    for (const kind of ['thinking', 'text'] as const) {
      const text =
        kind === 'thinking' ? reasoningText(choice.delta) : choice.delta?.content || refusal
      if (typeof text !== 'string' || !text) {
        continue
      }
      if (kind !== 'thinking' || thinking) {
        yield* blocks.push(kind, text)
      }
    }
  }
  signal.throwIfAborted()
  if (!finished) {
    throw new Error('WorkBuddy · 回复连接中断 / Interrupted response')
  }
  yield* blocks.finish()
  if (!blocks.emitted && reason !== 'refusal') {
    throw new Error('WorkBuddy · 腾讯未返回回复内容 / Empty reply')
  }
  yield {
    type: 'message_delta',
    ...(responseModel && { workBuddyResponseModel: responseModel }),
    delta: { stop_reason: reason, stop_sequence: null },
    ...(usage && { usage }),
  }
  yield { type: 'message_stop' }
}
