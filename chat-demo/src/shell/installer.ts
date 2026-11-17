/**
 * 应用内更新：把 Release 里的 APK 下下来，交给系统安装器。
 * 原生侧由 Updater.java 提供 window.AndroidUpdater.installApk(url)。
 */

type UpdaterBridge = {
  installApk?: (url: string) => void
  installApkWithFallback?: (url: string, fallbackUrl: string) => void
}

const bridge = (): UpdaterBridge | undefined =>
  (window as unknown as { AndroidUpdater?: UpdaterBridge }).AndroidUpdater

/** 原生壳里能否走「下载 + 系统安装器」这条路 */
export const canInstallInApp = (): boolean =>
  typeof bridge()?.installApkWithFallback === 'function' ||
  typeof bridge()?.installApk === 'function'

/** 触发下载安装；fallbackUrl 在首选镜像失败时由原生侧自动尝试 */
export const installApk = (url: string, fallbackUrl?: string): boolean => {
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
