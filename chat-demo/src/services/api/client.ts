import { translate, type TranslationMessage } from '../../i18n/index.js'
import { CLAUDE_BASE, claudeHeaders, claudeRequest, isAnthropicOrigin } from './anthropicOfficial.js'
import { ClaudeStream } from './claudeStream.js'
import { getApiOrigin } from './origin.js'
import { endpointFileInput, originalFileIssue } from './fileCapabilities.js'
import { accessOrigin, type ChatAccess } from './access.js'
import { accountFetch } from '../../shell/account.js'
import { profileChatFetch } from '../../shell/profileChat.js'
import { readMessageEvent } from './parseEvent.js'
import { isDeepSeekApiOrigin, reasoningFields, reasoningWire } from './providerParity.js'
import { completionStop, completionUsage, mergeCompletionUsage, reasoningText } from './compatibleChunk.js'
import { ThinkingEvents } from './thinkingEvents.js'
import { beginUsage, type UsagePurpose, type UsageStatus } from '../usage/ledger.js'
import { chatSearchFields } from './searchCapabilities.js'
import { readChatCitations } from './searchCitations.js'
import { DeepSeekChatTools, signedChatReads } from './deepseekChatTools.js'
import { isPortableGrant } from './searchConsent.js'
import { isOpenAiOrigin, supportsOpenAiSearch, usesOpenAiResponses } from './openAiModels.js'
import { openAiResponseEvents, responsesPayload } from './openAiResponses.js'
import { readServerSentEvents } from './sse.js'
import { streamWorkBuddy } from '../workbuddy/chat.js'
import type {
  ApiErrorBody,
  CreateMessageRequest,
  FilePurpose,
  MessageStreamEvent,
  StopReason,
} from './types.js'

/** Anthropic 兼容接口的前缀（跟随当前配置的接口地址） */
const officialClaude = (access: ChatAccess) => access.source === 'api' && access.config.protocol !== 'deepseek' && isAnthropicOrigin(access.config.origin)
const anthropicBaseUrl = (access: ChatAccess) => officialClaude(access) ? CLAUDE_BASE : `${accessOrigin(access)}/anthropic/v1`
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

const accountFileErrors = new Map<string, TranslationMessage['key']>([
  ['DS_FILE_MESSAGE_REJECTED', 'uploadReplyRejected'],
  ['DS_FILE_UPLOAD_REJECTED', 'uploadFileRejected'],
  ['DS_FILE_REFERENCE_EXPIRED', 'uploadExpiredFile'],
  ['DS_FILE_CONTEXT_LIMIT', 'replyContextFull'],
  ['DS_FILE_DOCUMENT_COUNT', 'uploadDocCount'],
  ['DS_FILE_TEXT_LIMIT', 'uploadTextLimit'],
  ['DS_FILE_ENCRYPTED', 'uploadEncrypted'],
  ['DS_FILE_PARSE_FAILED', 'uploadParseRejected'],
  ['DS_FILE_PURPOSE', 'uploadFilePurpose'],
  ['DS_FILE_MODEL', 'uploadFileModel'],
  ['DS_FILE_BLOCK_TYPE', 'uploadFileBlock'],
  ['DS_FILE_BETA', 'uploadFileBeta'],
  ['DS_FILE_COUNT_LIMIT', 'uploadAccountQuota'],
  ['DS_FILE_STORAGE_LIMIT', 'uploadAccountQuota'],
])

const diagnosticFields = new Set(['purpose', 'file', 'file_id', 'model', 'messages', 'content', 'source', 'type',
  'media_type', 'anthropic-beta', 'max_tokens', 'thinking', 'output_config', 'tools', 'tool_choice', 'role', 'system'])

