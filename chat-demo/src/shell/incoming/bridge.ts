import { createId } from '../../utils/id.js'

type Frame = { request: string; value?: unknown; error?: boolean }
export type IncomingPort = {
  postMessage(data: string): void
  onmessage: ((event: MessageEvent<string>) => void) | null
}

export class UnreadableShare extends Error {}

/** One request at a time. Relocking aborts the pending read and ignores any late frame. */
export function incomingCall<T>(port: IncomingPort, body: object, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('Inactive'))
      return
    }
    const request = createId()
    const finish = () => {
      window.clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      if (port.onmessage === receive) {
        port.onmessage = null
      }
    }
    const abort = () => {
      finish()
      reject(new Error('Inactive'))
    }
    const receive = (event: MessageEvent<string>) => {
      let frame: Frame
      try {
        frame = JSON.parse(event.data) as Frame
      } catch {
        return
      }
      if (frame.request !== request) {
        return
      }
      finish()
      if (frame.error) {
        reject(new UnreadableShare())
      } else {
        resolve(frame.value as T)
      }
    }
    const timer = window.setTimeout(abort, 30_000)
    port.onmessage = receive
    signal.addEventListener('abort', abort, { once: true })
    try {
      port.postMessage(JSON.stringify({ ...body, request }))
    } catch (error) {
      finish()
      reject(error)
    }
  })
}

export async function readIncoming(port: IncomingPort, id: string, signal: AbortSignal) {
  const { text, images } = await incomingCall<{
    text: string
    images: { name: string; type: string }[]
  }>(port, { op: 'describe', id }, signal)
  if (
    typeof text !== 'string' ||
    text.length > 128 * 1024 ||
    !Array.isArray(images) ||
    images.length > 1
  ) {
    throw new UnreadableShare()
  }
  const image = images[0]
  if (!image) {
    if (!text.trim()) {
      throw new UnreadableShare()
    }
    return { text }
  }
  if (typeof image.name !== 'string' || !image.type?.startsWith('image/')) {
    throw new UnreadableShare()
  }
  const parts: ArrayBuffer[] = []
  let offset = 0
  for (;;) {
    const chunk = await incomingCall<{ data: string; done: boolean }>(
      port,
      { op: 'read', id, index: 0, offset },
      signal
    )
    if (typeof chunk.data !== 'string' || chunk.data.length > 180_000) {
      throw new UnreadableShare()
    }
    const binary = atob(chunk.data)
    if ((!binary.length && !chunk.done) || offset + binary.length > 64 * 1024 * 1024) {
      throw new UnreadableShare()
    }
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i)
    }
    parts.push(bytes.buffer)
    offset += bytes.length
    if (chunk.done) {
      break
    }
  }
  if (!offset) {
    throw new UnreadableShare()
  }
  return { text, file: new File(parts, image.name, { type: image.type }) }
}
