import { getChatAccess, type ChatAccess } from '../services/api/access.js'
import { useSettings } from '../services/settings.js'
import { useConversationModes } from '../services/conversationMode/storage.js'

type Port = { postMessage(value: string): void; onmessage?: (event: MessageEvent<string>) => void }
type Profile = Extract<ChatAccess, { source: 'api' }>
type Frame = {
  id: string
  type: string
  offset?: number
  length?: number
  status?: number
  contentType?: string
  data?: string
  message?: string
}
const port =
  typeof window === 'undefined'
    ? undefined
    : (window as Window & { DeepChatProfile?: Port }).DeepChatProfile
const pending = new Map<string, (frame: Frame) => void>()
const CHUNK = 48 * 1024
let sequence = 0
if (port) {
  port.onmessage = ({ data }) => {
    const frame: Frame = JSON.parse(data)
    pending.get(frame.id)?.(frame)
  }
}

function chatOperation(url: string, access: Profile) {
  const origin = access.config.origin.replace(/\/+$/, '')
  const claude =
    ['https://api.anthropic.com', 'https://api.anthropic.com/v1'].includes(origin) &&
    access.config.protocol !== 'deepseek'
  if (
    url === `${claude ? 'https://api.anthropic.com/v1' : `${origin}/anthropic/v1`}/messages` &&
    (claude || access.config.protocol === 'deepseek')
  ) {
    return 'messages'
  }
  if (access.config.protocol !== 'openai' || claude) {
    return undefined
  }
  if (url === `${origin}/chat/completions`) {
    return 'chat'
  }
  if (origin === 'https://api.openai.com/v1' && url === `${origin}/responses`) {
    return 'responses'
  }
  return undefined
}

/** Undefined means this request belongs to the existing web transport. A native failure never resends it. */
export function profileChatFetch(access: ChatAccess | undefined, url: string, init: RequestInit) {
  if (!port || access?.source !== 'api' || !url.startsWith('https://') || init.method !== 'POST') {
    return undefined
  }
  const operation = chatOperation(url, access)
  if (!operation) {
    return undefined
  }
  return transfer(access, operation, init, port)
}

async function transfer(
  access: Profile,
  operation: string,
  init: RequestInit,
  bridge: Port
): Promise<Response> {
  const valid = () => {
    const selected = getChatAccess(access.sessionId)
    return (
      access.profileId &&
      selected?.source === 'api' &&
      selected.profileId === access.profileId &&
      selected.key === access.key &&
      selected.config.origin === access.config.origin &&
      selected.config.protocol === access.config.protocol &&
      selected.config.model === access.config.model
    )
  }
  const changed = () => new Error('Chat profile changed / 会话方案或凭据已变更')
  if (!valid()) {
    throw changed()
  }
  if (typeof init.body !== 'string') {
    throw new Error('Invalid chat body / 消息格式无效')
  }
  init.signal?.throwIfAborted()
  const body = new Blob([init.body])
  if (!body.size || body.size > 64 * 1024 * 1024) {
    throw new Error('Chat exceeds 64 MiB / 聊天请求超过 64 MiB')
  }
  const digest = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(access.key))),
    (b) => b.toString(16).padStart(2, '0')
  ).join('')
  init.signal?.throwIfAborted()
  if (!valid()) {
    throw changed()
  }
  const headers = new Headers(init.headers)
  const id = String(++sequence)
  const post = (fields: object) => bridge.postMessage(JSON.stringify({ id, ...fields }))
  return new Promise<Response>((resolve, reject) => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    let offset = 0
    let done = false
    let timer: ReturnType<typeof setTimeout>
    const clean = () => {
      done = true
      pending.delete(id)
      clearTimeout(timer)
      init.signal?.removeEventListener('abort', abort)
      window.removeEventListener('pagehide', abort)
      settings()
      modes()
    }
    const fail = (e: Error) => {
      if (done) {
        return
      }
      clean()
      try {
        post({ op: 'cancel' })
      } catch {
        /* Document was detached. */
      }
      controller?.error(e)
      reject(e)
    }
    const abort = () => fail(new DOMException('Cancelled', 'AbortError'))
    const check = () => {
      if (!valid()) {
        fail(changed())
      }
    }
    const settings = useSettings.subscribe(check),
      modes = useConversationModes.subscribe(check)
    const progress = () => {
      clearTimeout(timer)
      timer = setTimeout(() => fail(new Error('Profile chat timed out / 连接超时')), 180_000)
    }
    init.signal?.addEventListener('abort', abort, { once: true })
    window.addEventListener('pagehide', abort)
    pending.set(id, (frame) => {
      try {
        progress()
        if (
          frame.type === 'pull' &&
          !controller &&
          frame.offset === offset &&
          frame.length === Math.min(CHUNK, body.size - offset) &&
          frame.length > 0
        ) {
          const start = offset
          offset += frame.length
          void body
            .slice(start, offset)
            .arrayBuffer()
            .then((chunk) => {
              if (!done) {
                post({
                  op: 'chunk',
                  offset: start,
                  data: btoa(String.fromCharCode(...new Uint8Array(chunk))),
                })
              }
            })
            .catch(() => fail(new Error('Chat upload interrupted / 消息发送中断')))
        } else if (
          frame.type === 'headers' &&
          !controller &&
          frame.status &&
          frame.status >= 200 &&
          frame.status <= 599
        ) {
          const status = frame.status
          const noBody = status === 204 || status === 205 || status === 304
          const stream = new ReadableStream<Uint8Array>({
            start(c) {
              controller = c
            },
            cancel: abort,
          })
          resolve(
            new Response(noBody ? null : stream, {
              status,
              statusText: `HTTP ${status}`,
              headers: { 'Content-Type': frame.contentType ?? '' },
            })
          )
        } else if (
          frame.type === 'data' &&
          controller &&
          typeof frame.data === 'string' &&
          frame.data.length <= 65536
        ) {
          controller.enqueue(Uint8Array.from(atob(frame.data), (c) => c.charCodeAt(0)))
        } else if (frame.type === 'end' && controller) {
          clean()
          controller.close()
        } else if (frame.type === 'error') {
          fail(new Error(frame.message || 'Chat interrupted / 聊天连接中断'))
        } else {
          fail(new Error('Invalid native chat response / 原生响应无效'))
        }
      } catch {
        fail(new Error('Invalid native chat response / 原生响应无效'))
      }
    })
    progress()
    try {
      post({
        op: 'start',
        operation,
        profileId: access.profileId,
        origin: access.config.origin,
        protocol: access.config.protocol,
        digest,
        length: body.size,
        json: headers.get('Accept') === 'application/json',
        beta: headers.get('anthropic-beta') === 'files-api-2025-04-14',
        openCodeSession: headers.get('x-opencode-session') || '',
      })
    } catch {
      fail(new Error('Native chat unavailable / 无法发送原生请求'))
    }
  })
}