const accountFileMessage = (message: string, status: number, diagnostic: unknown): TranslationMessage | undefined => {
  const key = accountFileErrors.get(message)
  if (!key) {return undefined}
  if ((key !== 'uploadReplyRejected' && key !== 'uploadFileRejected') || (status !== 400 && status !== 422)) {
    return { key }
  }
  const upload = key === 'uploadFileRejected'
  const details: string[] = []
  if (diagnostic && typeof diagnostic === 'object') {
    const d = diagnostic as Record<string, unknown>
    if (d.stage === (upload ? 'upload' : 'messages') && d.status === status) {
      if (d.type === 'invalid_request_error') {details.push(`type=${d.type}`)}
      if (d.code === 'invalid_request_error' || d.code === 'context_length_exceeded') {details.push(`code=${d.code}`)}
      if (typeof d.param === 'string' && diagnosticFields.has(d.param)) {details.push(`param=${d.param}`)}
      if (typeof d.requestId === 'string' && d.requestId.length === 36 && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(d.requestId)) {
        details.push(`x-request-id=${d.requestId}`)
      } else if (typeof d.traceId === 'string' && d.traceId.length === 32 && /^[a-f\d]{32}$/i.test(d.traceId)) {
        details.push(`x-ds-trace-id=${d.traceId}`)
      }
    }
  }
  return { key: upload ? 'uploadValidationDiagnostic' : 'replyValidationDiagnostic', params: { status, details: details.length ? ` · ${details.join(' · ')}` : '' } }
}

const readErrorResponse = async (
  response: Response,
  kind: 'http' | 'protocol' = 'http',
  fallback = response.statusText,
  account = false
): Promise<ApiError> => {
  const text = await response.text().catch(() => '')
  let message = text || fallback
  let diagnostic: unknown
  try {
    const body: unknown = JSON.parse(text)
    if (isErrorBody(body)) {
      message = body.error.message
      if ('diagnostic' in body.error) {diagnostic = body.error.diagnostic}
    }
  } catch {
    // 非 JSON 响应体直接展示原文
  }
  const local = account ? accountFileMessage(message, response.status, diagnostic) : undefined
  return new ApiError(kind, local ?? message, response.status)
}

export const request = async (url: string, init: RequestInit, access?: ChatAccess): Promise<Response> => {
  if (access?.source === 'workbuddy') throw new ApiError('protocol', 'WorkBuddy · 此功能仅支持文字聊天')
  let response: Response
  try {
    response = access?.source === 'account'
      ? await accountFetch(url, init)
      : await (profileChatFetch(access, url, init) ?? fetch(url, { ...init, credentials: 'omit', redirect: 'error' }))
  } catch (error) {
    if (init.signal?.aborted) {
      throw error
    }
    throw new ApiError('network', error instanceof Error ? error.message : String(error))
  }
  if (!response.ok) {
    if (access?.source === 'account' && (response.status === 401 || response.status === 402)) {
      await response.body?.cancel()
      const key = response.status === 401 ? 'dshAccountExpired' : 'dshAccountInsufficient'
      throw new ApiError('http', { key }, response.status)
    }
    throw await readErrorResponse(response, 'http', response.statusText, access?.source === 'account')
  }
  return response
}

/** 校验类请求不能无限转圈；上传和流式聊天不使用这个包装。 */
const requestWithTimeout = async (
  url: string,
  init: RequestInit,
  timeoutMs = 15_000
): Promise<Response> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const external = init.signal
  const abort = () => controller.abort()
  if (external?.aborted) {
    controller.abort()
  } else {
    external?.addEventListener('abort', abort, { once: true })
  }
  try {
    return await request(url, { ...init, signal: controller.signal })
  } catch (error) {
    if (controller.signal.aborted && !external?.aborted) {
      throw new ApiError('network', '请求超时，请检查网络或接口地址')
    }
    throw error
  } finally {
    clearTimeout(timer)
    external?.removeEventListener('abort', abort)
  }
}

const anthropicHeaders = (access: ChatAccess, beta: boolean): Record<string, string> => officialClaude(access) && access.source === 'api' ? claudeHeaders(access.key) : ({
  // DeepSeek 兼容接口的鉴权方式，也可使用 Authorization: Bearer。
  ...(access.source === 'api' ? { 'x-api-key': access.key } : {}),
  // Files API 和通过 file_id 引用图片时必传；纯文本聊天无需携带。
  ...(beta ? { 'anthropic-beta': FILES_BETA } : {}),
})

