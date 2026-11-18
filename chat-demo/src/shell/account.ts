type Frame = { type: string; id?: string; signedIn?: boolean; name?: string; avatar?: string; status?: number; contentType?: string; base64?: string; message?: string }
export type AccountProfile = { signedIn: boolean; name: string; avatar: string | null }
type Port = { postMessage: (value: string) => void; onmessage: ((value: MessageEvent<string>) => void) | null }
const port = typeof window !== 'undefined' ? (window as Window & { DshNative?: Port }).DshNative : undefined
export const hasAccountBridge = !!port
const requests = new Map<string, (frame: Frame) => void>()
const post = (value: object) => {
  if (!port) throw new Error('请更新 Android System WebView 后重新打开应用。')
  port.postMessage(JSON.stringify(value))
}
export function openAccount() {
  post({ op: 'account' })
}
export function initializeAccount(onStatus: (profile: AccountProfile) => void) {
  if (!port) return
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
    } else if (frame.id) requests.get(frame.id)?.(frame)
  }
  post({ op: 'status' })
}
async function body64(body: Blob): Promise<string> {
  if (body.size > 40 * 1024 * 1024) throw new Error('账号模式的请求大小上限为 40 MB。')
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1] ?? '')
    reader.onerror = () => reject(new Error('无法读取请求内容。'))
    reader.readAsDataURL(body)
  })
}
export async function accountFetch(url: string, init: RequestInit): Promise<Response> {
  const dest = new URL(url)
  if (dest.origin !== 'https://api.deepseek.com' || dest.username || dest.password || dest.search || dest.hash) throw new Error('当前账户不支持此地址。')
  const request = new Request(url, init)
  const method = request.method
  const contentType = request.headers.get('content-type') || ''
  const body = init.body != null ? await body64(await request.blob()) : ''
  const id = crypto.randomUUID()
  const signal = init.signal
  signal?.throwIfAborted()
  return new Promise<Response>((resolve, reject) => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    const clean = () => { requests.delete(id); signal?.removeEventListener('abort', abort) }
    const cancel = () => { clean(); post({ op: 'cancel', id }) }
    const fail = (reason: unknown) => { clean(); reject(reason); controller?.error(reason) }
    const abort = () => { cancel(); fail(new DOMException('已停止', 'AbortError')) }
    signal?.addEventListener('abort', abort, { once: true })
    requests.set(id, (frame) => {
      try {
        if (frame.type === 'headers') {
          const status = frame.status ?? 502
          const stream = status === 204 || status === 205 ? null : new ReadableStream<Uint8Array>({ start(c) { controller = c }, cancel })
          resolve(new Response(stream, { status, headers: { 'Content-Type': frame.contentType || 'application/octet-stream' } }))
        } else if (frame.type === 'data') {
          const decoded = atob(frame.base64 || '')
          controller?.enqueue(Uint8Array.from(decoded, c => c.charCodeAt(0)))
        } else if (frame.type === 'end') { clean(); controller?.close() }
        else if (frame.type === 'error') fail(new Error(frame.message || '网络请求中断。'))
      } catch (error) { fail(error) }
    })
    try { post({ op: 'request', id, method, path: dest.pathname, contentType, body }) }
    catch (error) { fail(error) }
  })
}
