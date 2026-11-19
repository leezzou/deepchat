// The v1 prefix fixes the KDF and all field sizes. Authentication covers the entire header.
// Web Crypto processes AES-GCM in one pass. Bound peak memory on phones before allocation.
export const MAX_PORTABLE_BYTES = 32 * 1024 * 1024
const MAX_METADATA = 4 * 1024 * 1024
const magic = new TextEncoder().encode('DCHATBK1')
const headerSize = magic.length + 16 + 12
const encoder = new TextEncoder()
export type BackupProblem =
  | 'address'
  | 'credentials'
  | 'network'
  | 'missing'
  | 'server'
  | 'password'
  | 'decrypt'
  | 'format'
  | 'large'
  | 'unavailable'
  | 'local'
export class PortableError extends Error {
  constructor(readonly problem: BackupProblem) {
    super(problem)
    this.name = 'PortableError'
  }
}
const derive = async (password: string, header: Uint8Array<ArrayBuffer>) => {
  if (!globalThis.crypto?.subtle) {
    throw new PortableError('unavailable')
  }
  if (!password || password.length > 1024) {
    throw new PortableError('password')
  }
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, [
    'deriveKey',
  ])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: header.subarray(8, 24), iterations: 600000 },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}
const params = (header: Uint8Array<ArrayBuffer>) => ({
  name: 'AES-GCM',
  iv: header.subarray(24),
  additionalData: header,
  tagLength: 128,
})

export async function sealBackup(zip: Blob, metadata: unknown, password: string): Promise<Blob> {
  if (password.length < 10 || password.length > 1024) {
    throw new PortableError('password')
  }
  const json = encoder.encode(JSON.stringify(metadata))
  if (
    json.length > MAX_METADATA ||
    zip.size + json.length + 4 + headerSize + 16 > MAX_PORTABLE_BYTES
  ) {
    throw new PortableError('large')
  }
  const header = crypto.getRandomValues(new Uint8Array(headerSize))
  header.set(magic)
  const key = await derive(password, header)
  const length = new ArrayBuffer(4)
  new DataView(length).setUint32(0, json.length)
  const plain = await new Blob([length, json, zip]).arrayBuffer()
  try {
    const sealed = await crypto.subtle.encrypt(params(header), key, plain)
    return new Blob([header, sealed], { type: 'application/octet-stream' })
  } finally {
    new Uint8Array(plain).fill(0)
  }
}

export async function openBackup(blob: Blob, password: string) {
  if (blob.size > MAX_PORTABLE_BYTES) {
    throw new PortableError('large')
  }
  const header = new Uint8Array(await blob.slice(0, headerSize).arrayBuffer())
  if (blob.size < headerSize + 16 + 4 || !magic.every((b, i) => header[i] === b)) {
    throw new PortableError('format')
  }
  const key = await derive(password, header)
  const cipher = await blob.slice(headerSize).arrayBuffer()
  const plain = await crypto.subtle.decrypt(params(header), key, cipher).catch(() => {
    throw new PortableError('decrypt')
  })
  try {
    const n = new DataView(plain).getUint32(0)
    if (!n || n > MAX_METADATA || n + 4 >= plain.byteLength) {
      throw new PortableError('format')
    }
    const metadata: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(plain, 4, n))
    )
    return {
      metadata,
      file: new File([new Uint8Array(plain, 4 + n)], 'history.zip', { type: 'application/zip' }),
    }
  } catch {
    throw new PortableError('format')
  } finally {
    new Uint8Array(plain).fill(0)
  }
}