/** 用 GET /models 校验 API Key（不产生费用）；origin 为空时用当前配置的地址 */
export const verifyApiKey = async (
  apiKey: string,
  origin?: string,
  signal?: AbortSignal
): Promise<void> => {
  const endpoint = origin?.trim().replace(/\/+$/, '') || getApiOrigin()
  const claude = isAnthropicOrigin(endpoint)
  await requestWithTimeout(
    `${claude ? CLAUDE_BASE : endpoint}/models`,
    {
      method: 'GET',
      headers: claude ? claudeHeaders(apiKey) : { Authorization: `Bearer ${apiKey}` },
      signal,
    }
  )
}

const isOpenAi = (access: ChatAccess): access is Extract<ChatAccess, { source: 'api' }> =>
  access.source === 'api' && access.config.protocol === 'openai'

const officialFiles = (origin: string): boolean => {
  try {
    return new URL(origin).origin === 'https://api.deepseek.com'
  } catch {
    // A relative development proxy need not implement the official Files API.
    return false
  }
}

// The official file-input model is Flash. Leave model selection to the user and let
// compatible endpoints, aliases and future models advertise their own capabilities.
function checkFileModel(access: ChatAccess, model: string) {
  if (model === 'deepseek-v4-pro' && officialFiles(accessOrigin(access))) {
    throw new ApiError('protocol', { key: 'uploadFileModel' })
  }
  if (access.source === 'workbuddy' || (access.source === 'api' &&
      endpointFileInput(access.config.origin, model, access.config.providerId, access.config.protocol) === 'text')) {
    throw new ApiError('protocol', { key: 'originalFileUnsupported' })
  }
}

const filesEndpoint = (access: ChatAccess) => isOpenAi(access) && !officialClaude(access)
  ? { url: `${access.config.origin}/files`, headers: { Authorization: `Bearer ${access.key}` } as Record<string, string> }
  : { url: `${anthropicBaseUrl(access)}/files`, headers: anthropicHeaders(access, true) }

/** Keep purpose before file: the parsing service reads multipart fields in order. */
export const uploadFile = async (
  access: ChatAccess,
  file: File,
  purpose: FilePurpose | null,
  signal?: AbortSignal
): Promise<{ id: string }> => {
  const openAi = isOpenAi(access)
  const official = officialFiles(accessOrigin(access))
  // An official PDF/Office upload can already incur a parsing charge.
  checkFileModel(access, access.source === 'api' ? access.config.model : access.model ?? 'deepseek-flash')
  const issue = originalFileIssue(accessOrigin(access), file)
  if (issue) {
    throw new ApiError('protocol', { key: issue })
  }
  const form = new FormData()
  const selectedPurpose = openAi ? (official ? purpose ?? 'user_data' : 'user_data') : purpose
  if (selectedPurpose && !officialClaude(access)) {
    form.append('purpose', selectedPurpose)
  }
  form.append('file', file)
  const { url, headers } = filesEndpoint(access)
  let response: Response
  try {
    response = await request(url, { method: 'POST', headers, body: form, signal }, access)
  } catch (error) {
    if (!official && error instanceof ApiError && [404, 405, 501].includes(error.status ?? 0)) {
      throw new ApiError('http', { key: 'uploadApiUnavailable' }, error.status)
    }
    throw error
  }
  const uploaded: unknown = await response.json().catch(() => null)
  // Document parsing is synchronous. Both protocols return a ready ID. Neither
  // exposes a parse status, extracted byte count or page count in a file object.
  if (!uploaded || typeof uploaded !== 'object' || !('id' in uploaded) ||
      typeof uploaded.id !== 'string' || !uploaded.id.trim()) {
    throw new ApiError('protocol', { key: 'uploadMissingId' })
  }
  return { id: uploaded.id }
}

export const deleteFile = async (access: ChatAccess, fileId: string): Promise<void> => {
  const { url, headers } = filesEndpoint(access)
  await request(`${url}/${encodeURIComponent(fileId)}`, { method: 'DELETE', headers }, access)
}

