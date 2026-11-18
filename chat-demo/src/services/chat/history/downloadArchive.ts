import { Capacitor } from '@capacitor/core'
import { isNative } from '../../../shell/native.js'
import { createId } from '../../../utils/id.js'

/**
 * 下载历史导出的 ZIP。
 * WebView 里 fetch 会被 CORS 拦（官方导出链接是对象存储的签名地址，通常不带 CORS 头），
 * 所以在原生壳里改用 Filesystem.downloadFile —— 它走原生 HTTP，不受同源策略限制。
 */
export const downloadArchive = async (
  url: string,
  name = 'deepseek-export.zip',
  onProgress?: (bytes: number, total: number) => void
): Promise<File> => {
  if (isNative) {
    const { Filesystem, Directory } = await import('@capacitor/filesystem')
    // downloadFile 返回的是绝对路径；先落盘再通过 Capacitor 的本地文件 URL 读取，
    // 避免 readFile 生成 base64 字符串后在 WebView 中再复制一份大文件导致内存峰值。
    const listener = onProgress
      ? await Filesystem.addListener('progress', (progress) => {
          if (progress.url === url) {
            onProgress(progress.bytes, progress.contentLength)
          }
        })
      : null
    const cachePath = `history-import-${createId()}.zip`
    try {
      await Filesystem.downloadFile({
        url,
        path: cachePath,
        directory: Directory.Cache,
        progress: Boolean(onProgress),
      })
      const { uri } = await Filesystem.getUri({ path: cachePath, directory: Directory.Cache })
      const response = await fetch(Capacitor.convertFileSrc(uri))
      if (!response.ok) {
        throw new Error(`本地文件读取失败：HTTP ${response.status}`)
      }
      return new File([await response.blob()], name, { type: 'application/zip' })
    } finally {
      await Promise.all([
        listener?.remove().catch(() => {}),
        Filesystem.deleteFile({ path: cachePath, directory: Directory.Cache }).catch(() => {}),
      ])
    }
  }

  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }
  // 由浏览器将流存入 Blob。只统计经过的字节，不在 JS 堆里积累整个下载。
  let body = response
  if (onProgress && response.body && typeof TransformStream !== 'undefined') {
    const total = response.headers.get('Content-Encoding')
      ? 0
      : Number(response.headers.get('Content-Length')) || 0
    let received = 0
    let lastReport = 0
    const measured = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          received += chunk.byteLength
          if (Date.now() - lastReport >= 120) {
            lastReport = Date.now()
            onProgress(received, total)
          }
          controller.enqueue(chunk)
        },
        flush() {
          onProgress(received, total)
        },
      })
    )
    body = new Response(measured)
  }
  return new File([await body.blob()], name, { type: 'application/zip' })
}
