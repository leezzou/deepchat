import { translate, type TranslationMessage } from '../../i18n/index.js'
import { getApiConfig, getApiOrigin } from './origin.js'
import { readMessageEvent } from './parseEvent.js'
import { readServerSentEvents } from './sse.js'
import type {
  ApiErrorBody,
  CreateMessageRequest,
  FileObject,
  FilePurpose,
  MessageStreamEvent,
  StopReason,
} from './types.js'

/** Anthropic 兼容接口的前缀（跟随当前配置的接口地址） */
const anthropicBaseUrl = () => `${getApiOrigin()}/anthropic/v1`
/** 引用 Files API 上传的图片、调用 Anthropic 兼容 Files API 时必须携带 */
const FILES_BETA = 'files-api-2025-04-14'

export type ApiErrorKind =
  /** 非 2xx 响应 */
  | 'http'
  /** 流中返回的错误帧（如等待生成超时），随后连接关闭 */
  | 'stream'
  /** 请求没有到达服务端（断网、跨域被拦截等） */
  | 'network'
  /** 流在 message_stop 之前结束 */
  | 'interrupted'
  /** 响应不符合协议（如非 SSE 响应） */
  | 'protocol'

export class ApiError extends Error {
  readonly localMessage?: TranslationMessage

  constructor(
    readonly kind: ApiErrorKind,
    message: string | TranslationMessage,
    readonly status?: number
  ) {
    super(typeof message === 'string' ? message : translate(message.key, message.params))
    this.name = 'ApiError'
    this.localMessage = typeof message === 'string' ? undefined : message
  }
}

const isErrorBody = (value: unknown): value is ApiErrorBody =>
  typeof value === 'object' &&
  value !== null &&
  'error' in value &&
  typeof (value as ApiErrorBody).error?.message === 'string'

const readErrorResponse = async (
  response: Response,
  kind: 'http' | 'protocol' = 'http',
  fallback = response.statusText
): Promise<ApiError> => {
  const text = await response.text().catch(() => '')
  let message = text || fallback
  try {
    const body: unknown = JSON.parse(text)
    if (isErrorBody(body)) {
      message = body.error.message
    }
  } catch {
    // 非 JSON 响应体直接展示原文
  }
  return new ApiError(kind, message, response.status)
}

export const request = async (url: string, init: RequestInit): Promise<Response> => {
  let response: Response
  try {
    response = await fetch(url, init)
  } catch (error) {
    if (init.signal?.aborted) {
      throw error
    }
    throw new ApiError('network', error instanceof Error ? error.message : String(error))
  }
  if (!response.ok) {
    throw await readErrorResponse(response)
  }
  return response
}

const anthropicHeaders = (apiKey: string, beta: boolean): Record<string, string> => ({
  // DeepSeek 兼容接口的鉴权方式，也可使用 Authorization: Bearer。
  'x-api-key': apiKey,
  // Files API 和通过 file_id 引用图片时必传；纯文本聊天无需携带。
  ...(beta ? { 'anthropic-beta': FILES_BETA } : {}),
})

/** 用 GET /models 校验 API Key（不产生费用）；origin 为空时用当前配置的地址 */
export const verifyApiKey = async (
  apiKey: string,
  origin?: string,
  signal?: AbortSignal
): Promise<void> => {
  await request(`${origin?.trim() ? origin.trim().replace(/\/+$/, '') : getApiOrigin()}/models`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
    signal,
  })
}

/**
 * POST /anthropic/v1/files 上传附件（不设过期时间，会话里的历史附件一直可用）。
 * purpose 为 null 时不传该字段（图片）；purpose 必须排在 file 之前。
 */
export const uploadFile = async (
  apiKey: string,
  file: File,
  purpose: FilePurpose | null,
  signal?: AbortSignal
): Promise<FileObject> => {
  const form = new FormData()
  if (purpose) {
    form.append('purpose', purpose)
  }
  form.append('file', file)
  const response = await request(`${anthropicBaseUrl()}/files`, {
    method: 'POST',
    headers: anthropicHeaders(apiKey, true),
    body: form,
    signal,
  })
  return (await response.json()) as FileObject
}

/** DELETE /anthropic/v1/files/{file_id} */
export const deleteFile = async (apiKey: string, fileId: string): Promise<void> => {
  await request(`${anthropicBaseUrl()}/files/${encodeURIComponent(fileId)}`, {
    method: 'DELETE',
    headers: anthropicHeaders(apiKey, true),
  })
}

const hasFile = (body: CreateMessageRequest) =>
  body.messages.some(
    (message) =>
      typeof message.content !== 'string' &&
      message.content.some((block) => block.type === 'image' || block.type === 'document')
  )

