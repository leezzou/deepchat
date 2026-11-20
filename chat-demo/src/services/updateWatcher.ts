import { useEffect } from 'react'
import { create } from 'zustand'
import { readInstalledVersion } from '../shell/installer.js'
import { compareVersions, fetchLatestRelease, type ReleaseInfo } from './update.js'

type UpdateNotice = {
  version: string
  latest: ReleaseInfo | null
  available: ReleaseInfo | null
  checking: boolean
  checked: boolean
  failed: boolean
}
export const useUpdateNotice = create<UpdateNotice>(() => ({
  version: readInstalledVersion(),
  latest: null,
  available: null,
  checking: false,
  checked: false,
  failed: false,
}))

// Reconcile the installed package even if the manifest is cached, offline, or still loading.
export const refreshInstalledVersion = (latest = useUpdateNotice.getState().latest) => {
  const version = readInstalledVersion()
  const available =
    latest && version && compareVersions(latest.version, version) > 0 ? latest : null
  useUpdateNotice.setState({ version, latest, available })
  return version
}

export const checkUpdateAvailable = async (force = false) => {
  if (!refreshInstalledVersion() || useUpdateNotice.getState().checking) {
    return
  }
  useUpdateNotice.setState({ checking: true, failed: false })
  try {
    refreshInstalledVersion(await fetchLatestRelease(force))
    useUpdateNotice.setState({ checked: true })
  } catch {
    // Keep a previously announced release usable while the network is unavailable.
    useUpdateNotice.setState({ failed: true })
  } finally {
    useUpdateNotice.setState({ checking: false })
  }
}

/** One result drives the header, drawer, settings row, and release details. */
export const useUpdateWatcher = () => {
  useEffect(() => {
    void checkUpdateAvailable()
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void checkUpdateAvailable()
      }
    }
    window.addEventListener('focus', onVisible)
    document.addEventListener('visibilitychange', onVisible)
    const timer = setInterval(onVisible, 60_000)
    return () => {
      window.removeEventListener('focus', onVisible)
      document.removeEventListener('visibilitychange', onVisible)
      clearInterval(timer)
    }
  }, [])
}
