import { showToast } from '../../components/base/toastState.js'
import { loadBackupState, recordCompletedBackupRound } from '../chat/backup.js'
import { useChatStore } from '../chat/store.js'
import { useBackupState } from './state.js'

/** App 在 initChat 完成后调用；不扫描既有完成轮次，返回订阅清理函数。 */
export const initializeAutoBackup = (): (() => void) => {
  let active = true
  const requests = new Map<string, { controller: AbortController; messageId: string }>()
  const observe = (state: ReturnType<typeof useChatStore.getState>) => {
    if (!state.ready) {
      return
    }
    for (const [sessionId, controller] of Object.entries(state.streaming)) {
      if (requests.get(sessionId)?.controller === controller) {
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
      const parentId = reply.parentId ?? session?.messages[index - 1]?.id ?? reply.id
      void recordCompletedBackupRound(`${sessionId}:${parentId}`)
        .then((generated) => {
          if (active && generated) {
            showToast({ key: 'backupAutoReady' })
          }
        })
        .catch(() => {
          useBackupState.setState({ error: 'automatic' })
          if (active) {
            showToast({ key: 'backupAutomaticFailed', type: 'error' })
          }
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
    requests.clear()
  }
}
