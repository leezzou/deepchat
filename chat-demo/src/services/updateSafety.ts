import { create } from 'zustand'
import { showToast } from '../components/base/toastState.js'
import { translate } from '../i18n/index.js'
import {
  canInstallInApp,
  installApk,
  installDownloadedApk,
  isDownloadedUpdateReady,
} from '../shell/installer.js'
import { openExternal } from '../shell/native.js'
import { flushDrafts, useDrafts } from './chat/drafts.js'
import { flushChatPersistence, useChatStore } from './chat/store.js'
import type { ReleaseInfo } from './update.js'
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

type UpdateSafetyState = {
  pending: ReleaseInfo | null
  status: 'idle' | 'waiting' | 'downloading' | 'ready'
  reloadPending: boolean
  working: boolean
}
export const useUpdateSafety = create<UpdateSafetyState>(() => ({
  pending: null,
  status: 'idle',
  reloadPending: false,
  working: false,
}))

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
  useUpdateSafety.setState({ pending: release, status: 'waiting' })
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
    if (
      pending.apkUrl &&
      canInstallInApp() &&
      installApk(pending.apkUrl, pending.apkUrlFallback ?? undefined)
    ) {
      useUpdateSafety.setState({ status: 'downloading' })
      showToast({ key: 'updateAwaitDownload' })
    } else {
      await openExternal(pending.pageUrl)
      useUpdateSafety.setState({ pending: null, status: 'idle' })
    }
  } catch {
    showToast({ key: 'updateInstallFailed', type: 'error' })
  } finally {
    useUpdateSafety.setState({ working: false })
  }
}

export const installReadyUpdate = async () => {
  if (useUpdateSafety.getState().working) {
    return
  }
  useUpdateSafety.setState({ working: true })
  try {
    if (!(await prepareToLeave())) {
      return
    }
    if (!installDownloadedApk()) {
      throw new Error('No downloaded update')
    }
    useUpdateSafety.setState({ status: 'idle', pending: null })
  } catch {
    showToast({ key: 'updateInstallFailed', type: 'error' })
  } finally {
    useUpdateSafety.setState({ working: false })
  }
}

export const dismissPendingUpdate = () =>
  useUpdateSafety.setState({ status: 'idle', pending: null, reloadPending: false })

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
  const ready = () => useUpdateSafety.setState({ status: 'ready' })
  const failed = () => {
    useUpdateSafety.setState({ status: 'waiting' })
    showToast({ key: 'updateInstallFailed', type: 'error' })
  }
  const permissionRequired = () => useUpdateSafety.setState({ status: 'waiting' })
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
  window.addEventListener('deepchat:update-ready', ready)
  window.addEventListener('deepchat:update-failed', failed)
  window.addEventListener('deepchat:update-permission', permissionRequired)
  window.addEventListener('unhandledrejection', staleResource)
  return () => {
    delete target.__deepchatCanInstallUpdate
    window.removeEventListener('deepchat:update-ready', ready)
    window.removeEventListener('deepchat:update-failed', failed)
    window.removeEventListener('deepchat:update-permission', permissionRequired)
    window.removeEventListener('unhandledrejection', staleResource)
  }
}
