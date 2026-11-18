import { Capacitor } from '@capacitor/core'
import { isNative } from '../../../shell/native.js'
import { createId } from '../../../utils/id.js'
import { MAX_ARCHIVE_BYTES } from './limits.js'
import { spoolBlob } from './spool.js'

type Progress = (received: number, total: number) => void
export type DownloadedArchive = { file: File; dispose: () => Promise<void> }

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
    return { file: new File([owned.blob], name, { type: 'application/zip' }), dispose: owned.dispose }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export async function downloadArchive(url: string, name = 'deepseek-export.zip', onProgress?: Progress): Promise<DownloadedArchive> {
  if (!isNative) {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const total = response.headers.get('Content-Encoding') ? 0 : Number(response.headers.get('Content-Length')) || 0
    return receive(response, name, total, onProgress)
  }

  // Signed export links may have no CORS headers. The native downloader writes directly to disk.
  const { Filesystem, Directory } = await import('@capacitor/filesystem')
  const path = `history-import-${createId()}.zip`
  const directory = Directory.Cache
  const listener = onProgress ? await Filesystem.addListener('progress', (p) => {
    if (p.url === url) onProgress(p.bytes, p.contentLength)
  }) : null
  try {
    await Filesystem.downloadFile({ url, path, directory, progress: Boolean(onProgress) })
    const { uri, size } = await Filesystem.stat({ path, directory })
    checkSize(size)
    const response = await fetch(Capacitor.convertFileSrc(uri))
    if (!response.ok) throw new Error(`Local cache read: HTTP ${response.status}`)
    return await receive(response, name, size)
  } finally {
    await Promise.all([
      listener?.remove().catch(() => {}),
      Filesystem.deleteFile({ path, directory }).catch(() => {}),
    ])
  }
}
