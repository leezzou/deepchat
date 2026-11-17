import { isNative } from '../../../shell/native.js'

const base64ToBuffer = (data: string): ArrayBuffer => {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes.buffer as ArrayBuffer
}

/**
 * 下载历史导出的 ZIP。
 * WebView 里 fetch 会被 CORS 拦（官方导出链接是对象存储的签名地址，通常不带 CORS 头），
 * 所以在原生壳里改用 Filesystem.downloadFile —— 它走原生 HTTP，不受同源策略限制。
 */
export const downloadArchive = async (
  url: string,
  name = 'deepseek-export.zip'
): Promise<File> => {
  if (isNative) {
    const { Filesystem, Directory } = await import('@capacitor/filesystem')
    // downloadFile 返回的是绝对路径，readFile 再用绝对路径 + directory 会二次拼接而报「File does not exist」，
    // 所以这里始终用同一个相对文件名读。
    await Filesystem.downloadFile({ url, path: name, directory: Directory.Cache })
    const { data } = await Filesystem.readFile({ path: name, directory: Directory.Cache })
    if (typeof data !== 'string') {
      throw new Error('unexpected file encoding')
    }
    return new File([base64ToBuffer(data)], name, { type: 'application/zip' })
  }

  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }
  const blob = await response.blob()
  return new File([blob], name, { type: 'application/zip' })
}
