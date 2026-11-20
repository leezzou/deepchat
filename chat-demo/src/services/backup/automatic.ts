import { dismissToast, showToast, useToast } from '../../components/base/toastState.js'
import {
  loadBackupState,
  observeAutomaticSettings,
  recordCompletedBackupRound,
} from '../chat/backup.js'
import { useChatStore } from '../chat/store.js'
import { useBackupState } from './state.js'

/** App 在 initChat 完成后调用；不扫描既有完成轮次，返回订阅清理函数。 */
export const initializeAutoBackup = (): (() => void) => {
  let active = true
  let visibilityEpoch = 0
  let notice: number | undefined
  const clearNotice = () => {
    dismissToast(notice)
    notice = undefined
  }
  const hide = () => {
    visibilityEpoch++
    clearNotice()
  }
  const visibility = () => {
    if (document.hidden) {
      hide()
    }
  }
  const notify = (epoch: number, failed = false) => {
    if (
      !active ||
      document.hidden ||
      epoch !== visibilityEpoch ||
      !useBackupState.getState().autoEnabled
    ) {
      return
    }
    const current = useToast.getState()
    if (current.message && current.id !== notice) {
      return
    }
    notice = showToast({ key: failed ? 'backupAutomaticFailed' : 'backupAutoReady' }, 6000)
  }
  const requests = new Map<string, { controller: AbortController; messageId: string }>()
  const ignored = new WeakSet<AbortController>()
  const stopSettings = observeAutomaticSettings()
  const stopNotice = useBackupState.subscribe((state, previous) => {
    if (!state.autoEnabled || (previous.automatic && !state.automatic)) {
      clearNotice()
    }
    if (!state.autoEnabled) {
      for (const controller of Object.values(useChatStore.getState().streaming)) {
        ignored.add(controller)
      }
      requests.clear()
    }
  })
  window.addEventListener('pagehide', hide)
  document.addEventListener('visibilitychange', visibility)
  const observe = (state: ReturnType<typeof useChatStore.getState>) => {
    if (!state.ready) {
      return
    }
    for (const [sessionId, controller] of Object.entries(state.streaming)) {
      if (!useBackupState.getState().autoEnabled) {
        ignored.add(controller)
      }
      if (ignored.has(controller) || requests.get(sessionId)?.controller === controller) {
        continue
      }
      const reply = state.sessionCache[sessionId]?.messages.findLast(
        (message) =>
          message.role === 'assistant' &&
          (message.status === 'pending' || message.status === 'streaming')
      )
      if (reply) {
        requests.set(sessionId, { controller, messageId: reply.id })
      }
    }
    for (const [sessionId, request] of requests) {
      if (state.streaming[sessionId] === request.controller) {
        continue
      }
      requests.delete(sessionId)
      if (state.importingHistory || request.controller.signal.aborted) {
        continue
      }
      const session = state.sessionCache[sessionId]
      const index = session?.messages.findIndex((message) => message.id === request.messageId) ?? -1
      const reply = session?.messages[index]
      if (reply?.role !== 'assistant' || reply.status !== 'done') {
        continue
      }
      const parentId =
        reply.contextUserId ?? reply.parentId ?? session?.messages[index - 1]?.id ?? reply.id
      const epoch = document.hidden ? -1 : visibilityEpoch
      void recordCompletedBackupRound(`${sessionId}:${parentId}`)
        .then((generated) => {
          if (generated) {
            notify(epoch)
          }
        })
        .catch(() => {
          if (useBackupState.getState().autoEnabled && useBackupState.getState().error !== 'load') {
            useBackupState.setState({ error: 'automatic' })
          }
          notify(epoch, true)
        })
    }
  }
  // 只记当前在途请求，启动时载入的历史不计数。
  observe(useChatStore.getState())
  const unsubscribe = useChatStore.subscribe(observe)
  void loadBackupState().catch(() => {})
  return () => {
    active = false
    unsubscribe()
    stopSettings()
    stopNotice()
    clearNotice()
    window.removeEventListener('pagehide', hide)
    document.removeEventListener('visibilitychange', visibility)
    requests.clear()
  }
}
