import { useEffect } from 'react'
import { showToast } from '../../components/base/toastState.js'
import { closeMobileSider } from '../../components/sider/mobileSiderState.js'
import { resolveLocale } from '../../i18n/index.js'
import { flushDrafts, getDraft, putIncomingDraft, useDrafts } from '../../services/chat/drafts.js'
import {
  createDraftSession,
  flushChatPersistence,
  newChat,
  useChatStore,
} from '../../services/chat/store.js'
import { isSecurityUnlocked } from '../../services/security/bridge.js'
import { useSettings } from '../../services/settings.js'
import { incomingCall, readIncoming, UnreadableShare, type IncomingPort } from './bridge.js'

const message = (zh: string, en: string) =>
  resolveLocale(useSettings.getState().locale) === 'zh-CN' ? zh : en
// Native may replay the original launch Intent after a process recreation. Receipts contain only random IDs.
const receiptKey = 'deepchat:incoming:receipts:v1'
const applied = new Set<string>()
const receipts = (): string[] => {
  const ids: unknown = JSON.parse(localStorage.getItem(receiptKey) ?? '[]')
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []
}
const remember = (id: string) =>
  localStorage.setItem(
    receiptKey,
    JSON.stringify([
      ...receipts()
        .filter((x) => x !== id)
        .slice(-63),
      id,
    ])
  )

/** Mounted inside the unlocked App; native independently gates every sensitive request and response. */
export function IncomingShare() {
  const ready = useChatStore((s) => s.ready && !s.importingHistory)
  const draftsReady = useDrafts((s) => s.ready)
  useEffect(() => {
    const port = (window as Window & { DeepChatIncoming?: IncomingPort }).DeepChatIncoming
    if (!port || !ready || !draftsReady) {
      return
    }
    let active = true
    let running = false
    let requested = false
    let controller: AbortController | undefined
    const allowed = () =>
      active &&
      document.visibilityState !== 'hidden' &&
      isSecurityUnlocked() &&
      !useChatStore.getState().importingHistory
    const run = async () => {
      if (!allowed()) {
        controller?.abort()
        return
      }
      requested = true
      if (running) {
        return
      }
      running = true
      try {
        while (requested && allowed()) {
          requested = false
          controller = new AbortController()
          const { signal } = controller
          const valid = () => !signal.aborted && allowed()
          const { id, overflow } = await incomingCall<{ id?: string; overflow?: boolean }>(
            port,
            { op: 'peek' },
            signal
          )
          if (!valid()) {
            break
          }
          if (overflow) {
            showToast(
              message(
                '分享队列已满，请重新分享未收到的内容。',
                'The share queue was full. Please share any missing items again.'
              )
            )
          }
          if (!id) {
            continue
          }
          if (!receipts().includes(id)) {
            if (!applied.has(id)) {
              try {
                const { text, file } = await readIncoming(port, id, signal)
                if (!valid()) {
                  break
                }
                const home = getDraft(null)
                const separate = Boolean(home.text || home.attachments.length)
                const target = separate
                  ? createDraftSession(message('来自系统分享', 'Shared to DeepChat'))
                  : null
                if ((separate && !target) || !putIncomingDraft(target, id, text, file)) {
                  break
                }
                applied.add(id)
                if (!separate) {
                  newChat()
                }
                closeMobileSider()
                showToast(
                  message(
                    '系统分享已放入草稿，编辑后可发送。',
                    'Share added to your draft. Review it before sending.'
                  )
                )
              } catch (error) {
                if (!(error instanceof UnreadableShare) || !valid()) {
                  throw error
                }
                showToast(
                  message(
                    '无法读取分享内容。请选择文字、链接或一张可读取的图片（最多 64 MB）。',
                    'Could not read this share. Share text, a link, or one accessible image up to 64 MB.'
                  )
                )
              }
            }
            if (applied.has(id)) {
              const [saved] = await Promise.all([flushDrafts(), flushChatPersistence()])
              if (!saved) {
                break
              }
            }
            // The receipt finishes the local draft save even if the app relocked during the flush.
            // Acknowledging the native Intent still requires a fresh, unlocked gate below.
            remember(id)
          }
          if (!valid()) {
            break
          }
          await incomingCall(port, { op: 'ack', id }, signal)
          applied.delete(id)
          requested = true
        }
      } catch {
        // A relock/unmount cancels reads. An unacknowledged item is retried on the next foreground signal.
        if (allowed() && !controller?.signal.aborted) {
          showToast(
            message('分享暂未完成，请返回应用重试。', 'Share pending. Reopen the app to retry.')
          )
        }
      } finally {
        running = false
        if (requested && allowed()) {
          void run()
        }
      }
    }
    const wake = () => {
      void run()
    }
    window.addEventListener('deepchat:incoming-share', wake)
    window.addEventListener('deepchat:security-change', wake)
    document.addEventListener('visibilitychange', wake)
    wake()
    return () => {
      active = false
      controller?.abort()
      window.removeEventListener('deepchat:incoming-share', wake)
      window.removeEventListener('deepchat:security-change', wake)
      document.removeEventListener('visibilitychange', wake)
    }
  }, [ready, draftsReady])
  return null
}
