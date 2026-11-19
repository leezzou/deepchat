import { Capacitor, registerPlugin } from '@capacitor/core'
import { Directory, Filesystem } from '@capacitor/filesystem'
import { MAX_PORTABLE_BYTES, PortableError } from './portableCrypto.js'

export const remoteName = 'deepchat-backup.dcb'
export type DavAccount = { folder: string; username: string; password: string }
type Method = 'GET' | 'PUT' | 'DELETE'
type Request = {
  url: string
  method: Method
  authorization: string
  cacheFile: string
  probe: boolean
}
const native = registerPlugin<{ transfer(options: Request): Promise<{ status: number }> }>('WebDav')

function encode(bytes: Uint8Array) {
  let text = ''
  for (let i = 0; i < bytes.length; i += 8192) {
    text += String.fromCharCode(...bytes.subarray(i, i + 8192))
  }
  return btoa(text)
}
function options(account: DavAccount, name: string) {
  let folder: URL
  try {
    folder = new URL(account.folder.trim())
  } catch {
    throw new PortableError('address')
  }
  if (
    folder.protocol !== 'https:' ||
    folder.username ||
    folder.password ||
    folder.search ||
    folder.hash
  ) {
    throw new PortableError('address')
  }
  if (account.username.includes(':') || (!account.username && account.password)) {
    throw new PortableError('credentials')
  }
  folder.pathname = folder.pathname.replace(/\/?$/, '/') + name
  const authorization = account.username
    ? 'Basic ' + encode(new TextEncoder().encode(`${account.username}:${account.password}`))
    : ''
  return { url: folder.href, authorization }
}
function checkStatus(status: number) {
  if ([200, 201, 204].includes(status)) {
    return
  }
  if ([401, 403].includes(status)) {
    throw new PortableError('credentials')
  }
  if (status === 404) {
    throw new PortableError('missing')
  }
  if (status === 413) {
    throw new PortableError('large')
  }
  throw new PortableError('server')
}
async function readBounded(response: Response) {
  if (Number(response.headers.get('content-length')) > MAX_PORTABLE_BYTES) {
    throw new PortableError('large')
  }
  const stream = response.body?.getReader()
  if (!stream) {
    throw new PortableError('network')
  }
  const parts: ArrayBuffer[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await stream.read()
      if (done) {
        break
      }
      size += value.byteLength
      if (size > MAX_PORTABLE_BYTES) {
        throw new PortableError('large')
      }
      parts.push(new Uint8Array(value).buffer)
    }
    return new Blob(parts)
  } finally {
    await stream.cancel().catch(() => {})
  }
}
async function transfer(account: DavAccount, method: Method, name: string, body?: Blob) {
  const { url, authorization } = options(account, name)
  const probe = name !== remoteName
  if (body && body.size > MAX_PORTABLE_BYTES) {
    throw new PortableError('large')
  }
  try {
    if (Capacitor.getPlatform() === 'android') {
      // Only encrypted payloads or random probe bytes go to the OS cache. Never put
      // a whole archive on the JS bridge: Chromium and JNI copy each JSON string.
      const cacheFile = `deepchat-dav-${crypto.randomUUID()}.tmp`
      const file = { directory: Directory.Cache, path: cacheFile }
      try {
        if (body) {
          for (let i = 0; i < body.size; i += 256 * 1024) {
            const data = encode(new Uint8Array(await body.slice(i, i + 256 * 1024).arrayBuffer()))
            if (!i) {
              await Filesystem.writeFile({ ...file, data })
            } else {
              await Filesystem.appendFile({ ...file, data })
            }
          }
        }
        const result = await native.transfer({ url, authorization, cacheFile, method, probe })
        checkStatus(result.status)
        if (method !== 'GET') {
          return new Blob()
        }
        const { uri } = await Filesystem.getUri(file)
        const response = await fetch(Capacitor.convertFileSrc(uri), { cache: 'no-store' })
        if (!response.ok) {
          throw new PortableError('network')
        }
        return await readBounded(response)
      } finally {
        if (method !== 'DELETE') {
          await Filesystem.deleteFile(file).catch(() => {})
        }
      }
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 120_000)
    try {
      const response = await fetch(url, {
        method,
        body,
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
        headers: {
          ...(authorization && { Authorization: authorization }),
          ...(body && { 'Content-Type': 'application/octet-stream' }),
          ...(probe && method === 'PUT' && { 'If-None-Match': '*' }),
        },
      })
      checkStatus(response.status)
      return method === 'GET' ? await readBounded(response) : new Blob()
    } finally {
      clearTimeout(timer)
    }
  } catch (error) {
    if (error instanceof PortableError) {
      throw error
    }
    throw new PortableError('network')
  }
}

export async function testDavConnection(account: DavAccount) {
  const name = `.deepchat-probe-${crypto.randomUUID()}`
  const value = crypto.getRandomValues(new Uint8Array(32))
  await transfer(account, 'PUT', name, new Blob([value]))
  try {
    const read = new Uint8Array(await (await transfer(account, 'GET', name)).arrayBuffer())
    if (read.length !== value.length || !value.every((n, i) => read[i] === n)) {
      throw new PortableError('server')
    }
  } finally {
    await transfer(account, 'DELETE', name)
  }
}
export const putEncryptedBackup = (account: DavAccount, blob: Blob) =>
  transfer(account, 'PUT', remoteName, blob)
export const getEncryptedBackup = (account: DavAccount) => transfer(account, 'GET', remoteName)
