/**
 * 应用内更新：把 Release 里的 APK 下下来，交给系统安装器。
 * 原生侧由 Updater.java 提供 window.AndroidUpdater.installApk(url)。
 */

type UpdaterBridge = {
  installApk?: (url: string) => void
}

const bridge = (): UpdaterBridge | undefined =>
  (window as unknown as { AndroidUpdater?: UpdaterBridge }).AndroidUpdater

/** 原生壳里能否走「下载 + 系统安装器」这条路 */
export const canInstallInApp = (): boolean => typeof bridge()?.installApk === 'function'

/** 触发下载安装；返回 false 表示当前环境不支持，调用方应退回浏览器打开 */
export const installApk = (url: string): boolean => {
  const target = bridge()
  if (!target?.installApk) {
    return false
  }
  target.installApk(url)
  return true
}
