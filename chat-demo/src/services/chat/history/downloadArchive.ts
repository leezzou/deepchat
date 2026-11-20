import { Capacitor } from '@capacitor/core'
import { createId } from '../../../utils/id.js'
import { androidArchive } from './androidArchive.js'
import type { ArchiveSource } from './archiveSource.js'
import { MAX_ARCHIVE_BYTES } from './limits.js'
import { spoolBlob } from './spool.js'

type Progress = (received: number, total: number) => void
export type DownloadedArchive = { file: ArchiveSource; dispose: () => Promise<void> }

const checkSize = (size: number) => {
  if (size > MAX_ARCHIVE_BYTES) {
    const error = new Error('ZIP exceeds import size limit')
    error.name = 'ArchiveSizeError'
    throw error
  }
}

/** Keep a seekable file until the user confirms/cancels and IndexedDB has finished copying it. */
async function receive(response: Response, name: string, knownSize: number, progress?: Progress): Promise<DownloadedArchive> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Missing download body')
  let received = 0
  let last = 0
  async function* chunks() {
    for (;;) {
      const { value, done } = await reader!.read()
      if (done) break
      received += value.byteLength
      checkSize(received)
      if (Date.now() - last >= 120) {
        progress?.(received, knownSize)
        last = Date.now()
      }
      yield value
    }
    if (knownSize && knownSize !== received) throw new Error('Incomplete download')
    progress?.(received, knownSize)
  }
  try {
    checkSize(knownSize)
    const owned = await spoolBlob(chunks())
    // A STORE attachment must survive deletion of this temporary archive, so expose reads
    // only. A Blob slice backed by this OPFS file can become unreadable inside IndexedDB.
    return {
      file: { name, size: owned.blob.size,
        readRange: async (offset, length) => new Uint8Array(await owned.blob.slice(offset, offset + length).arrayBuffer()) },
      dispose: owned.dispose,
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export async function downloadArchive(url: string, name = 'deepseek-export.zip', onProgress?: Progress): Promise<DownloadedArchive> {
  let scheme: string
  try { scheme = new URL(url).protocol } catch { throw new Error('Invalid export link') }
  if (scheme !== 'https:' && scheme !== 'http:') throw new Error('Invalid export link')
  if (!Capacitor.isNativePlatform()) {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const total = response.headers.get('Content-Encoding') ? 0 : Number(response.headers.get('Content-Length')) || 0
    return receive(response, name, total, onProgress)
  }

  // Signed export links may have no CORS headers. The native downloader writes directly to disk.
  const { Filesystem, Directory } = await import('@capacitor/filesystem')
  const android = Capacitor.getPlatform() === 'android'
  const id = android ? Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('') : createId()
  const path = `history-import-${id}.zip`
  const directory = Directory.Cache
  let expectedSize = 0
  const progress = android || Boolean(onProgress)
  const listener = progress ? await Filesystem.addListener('progress', p => {
    if (p.url !== url) return
    if (p.contentLength > 0) expectedSize = p.contentLength
    onProgress?.(p.bytes, p.contentLength)
  }) : null
  let retained = false
  let released = false
  const dispose = async () => {
    if (released) return
    released = true
    await Filesystem.deleteFile({ path, directory }).catch(() => {})
  }
  try {
    await Filesystem.downloadFile({ url, path, directory, progress })
    const { uri, size } = await Filesystem.stat({ path, directory })
    checkSize(size)
    if (android) {
      if (!Number.isSafeInteger(size) || size <= 0 || (expectedSize && expectedSize !== size)) {
        throw new Error('Incomplete download')
      }
      const file = androidArchive(id, name, size, () => released)
      retained = true
      return { file, dispose }
    }
    const response = await fetch(Capacitor.convertFileSrc(uri))
    if (!response.ok) throw new Error(`Local cache read: HTTP ${response.status}`)
    return await receive(response, name, size)
  } finally {
    await Promise.all([listener?.remove().catch(() => {}), retained ? undefined : dispose()])
  }
}
