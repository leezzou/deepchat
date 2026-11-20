import { useSyncExternalStore } from 'react'
import { create } from 'zustand'
import { showToast } from '../components/base/toastState.js'
import { translate } from '../i18n/index.js'
import {
  canInstallInApp,
  installApk,
  installDownloadedApk,
  isDownloadedUpdateReady,
  readDownloadedVersion,
  readInstalledVersion,
} from '../shell/installer.js'
import { openExternal } from '../shell/native.js'
import { flushDrafts, useDrafts } from './chat/drafts.js'
import { flushChatPersistence, useChatStore } from './chat/store.js'
import { compareVersions, type ReleaseInfo } from './update.js'
import { usePendingEdits } from './pendingEdits.js'

export type UpdateBlockReason =
  | 'updateWaitGenerating'
  | 'updateWaitDrafts'
  | 'updateWaitStorage'
  | 'updateWaitImport'

/** Every update path uses the same check, including the moment a downloaded APK is installed. */
export const getUpdateBlockReason = (): UpdateBlockReason | null => {
  const chat = useChatStore.getState()
  const drafts = useDrafts.getState()
  if (chat.importingHistory) {
    return 'updateWaitImport'
  }
  if (Object.keys(chat.streaming).length || Object.keys(chat.compacting).length) {
    return 'updateWaitGenerating'
  }
  if (
    usePendingEdits.getState().ids.size ||
    [...drafts.drafts.values()].some(
      (draft) => draft.text.length > 0 || draft.attachments.length > 0
    )
  ) {
    return 'updateWaitDrafts'
  }
  if (
    !chat.ready ||
    !drafts.ready ||
    drafts.saveError ||
    Object.values(chat.sessionSaveErrors).some(Boolean)
  ) {
    return 'updateWaitStorage'
  }
  return null
}

const subscribeWork = (listener: () => void) => {
  const unsubscribes = [
    useChatStore.subscribe(listener),
    useDrafts.subscribe(listener),
    usePendingEdits.subscribe(listener),
  ]
  return () => unsubscribes.forEach((unsubscribe) => unsubscribe())
}
export const useUpdateBlockReason = () => useSyncExternalStore(subscribeWork, getUpdateBlockReason)

type UpdateSafetyState = {
  pending: ReleaseInfo | null
  status: 'idle' | 'waiting' | 'permission' | 'downloading' | 'failed' | 'ready' | 'installing'
  progress: { received: number; total: number } | null
  error: 'updateStorageFailed' | 'updateInstallFailed' | 'updateDownloadFailed' | null
  target: string
  completed: string
  resumePanel: boolean
  reloadPending: boolean
  working: boolean
}
const idle = { pending: null, status: 'idle', progress: null, error: null, target: '' } as const
export const useUpdateSafety = create<UpdateSafetyState>(() => ({
  ...idle,
  completed: '',
  resumePanel: false,
  reloadPending: false,
  working: false,
}))

// Package replacement may kill the WebView. Remember only the version the user chose to install.
const RETURN_KEY = 'deepchat:settings-install-version'
const rememberReturn = (version: string) => {
  try {
    if (version) {
      localStorage.setItem(RETURN_KEY, version)
    } else {
      localStorage.removeItem(RETURN_KEY)
    }
  } catch {
    /* Updating also works when browser storage is unavailable. */
  }
}
export const takeUpdateReturn = () => {
  let target: string | null = null
  try {
    target = localStorage.getItem(RETURN_KEY)
  } catch {
    return false
  }
  if (!target) {
    return false
  }
  rememberReturn('')
  const version = readInstalledVersion()
  if (version && compareVersions(version, target) >= 0) {
    useUpdateSafety.setState({ ...idle, completed: version, resumePanel: true })
    return true
  }
  if (!isDownloadedUpdateReady()) {
    return false
  }
  useUpdateSafety.setState({ status: 'ready', target, resumePanel: true })
  return true
}

const waitNotice = (reason: UpdateBlockReason) =>
  showToast({
    key: 'updateWaiting',
    params: { reason: translate(reason) },
  })

const prepareToLeave = async () => {
  const reason = getUpdateBlockReason()
  if (reason) {
    waitNotice(reason)
    return false
  }
  try {
    if (!(await flushDrafts())) {
      throw new Error('Draft persistence failed')
    }
    await flushChatPersistence()
  } catch {
    useUpdateSafety.setState({ error: 'updateStorageFailed' })
    showToast({ key: 'updateStorageFailed', type: 'error' })
    return false
  }
  const after = getUpdateBlockReason()
  if (after) {
    waitNotice(after)
    return false
  }
  return document.visibilityState === 'visible'
}

export const requestUpdateInstall = async (release: ReleaseInfo) => {
  if (useUpdateSafety.getState().status === 'downloading') {
    return
  }
  useUpdateSafety.setState({
    ...idle,
    pending: release,
    target: release.version,
    status: 'waiting',
    completed: '',
  })
  await continueUpdateInstall()
}

export const continueUpdateInstall = async () => {
  const { pending, working } = useUpdateSafety.getState()
  if (!pending || working) {
    return
  }
  useUpdateSafety.setState({ working: true })
  try {
    if (!(await prepareToLeave())) {
      return
    }
    if (pending.apkUrl && canInstallInApp()) {
      useUpdateSafety.setState({ status: 'downloading', progress: null, error: null })
      if (!installApk(pending.apkUrl, pending.apkUrlFallback ?? undefined, pending.version)) {
        throw new Error('Update bridge unavailable')
      }
    } else {
      if (!pending.pageUrl) {
        throw new Error('Release page unavailable')
      }
      await openExternal(pending.pageUrl)
      useUpdateSafety.setState(idle)
    }
  } catch {
    useUpdateSafety.setState({ status: 'failed', error: 'updateDownloadFailed' })
    showToast({ key: 'updateDownloadFailed', type: 'error' })
  } finally {
    useUpdateSafety.setState({ working: false })
  }
}