/** 把 Anthropic 风格的 messages 摊平成 OpenAI 兼容的纯文本消息（附件与扩展角色跳过） */
const toOpenAiMessages = (body: CreateMessageRequest) => {
  const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = []
  if (body.system) {
    messages.push({ role: 'system', content: body.system })
  }
  for (const message of body.messages) {
    // latest_reminder 是 DeepSeek 的扩展角色，OpenAI 兼容接口不认
    if (message.role === 'latest_reminder') {
      continue
    }
    const text =
      typeof message.content === 'string'
        ? message.content
        : message.content
            .map((block) => (block.type === 'text' ? block.text : ''))
            .filter(Boolean)
            .join('\n')
    if (text.trim()) {
      messages.push({ role: message.role, content: text })
    }
  }
  return messages
}

/**
 * OpenAI 兼容的 POST /chat/completions（stream: true）。
 * 把 chat.completion.chunk 的增量翻译成与 Anthropic 一样的 MessageStreamEvent，
 * 上层的 applyEvent / 渲染逻辑完全不用改。
 */
async function* streamOpenAiChat(
  apiKey: string,
  body: CreateMessageRequest,
  signal: AbortSignal
): AsyncGenerator<MessageStreamEvent> {
  const { origin, model } = getApiConfig()
  const response = await request(`${origin}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({
      model,
      messages: toOpenAiMessages(body),
      stream: true,
    }),
    signal,
  })
  const contentType = response.headers.get('Content-Type') ?? ''
  if (!response.body || !contentType.includes('text/event-stream')) {
    throw await readErrorResponse(response, 'protocol', '')
  }

  yield {
    type: 'message_start',
    message: { id: `openai-${Date.now().toString(36)}`, model },
  }
  let started = false
  let stopReason: StopReason = 'end_turn'
  for await (const { data } of readServerSentEvents(response.body, signal)) {
    if (data === '[DONE]') {
      break
    }
    let payload: unknown
    try {
      payload = JSON.parse(data)
    } catch {
      continue
    }
    if (isErrorBody(payload)) {
      throw new ApiError('stream', payload.error.message)
    }
    const chunk = payload as {
      choices?: { delta?: { content?: string }; finish_reason?: string | null }[]
    }
    const choice = chunk.choices?.[0]
    if (!choice) {
      continue
    }
    const piece = choice.delta?.content
    if (piece) {
      if (!started) {
        started = true
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
      }
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } }
    }
    if (choice.finish_reason === 'length') {
      stopReason = 'max_tokens'
    }
  }
  if (started) {
    yield { type: 'content_block_stop', index: 0 }
  } else {
    // 没有任何正文也算正常结束（比如只回了思考内容），给上层一个空文本块
    yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
    yield { type: 'content_block_stop', index: 0 }
  }
  yield { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null } }
  yield { type: 'message_stop' }
}

/**
 * POST /anthropic/v1/messages（stream: true），逐个产出流式事件，收到 message_stop 时结束。
 * 当前配置是 OpenAI 兼容服务商时改走 /chat/completions，事件格式保持一致。
 * ping、保活注释与无法解析的内容不产出；中止请求时抛出 signal 的 AbortError。
 */
export async function* streamMessage(
  apiKey: string,
  body: CreateMessageRequest,
  signal: AbortSignal
): AsyncGenerator<MessageStreamEvent> {
  if (getApiConfig().protocol === 'openai') {
    yield* streamOpenAiChat(apiKey, body, signal)
    return
  }
  const response = await request(`${anthropicBaseUrl()}/messages`, {
    method: 'POST',
    headers: {
      ...anthropicHeaders(apiKey, hasFile(body)),
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({ ...body, stream: true }),
    signal,
  })
  const contentType = response.headers.get('Content-Type') ?? ''
  if (!response.body || !contentType.includes('text/event-stream')) {
    throw await readErrorResponse(response, 'protocol', '')
  }
  for await (const { event: eventName, data } of readServerSentEvents(response.body, signal)) {
    let payload: unknown
    try {
      payload = JSON.parse(data)
    } catch {
      if (eventName !== 'error') {
        continue
      }
    }
    if (isErrorBody(payload)) {
      throw new ApiError('stream', payload.error.message)
    }
    if (eventName === 'error') {
      throw new ApiError('stream', data)
    }
    const event = readMessageEvent(payload)
    if (!event) {
      continue
    }
    yield event
    if (event.type === 'message_stop') {
      return
    }
  }
  // 服务端没有提供错误内容时保持为空，不推测断流原因。
  throw new ApiError('interrupted', '')
}
