import { registerPlugin } from '@capacitor/core'
import { MAX_ARCHIVE_READ_BYTES, type ArchiveSource } from './archiveSource.js'

const cache = registerPlugin<{
  readRange(options: { id: string; size: number; offset: number; length: number }): Promise<{ data: string }>
}>('HistoryArchive')

/** The bridge accepts an opaque generated id, never a caller-supplied path or file URI. */
export const androidArchive = (id: string, name: string, size: number, released: () => boolean): ArchiveSource => ({
  name, size,
  async readRange(offset, length) {
    if (released() || !Number.isSafeInteger(offset) || !Number.isSafeInteger(length) ||
        offset < 0 || length < 0 || length > MAX_ARCHIVE_READ_BYTES || offset > size - length) {
      throw new DOMException('Local cache read failed', 'NotReadableError')
    }
    try {
      const { data } = await cache.readRange({ id, size, offset, length })
      if (typeof data !== 'string' || data.length !== Math.ceil(length / 3) * 4) throw new Error()
      const decoded = atob(data)
      if (decoded.length !== length) throw new Error()
      const bytes = new Uint8Array(length)
      for (let i = 0; i < length; i++) bytes[i] = decoded.charCodeAt(i)
      return bytes
    } catch {
      throw new DOMException('Local cache read failed', 'NotReadableError')
    }
  },
})
