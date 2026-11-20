import { createId } from '../../utils/id.js'
import type { WorkBuddyModel } from './models.js'

type Frame = {
  id: string
  type: string
  data?: string
  status?: number
  contentType?: string
  model?: unknown
  revision?: unknown
  catalog?: unknown
  catalogRefresh?: boolean
  code?: string
  name?: string
  pending?: boolean
}
type Port = { postMessage(text: string): void; onmessage?: (event: MessageEvent<string>) => void }
const port =
  typeof window === 'undefined'
    ? undefined
    : (window as Window & { WorkBuddyChat?: Port }).WorkBuddyChat
export const hasWorkBuddyBridge = Boolean(port)
const pending = new Map<string, (frame: Frame) => void>()
if (port) {
  port.onmessage = ({ data }) => {
    const frame: Frame = JSON.parse(data)
    pending.get(frame.id)?.(frame)
  }
}
function post(message: object) {
  if (!port) {
    throw new Error('WorkBuddy · Android WebView unavailable')
  }
  port.postMessage(JSON.stringify(message))
}
export async function manageWorkBuddy(
  op: 'status' | 'begin' | 'poll' | 'cancelLogin' | 'model' | 'catalog' | 'forget',
  fields: object = {}
): Promise<Frame> {
  const id = createId()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('WorkBuddy · timeout'))
    }, 45000)
    const done = () => {
      clearTimeout(timer)
      pending.delete(id)
    }
    pending.set(id, (frame) => {
      done()
      if (frame.type === 'error') {
        reject(new Error(`WorkBuddy · ${frame.code || 'storage'}`))
      } else {
        resolve(frame)
      }
    })
    try {
      post({ ...fields, op, id })
    } catch (error) {
      done()
      reject(error)
    }
  })
}
export function workBuddyFetch(
  model: WorkBuddyModel,
  revision: string,
  operation:
    | {
        op: 'chat'
        messages: { role: string; content: string }[]
        thinking: boolean
        purpose?: 'search_plan'
        max_tokens?: number
      }
    | { op: 'search'; query: string }
    | { op: 'read'; readKey: string },
  signal: AbortSignal
): Promise<Response> {
  const id = createId()
  return new Promise((resolve, reject) => {
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined
    let timer: ReturnType<typeof setTimeout>
    function finish() {
      clearTimeout(timer)
      pending.delete(id)
      signal.removeEventListener('abort', abort)
    }
    function stop(error: Error) {
      finish()
      if (stream) {
        stream.error(error)
      } else {
        reject(error)
      }
    }
    function cancel() {
      try {
        post({ op: 'cancel', id })
      } finally {
        finish()
      }
    }
    function abort() {
      cancel()
      stop(new DOMException('Aborted', 'AbortError'))
    }
    function watchdog() {
      clearTimeout(timer)
      timer = setTimeout(() => {
        cancel()
        stop(new Error('WorkBuddy · timeout'))
      }, 140000)
    }
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    signal.addEventListener('abort', abort, { once: true })
    watchdog()
    pending.set(id, (frame) => {
      watchdog()
      if (frame.type === 'error') {
        stop(new Error(`WorkBuddy · ${frame.code || 'transport'}`))
        return
      }
      if (frame.type === 'headers') {
        if (frame.status === 204 || frame.status === 205 || frame.status === 304) {
          finish()
          resolve(new Response(null, { status: frame.status }))
          return
        }
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller
          },
          cancel,
        })
        resolve(
          new Response(body, {
            status: frame.status,
            headers: { 'Content-Type': frame.contentType || '' },
          })
        )
      } else if (frame.type === 'data' && stream && frame.data) {
        stream.enqueue(Uint8Array.from(atob(frame.data), (c) => c.charCodeAt(0)))
      } else if (frame.type === 'end') {
        finish()
        if (stream) {
          stream.close()
        } else {
          reject(new Error('WorkBuddy · empty response'))
        }
      }
    })
    try {
      if (operation.op === 'read') {
        post({ op: 'read', readKey: operation.readKey, id, model, revision })
      } else {
        post({ ...operation, id, model, revision })
      }
    } catch (error) {
      finish()
      reject(error)
    }
  })
}
