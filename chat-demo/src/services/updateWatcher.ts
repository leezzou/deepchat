import { useEffect } from 'react'
import { create } from 'zustand'
import { compareVersions, fetchLatestRelease, type ReleaseInfo } from './update.js'

/** 后台发现的可用更新：App 启动、回到前台、以及每 30 分钟各查一次 */
export const useUpdateNotice = create<{ available: ReleaseInfo | null; checking: boolean }>(() => ({
  available: null,
  checking: false,
}))

const currentVersion = () =>
  document.querySelector('meta[name="application-version"]')?.getAttribute('content') ?? ''

let inFlight = false

export const checkUpdateAvailable = async () => {
  if (inFlight || !currentVersion()) {
    return
  }
  inFlight = true
  useUpdateNotice.setState({ checking: true })
  try {
    const release = await fetchLatestRelease()
    if (release && compareVersions(release.version, currentVersion()) > 0) {
      useUpdateNotice.setState({ available: release })
    } else {
      useUpdateNotice.setState({ available: null })
    }
  } catch {
    // 网络失败静默忽略，下次再试
  } finally {
    inFlight = false
    useUpdateNotice.setState({ checking: false })
  }
}

const CHECK_INTERVAL = 30 * 60 * 1000

/** 挂在 App 根节点：轮询新版本，设置/抽屉上的红点靠它 */
export const useUpdateWatcher = () => {
  useEffect(() => {
    void checkUpdateAvailable()
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void checkUpdateAvailable()
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    const timer = setInterval(() => void checkUpdateAvailable(), CHECK_INTERVAL)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      clearInterval(timer)
    }
  }, [])
}