export const installReadyUpdate = async (returnToSettings = false) => {
  if (useUpdateSafety.getState().working) {
    return
  }
  useUpdateSafety.setState({ working: true })
  try {
    if (!(await prepareToLeave())) {
      return
    }
    const target = readDownloadedVersion() || useUpdateSafety.getState().target
    if (returnToSettings) {
      rememberReturn(target)
    }
    useUpdateSafety.setState({ status: 'installing', error: null, target })
    if (!installDownloadedApk()) {
      throw new Error('No downloaded update')
    }
  } catch {
    rememberReturn('')
    useUpdateSafety.setState({
      status: isDownloadedUpdateReady() ? 'ready' : 'failed',
      error: 'updateInstallFailed',
    })
    showToast({ key: 'updateInstallFailed', type: 'error' })
  } finally {
    useUpdateSafety.setState({ working: false })
  }
}

export const dismissPendingUpdate = () =>
  useUpdateSafety.setState({ ...idle, reloadPending: false })

const RELOAD_KEY = 'deepchat:last-safe-reload'
export const requestSafeReload = async () => {
  useUpdateSafety.setState({ reloadPending: true })
  if (useUpdateSafety.getState().working) {
    return
  }
  useUpdateSafety.setState({ working: true })
  try {
    if (!(await prepareToLeave())) {
      return
    }
    try {
      const previous = Number(sessionStorage.getItem(RELOAD_KEY)) || 0
      if (Date.now() - previous < 60_000) {
        showToast({ key: 'updateInstallFailed', type: 'error' })
        return
      }
      sessionStorage.setItem(RELOAD_KEY, String(Date.now()))
    } catch {
      /* Storage persistence was checked above; the loop guard is best effort. */
    }
    window.location.reload()
  } finally {
    useUpdateSafety.setState({ working: false })
  }
}

/** Update checks stay passive. Downloads and reloads never take focus from ongoing work. */
export const bindUpdateSafety = () => {
  const target = window as unknown as { __deepchatCanInstallUpdate?: () => boolean }
  target.__deepchatCanInstallUpdate = () =>
    document.visibilityState === 'visible' && getUpdateBlockReason() === null
  const ready = () =>
    useUpdateSafety.setState((state) => ({
      status: 'ready',
      progress: null,
      error: null,
      target: readDownloadedVersion() || state.target,
    }))
  const failed = () => useUpdateSafety.setState({ status: 'failed', error: 'updateDownloadFailed' })
  const installFailed = () => {
    rememberReturn('')
    useUpdateSafety.setState({
      status: isDownloadedUpdateReady() ? 'ready' : 'failed',
      error: 'updateInstallFailed',
    })
  }
  const permissionRequired = () => useUpdateSafety.setState({ status: 'permission', error: null })
  const progress = (event: Event) => {
    const detail = (event as CustomEvent<{ received: number; total: number }>).detail
    if (useUpdateSafety.getState().status === 'downloading' && Number.isFinite(detail?.received)) {
      useUpdateSafety.setState({ progress: { received: detail.received, total: detail.total } })
    }
  }
  const onReturn = () => {
    if (document.visibilityState !== 'visible') {
      return
    }
    const { target: requested, status } = useUpdateSafety.getState()
    const version = readInstalledVersion()
    if (requested && version && compareVersions(version, requested) >= 0) {
      rememberReturn('')
      useUpdateSafety.setState({ ...idle, completed: version })
    } else if (status === 'installing') {
      rememberReturn('')
      if (isDownloadedUpdateReady()) {
        ready()
      } else {
        useUpdateSafety.setState(idle)
      }
    }
  }
  const staleResource = (event: PromiseRejectionEvent) => {
    const reason: unknown = event.reason
    const message = reason instanceof Error ? `${reason.name} ${reason.message}` : String(reason)
    if (
      /ChunkLoadError|Loading (CSS )?chunk .+ failed|Failed to fetch dynamically imported module/i.test(
        message
      )
    ) {
      useUpdateSafety.setState({ reloadPending: true })
    }
  }
  if (isDownloadedUpdateReady()) {
    ready()
  }
  document.addEventListener('visibilitychange', onReturn)
  window.addEventListener('focus', onReturn)
  window.addEventListener('deepchat:update-progress', progress)
  window.addEventListener('deepchat:update-install-failed', installFailed)
  window.addEventListener('deepchat:update-ready', ready)
  window.addEventListener('deepchat:update-failed', failed)
  window.addEventListener('deepchat:update-permission', permissionRequired)
  window.addEventListener('unhandledrejection', staleResource)
  return () => {
    delete target.__deepchatCanInstallUpdate
    document.removeEventListener('visibilitychange', onReturn)
    window.removeEventListener('focus', onReturn)
    window.removeEventListener('deepchat:update-progress', progress)
    window.removeEventListener('deepchat:update-install-failed', installFailed)
    window.removeEventListener('deepchat:update-ready', ready)
    window.removeEventListener('deepchat:update-failed', failed)
    window.removeEventListener('deepchat:update-permission', permissionRequired)
    window.removeEventListener('unhandledrejection', staleResource)
  }
}
