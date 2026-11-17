import { isNative } from './native.js'

/** Blob → base64（去掉 data: 前缀），Filesystem 只收 base64 字符串 */
const blobToBase64 = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.onload = () => {
      const result = String(reader.result ?? '')
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.readAsDataURL(blob)
  })

/**
 * 保存/分享一个文件。
 * - 浏览器：走 a[download]，Safari/Chrome 都是正常下载。
 * - Capacitor WebView：a[download] + blob: 会静默失败，改成写入缓存目录再唤起系统分享
 *   （分享面板里可以「保存到文件」，微信/邮件也能直接发出去）。
 */
export type SaveBlobResult = { status: 'download-requested' | 'shared' }

/** 返回交付给浏览器/系统的结果；分享完成和下载请求都不能证明文件已持久保存。 */
export const saveBlob = async (name: string, blob: Blob): Promise<SaveBlobResult> => {
  if (!isNative) {
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = name
    document.body.append(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
    return { status: 'download-requested' }
  }

  const [{ Filesystem, Directory }, { Share }] = await Promise.all([
    import('@capacitor/filesystem'),
    import('@capacitor/share'),
  ])
  const data = await blobToBase64(blob)
  const { uri } = await Filesystem.writeFile({
    path: name,
    data,
    directory: Directory.Cache,
    recursive: true,
  })
  await Share.share({ title: name, url: uri, dialogTitle: name })
  return { status: 'shared' }
}
