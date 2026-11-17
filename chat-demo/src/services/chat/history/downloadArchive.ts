import { Capacitor } from '@capacitor/core'
import { isNative } from '../../../shell/native.js'

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
    try {
      await Filesystem.downloadFile({
        url,
        path: name,
        directory: Directory.Cache,
        progress: Boolean(onProgress),
      })
      const { uri } = await Filesystem.getUri({ path: name, directory: Directory.Cache })
      const response = await fetch(Capacitor.convertFileSrc(uri))
      if (!response.ok) {
        throw new Error(`本地文件读取失败：HTTP ${response.status}`)
      }
      return new File([await response.blob()], name, { type: 'application/zip' })
    } finally {
      await listener?.remove()
    }
  }

  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }
  const blob = await response.blob()
  return new File([blob], name, { type: 'application/zip' })
}
