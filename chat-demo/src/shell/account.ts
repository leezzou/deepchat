type Frame = {
  type: string
  id?: string
  signedIn?: boolean
  name?: string
  avatar?: string
  status?: number
  contentType?: string
  base64?: string
  message?: string
  offset?: number
  length?: number
}
export type AccountProfile = { signedIn: boolean; name: string; avatar: string | null }
type Port = {
  postMessage: (value: string) => void
  onmessage: ((value: MessageEvent<string>) => void) | null
}
const port =
  typeof window !== 'undefined' ? (window as Window & { DshNative?: Port }).DshNative : undefined
export const hasAccountBridge = !!port
const requests = new Map<string, (frame: Frame) => void>()
const post = (value: object) => {
  if (!port) {
    throw new Error('请更新 Android System WebView 后重新打开应用。')
  }
  port.postMessage(JSON.stringify(value))
}
export function openAccount() {
  post({ op: 'account' })
}
export function returnToAccount() {
  post({ op: 'account', fromUsage: true })
}
export function initializeAccount(onStatus: (profile: AccountProfile) => void) {
  if (!port) {
    return
  }
  port.onmessage = ({ data }) => {
    const frame = JSON.parse(data) as Frame
    if (frame.type === 'account') {
      if (typeof frame.signedIn === 'boolean') {
        onStatus({
          signedIn: frame.signedIn,
          name: typeof frame.name === 'string' ? frame.name : '',
          avatar: typeof frame.avatar === 'string' && frame.avatar ? frame.avatar : null,
        })
      }
    } else if (frame.id) {
      requests.get(frame.id)?.(frame)
    }
  }
  post({ op: 'status' })
}
// Keep the file as a Blob part (including Android picker-backed files). Only framing text
// is copied here. Request.blob() would first consume the entire FormData byte stream.
function multipartUpload(form: FormData) {
  const boundary = `DeepChat-${crypto.randomUUID()}`
  const parts: BlobPart[] = []
  const quote = (s: string) => s.replace(/\r/g, '%0D').replace(/\n/g, '%0A').replace(/"/g, '%22')
  for (const [name, value] of form) {
    const field = `--${boundary}\r\nContent-Disposition: form-data; name="${quote(name)}"`
    if (typeof value === 'string') {
      parts.push(`${field}\r\n\r\n`, value.replace(/\r\n|\r|\n/g, '\r\n'), '\r\n')
    } else {
      parts.push(
        `${field}; filename="${quote(value.name)}"\r\nContent-Type: ${value.type || 'application/octet-stream'}\r\n\r\n`,
        value,
        '\r\n'
      )
    }
  }
  parts.push(`--${boundary}--\r\n`)
  return { body: new Blob(parts), contentType: `multipart/form-data; boundary=${boundary}` }
}

function body64(body: Blob, signal?: AbortSignal | null): Promise<string> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted()
    const reader = new FileReader()
    const abort = () => reader.abort()
    signal?.addEventListener('abort', abort, { once: true })
    reader.onloadend = () => signal?.removeEventListener('abort', abort)
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1] ?? '')
    reader.onabort = () => reject(new DOMException('已停止', 'AbortError'))
    reader.onerror = () => reject(new Error('无法读取请求内容。'))
    reader.readAsDataURL(body)
  })
}
export async function accountFetch(url: string, init: RequestInit): Promise<Response> {
  const dest = new URL(url)
  if (
    dest.origin !== 'https://api.deepseek.com' ||
    dest.username ||
    dest.password ||
    dest.search ||
    dest.hash
  ) {
    throw new Error('当前账户不支持此地址。')
  }
  const signal = init.signal
  signal?.throwIfAborted()
  const id = crypto.randomUUID()
  const method = (init.method ?? 'GET').toUpperCase()
  const path = dest.pathname
  let upload: ReturnType<typeof multipartUpload> | undefined
  let start: object
  if (method === 'POST' && path === '/anthropic/v1/files') {
    if (!(init.body instanceof FormData)) {
      throw new Error('文件请求需要使用 multipart/form-data。')
    }
    upload = multipartUpload(init.body)
    start = {
      op: 'upload',
      id,
      method,
      path,
      contentType: upload.contentType,
      length: upload.body.size,
    }
  } else {
    const request = new Request(url, init)
    const blob = init.body != null ? await request.blob() : null
    // ASR is the largest remaining inline route. All its legal requests fit in a bridge message.
    if (blob && blob.size > 8 * 1024 * 1024 + 8192) {
      throw new Error('请求超过本机传输大小限制。')
    }
    const body = blob ? await body64(blob, signal) : ''
    start = {
      op: 'request',
      id,
      method,
      path,
      contentType: request.headers.get('content-type') || '',
      body,
    }
    signal?.throwIfAborted()
  }
  return new Promise<Response>((resolve, reject) => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    const reading = new AbortController()
    const clean = () => {
      requests.delete(id)
      signal?.removeEventListener('abort', abort)
      reading.abort()
    }
    const cancel = () => {
      clean()
      post({ op: 'cancel', id })
    }
    const fail = (reason: unknown) => {
      clean()
      reject(reason)
      controller?.error(reason)
    }
    const abort = () => {
      try {
        cancel()
      } finally {
        fail(new DOMException('已停止', 'AbortError'))
      }
    }
    let nextOffset = 0
    let busy = false
    const sendChunk = async ({ offset, length }: Frame) => {
      if (
        !upload ||
        busy ||
        offset !== nextOffset ||
        !length ||
        !Number.isSafeInteger(length) ||
        length < 1 ||
        length > 96 * 1024 ||
        offset + length > upload.body.size
      ) {
        throw new Error('文件传输状态无效。')
      }
      busy = true
      const body = await body64(upload.body.slice(offset, offset + length), reading.signal)
      if (reading.signal.aborted) {
        return
      }
      busy = false
      nextOffset += length
      post({ op: 'chunk', id, offset, body })
    }
    signal?.addEventListener('abort', abort, { once: true })
    requests.set(id, (frame) => {
      try {
        if (frame.type === 'pull') {
          void sendChunk(frame).catch((error: unknown) => {
            if (!requests.has(id)) {
              return
            }
            try {
              cancel()
            } finally {
              fail(error)
            }
          })
        } else if (frame.type === 'headers') {
          reading.abort()
          const status = frame.status ?? 502
          const stream =
            status === 204 || status === 205
              ? null
              : new ReadableStream<Uint8Array>({
                  start(c) {
                    controller = c
                  },
                  cancel,
                })
          resolve(
            new Response(stream, {
              status,
              headers: { 'Content-Type': frame.contentType || 'application/octet-stream' },
            })
          )
        } else if (frame.type === 'data') {
          const decoded = atob(frame.base64 || '')
          controller?.enqueue(Uint8Array.from(decoded, (c) => c.charCodeAt(0)))
        } else if (frame.type === 'end') {
          clean()
          controller?.close()
        } else if (frame.type === 'error') {
          fail(new Error(frame.message || '网络请求中断。'))
        }
      } catch (error) {
        fail(error)
      }
    })
    try {
      post(start)
    } catch (error) {
      fail(error)
    }
  })
}
