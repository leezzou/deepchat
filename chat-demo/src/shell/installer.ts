/**
 * 应用内更新：把 Release 里的 APK 下下来，交给系统安装器。
 * 原生侧由 Updater.java 提供 window.AndroidUpdater.installApk(url)。
 */

type UpdaterBridge = {
  installApk?: (url: string) => void
  installApkWithFallback?: (url: string, fallbackUrl: string) => void
  installDownloadedApk?: () => void
  isDownloadedUpdateReady?: () => boolean
}

const bridge = (): UpdaterBridge | undefined =>
  (window as unknown as { AndroidUpdater?: UpdaterBridge }).AndroidUpdater

/** 只使用能分开下载与安装的新桥；旧壳下载后直接安装，无法再次保护草稿。 */
export const canInstallInApp = (): boolean => {
  const target = bridge()
  return (
    typeof target?.installDownloadedApk === 'function' &&
    typeof target.isDownloadedUpdateReady === 'function' &&
    (typeof target.installApkWithFallback === 'function' || typeof target.installApk === 'function')
  )
}

/** 触发下载安装；fallbackUrl 在首选镜像失败时由原生侧自动尝试 */
export const installApk = (url: string, fallbackUrl?: string): boolean => {
  if (!canInstallInApp()) {
    return false
  }
  const target = bridge()
  if (target?.installApkWithFallback) {
    target.installApkWithFallback(url, fallbackUrl ?? '')
    return true
  }
  if (!target?.installApk) {
    return false
  }
  target.installApk(url)
  return true
}

export const isDownloadedUpdateReady = () => bridge()?.isDownloadedUpdateReady?.() === true

/** Only updateSafety calls this, after checking work and awaiting local persistence. */
export const installDownloadedApk = (): boolean => {
  const target = bridge()
  if (!target?.installDownloadedApk || !target.isDownloadedUpdateReady?.()) {
    return false
  }
  target.installDownloadedApk()
  return true
}