const hasFile = (body: CreateMessageRequest) =>
  body.messages.some(
    (message) =>
      typeof message.content !== 'string' &&
      message.content.some((block) => block.type === 'image' || block.type === 'document')
  )

/** OpenCode Go/Zen session header, scoped to their exact official endpoints. */
const OPENCODE_SESSION = (() => {
  try {
    return crypto.randomUUID()
  } catch {
    return `chat-${Date.now().toString(36)}`
  }
})()

type ChatPart = { type: 'text'; text: string } | { type: 'file'; file_id: string } |
  { type: 'file'; file: { file_id: string } }

const toOpenAiMessages = (body: CreateMessageRequest, origin: string, model: string) => {
  const deepseek = officialFiles(origin)
  const messages: { role: 'developer' | 'system' | 'user' | 'assistant'; content: string | ChatPart[] }[] = []
  if (body.system) {
    const developer = isOpenAiOrigin(origin) && /^(?:gpt-[56](?:[.-]|$)|o[134](?:-|$))/u.test(model)
    messages.push({ role: developer ? 'developer' : 'system', content: body.system })
  }
  for (const message of body.messages) {
    if (message.role === 'latest_reminder') {
      continue
    }
    if (message.role === 'user' && Array.isArray(message.content)) {
      const content = message.content.map((block): ChatPart => {
        if (block.type === 'text') {return { type: 'text', text: block.text }}
        const file_id = block.source.file_id
        return deepseek ? { type: 'file', file_id } : { type: 'file', file: { file_id } }
      })
      if (content.length > 0) {messages.push({ role: 'user', content })}
      continue
    }
    const text =
      typeof message.content === 'string'
        ? message.content
        : message.content
            .map((block) => (block.type === 'text' ? block.text : ''))
            .filter(Boolean)
            .join('\n')
    const reads = isDeepSeekApiOrigin(origin) && message.role === 'assistant' && Array.isArray(message.content)
      ? signedChatReads(message.content) : {}
    if (text.trim() || 'server_tool_calls' in reads) {
      messages.push({ role: message.role, content: text, ...reads })
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
  access: Extract<ChatAccess, { source: 'api' }>,
  body: CreateMessageRequest,
  signal: AbortSignal,
  onDispatch?: () => void
): AsyncGenerator<MessageStreamEvent> {
  const { origin, model } = access.config
  const wire = reasoningWire(access.config)
  const enabled = body.thinking && body.thinking.type === 'enabled'
  signal.throwIfAborted()
  onDispatch?.()
  const official = isOpenAiOrigin(origin)
  const search = official && supportsOpenAiSearch(model) && !!access.searchGrant?.startsWith('openai:') && body.tools?.some(tool => tool.type === 'deepseek_web_search')
  if (official && (usesOpenAiResponses(model) || search)) {
    const payload = responsesPayload(model, body, search)
    const response = await request(`${origin}/responses`, {
      method: 'POST', headers: { Authorization: `Bearer ${access.key}`, 'Content-Type': 'application/json', Accept: payload.stream ? 'text/event-stream' : 'application/json' },
      body: JSON.stringify(payload), signal,
    }, access)
    yield* openAiResponseEvents(response, model, signal, !!enabled, ApiError)
    return
  }
  const response = await request(`${origin}/chat/completions`, {
    method: 'POST',
    headers: {
      ...(access.key && { Authorization: `Bearer ${access.key}` }),
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...(['https://opencode.ai/inference/openai/v1', 'https://opencode.ai/inference/go/openai/v1', 'https://opencode.ai/zen/v1'].includes(origin) && { 'x-opencode-session': OPENCODE_SESSION }),
    },
    body: JSON.stringify({
      model,
      messages: toOpenAiMessages(body, origin, model),
      ...reasoningFields(wire, enabled),
      ...chatSearchFields(origin, model, body.tools, access.searchGrant),
      stream_options: { include_usage: true },
      ...(body.max_tokens !== undefined && { [official ? 'max_completion_tokens' : 'max_tokens']: body.max_tokens }),
      stream: true,
    }),
    signal,
  }, access)
  const contentType = response.headers.get('Content-Type') ?? ''
  if (!response.body || !contentType.includes('text/event-stream')) {
    throw await readErrorResponse(response, 'protocol', '')
  }

  yield {
    type: 'message_start',
    message: { id: `openai-${Date.now().toString(36)}`, model },
  }
  let kind: 'thinking' | 'text' | undefined
  let index = -1
  const seenSources = new Set<string>()
  const citations: ReturnType<typeof readChatCitations> = []
  const tools = isDeepSeekApiOrigin(origin) && body.tools?.length ? new DeepSeekChatTools() : undefined
  let done = false
  let refused = false
  let stopReason: StopReason | undefined
  let usage: ReturnType<typeof completionUsage>
  const append = function* (next: 'thinking' | 'text', text: string): Generator<MessageStreamEvent> {
    if (!text || (next === 'thinking' && kind !== next && !text.trim())) return
    if (kind !== next) {
      if (kind) yield { type: 'content_block_stop', index }
      kind = next
      index++
      yield { type: 'content_block_start', index, content_block: kind === 'text'
        ? { type: 'text', text: '' } : { type: 'thinking', thinking: '', signature: '' } }
    }
    yield { type: 'content_block_delta', index, delta: next === 'text'
      ? { type: 'text_delta', text } : { type: 'thinking_delta', thinking: text } }
  }
  for await (const { event, data } of readServerSentEvents(response.body, signal)) {
    signal.throwIfAborted()
    if (data.trim() === '[DONE]') {
      done = true
      break
    }
    let chunk
    try { chunk = JSON.parse(data) } catch { throw new ApiError(event === 'error' ? 'stream' : 'protocol', event === 'error' ? data : '') }
    if (isErrorBody(chunk)) throw new ApiError('stream', chunk.error.message)
    if (event === 'error' || chunk?.error) throw new ApiError('stream', typeof chunk?.error === 'string' ? chunk.error : '')
    if (!chunk || typeof chunk !== 'object') throw new ApiError('protocol', '')
    const counters = completionUsage(chunk.usage)
    if (counters) {
      usage = mergeCompletionUsage(usage, counters)
      yield { type: 'message_usage', usage }
    }
    const choice = chunk.choices?.[0]
    if (!choice) continue
    if (enabled && !official) yield* append('thinking', reasoningText(choice.delta))
    const { content, refusal } = choice.delta ?? {}
    if (typeof content === 'string') yield* append('text', content)
    if (Array.isArray(content)) {
      for (const part of content) if (part?.type === 'text' && typeof part.text === 'string') yield* append('text', part.text)
    }
    if (typeof refusal === 'string' && refusal) {
      refused = true
      if (!content) yield* append('text', refusal)
    }
    citations.push(...readChatCitations(chunk, seenSources))
    if (kind === 'text') {
      for (const citation of citations.splice(0)) {
        yield { type: 'content_block_delta', index, delta: { type: 'citations_delta', citation } }
      }
    }
    if (tools) {
      for (const content_block of tools.read(chunk)) {
        if (kind) yield { type: 'content_block_stop', index }
        kind = undefined
        index++
        yield { type: 'content_block_start', index, content_block }
        yield { type: 'content_block_stop', index }
      }
    }
    const reason = completionStop(choice.finish_reason)
    if (reason === 'interrupted') throw new ApiError('interrupted', '')
    stopReason = reason ?? stopReason
  }
  signal.throwIfAborted()
  if (!done && !stopReason) throw new ApiError('interrupted', '')
  if (kind) { yield { type: 'content_block_stop', index } }
  if (citations.length) {
    index++
    yield { type: 'content_block_start', index, content_block: { type: 'text', text: '', citations } }
    yield { type: 'content_block_stop', index }
  }
  yield { type: 'message_delta', delta: { stop_reason: refused ? 'refusal' : stopReason ?? 'end_turn', stop_sequence: null }, ...(usage && { usage }) }
  yield { type: 'message_stop' }
}

/**
 * POST /anthropic/v1/messages（stream: true），逐个产出流式事件，收到 message_stop 时结束。
 * 当前配置是 OpenAI 兼容服务商时改走 /chat/completions，事件格式保持一致。
 * ping、保活注释与无法解析的内容不产出；中止请求时抛出 signal 的 AbortError。
 */
export async function* streamMessage(
  access: ChatAccess,
  body: CreateMessageRequest,
  signal: AbortSignal,
  onDispatch?: () => void,
  purpose: UsagePurpose = 'chat'
): AsyncGenerator<MessageStreamEvent> {
  let receipt: ReturnType<typeof beginUsage> | undefined
  let status: UsageStatus = 'interrupted'
  const dispatched = () => {
    const model = access.source === 'api' ? access.config.model : access.model || body.model
    receipt ??= beginUsage(access, model, purpose)
    onDispatch?.()
  }
  try {
    for await (const event of dispatchMessage(access, body, signal, dispatched)) {
      if (event.type === 'message_start') receipt?.sample(event.message.usage)
      else if ('usage' in event) receipt?.sample(event.usage)
      if (event.type === 'message_stop') status = 'done'
      yield event
    }
  } catch (error) {
    status = error instanceof ApiError && error.kind === 'interrupted' ? 'interrupted' : 'failed'
    throw error
  } finally {
    receipt?.close(signal.aborted ? 'stopped' : status)
  }
}

async function* dispatchMessage(
  access: ChatAccess,
  body: CreateMessageRequest,
  signal: AbortSignal,
  onDispatch?: () => void
): AsyncGenerator<MessageStreamEvent> {
  if (access.source === 'workbuddy') {
    yield* streamWorkBuddy(access, body, signal, onDispatch)
    return
  }
  signal.throwIfAborted()
  const claude = officialClaude(access) && access.source === 'api' ? access : undefined
  if (access.source === 'api' && access.config.protocol === 'anthropic' && !claude) throw new ApiError('protocol', 'Select the official Claude API endpoint.')
  const referencesFiles = hasFile(body)
  if (referencesFiles) {
    // Validate the same model the selected wire actually sends. Native Messages uses body.model.
    checkFileModel(access, claude ? claude.config.model : isOpenAi(access) ? access.config.model : body.model)
  }
  if (isPortableGrant(access.searchGrant) && body.tools?.some(tool => tool.type === 'deepseek_web_search')) {
    const { streamPortableSearch } = await import('./portableSearch.js')
    yield* streamPortableSearch(access, body, signal, onDispatch, dispatchMessage)
    return
  }
  if (!claude && isOpenAi(access)) {
    yield* streamOpenAiChat(access, body, signal, onDispatch)
    return
  }
  onDispatch?.()
  const response = await request(`${anthropicBaseUrl(access)}/messages`, {
    method: 'POST',
    headers: {
      ...anthropicHeaders(access, referencesFiles),
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(claude ? claudeRequest(body, claude.config.model, claude.searchGrant, claude.config.reasoningSupport) : { ...body, stream: true }),
    signal,
  }, access)
  const contentType = response.headers.get('Content-Type') ?? ''
  if (!response.body || !contentType.includes('text/event-stream')) {
    throw await readErrorResponse(response, 'protocol', '')
  }
  const thinkingEvents = new ThinkingEvents(body.thinking?.type === 'enabled')
  const claudeEvents = claude && new ClaudeStream()
  for await (const { event: eventName, data } of readServerSentEvents(response.body, signal)) {
    signal.throwIfAborted()
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
    try {
      const events = claudeEvents ? claudeEvents.read(payload) : [readMessageEvent(payload)]
      for (const event of events) {
        if (!event) continue
        yield* thinkingEvents.read(event)
        if (event.type === 'message_stop') return
      }
    } catch (error) {
      throw new ApiError('protocol', error instanceof Error ? error.message : String(error))
    }
  }
  signal.throwIfAborted()
  // 服务端没有提供错误内容时保持为空，不推测断流原因。
  throw new ApiError('interrupted', '')
}
