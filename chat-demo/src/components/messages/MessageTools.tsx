import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { useIsMobile } from '../../app/viewport.js'
import type { Message } from '../../services/chat/types.js'
import { isFavorite, toggleFavorite } from '../../services/library/index.js'
import { shareEntry } from '../../services/shareImage/content.js'
import { useBackLayer } from '../../shell/navigationMotion.js'
import { copyText } from '../../utils/clipboard.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { MemoryEditor } from '../library/MemoryEditor.js'
import { LibraryIcon } from '../library/LibraryIcon.js'
import { IconCopyOutline16, IconEllipsisOutline16 } from '../base/icons.js'
import { Modal, ModalPresence } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { SharePreview, useEnglish } from './SharePreview.js'
import actionStyles from './MessageActions.module.css'

export const MoreMessageButton = ({ id, onOpen }: { id: string; onOpen: (id: string) => void }) => {
  const en = useEnglish()
  return (
    <IconButton
      icon={<IconEllipsisOutline16 />}
      className={actionStyles.action}
      tooltip={en ? 'Message actions' : '消息操作'}
      tooltipPlacement="bottom"
      aria-haspopup="dialog"
      onClick={() => onOpen(id)}
    />
  )
}

const rowFor = (target: EventTarget | null) =>
  target instanceof Element ? target.closest<HTMLElement>('[data-message-id]') : null
const interactive =
  'a,button,input,textarea,select,summary,[role="button"],[contenteditable="true"]'
const copy = async (text: string, en: boolean) => {
  showToast((await copyText(text)) ? (en ? 'Copied' : '已复制') : { key: 'copyFailed' })
}

type MenuTarget = { id: string; selection: string }
export function useMessageTools(sessionId: string, messages: Message[]) {
  const en = useEnglish()
  const mobile = useIsMobile()
  const [menu, setMenu] = useState<MenuTarget | null>(null)
  const [selected, setSelected] = useState<Set<string> | null>(null)
  const [memory, setMemory] = useState<string | null>(null)
  const [preview, setPreview] = useState<Message[] | null>(null)
  const [scope, setScope] = useState(sessionId)
  // Scope transient layers as well as IDs to the conversation; keep the composer mounted.
  if (scope !== sessionId) {
    setScope(sessionId)
    setMenu(null)
    setSelected(null)
    setMemory(null)
    setPreview(null)
  }
  const selecting = selected !== null
  const ordered = selected ? messages.filter((message) => selected.has(message.id)) : []
  const message = menu ? messages.find((item) => item.id === menu.id) : undefined
  const entry = message ? shareEntry(message) : null
  const body = entry?.body || ''
  const favorite = message && isFavorite(sessionId, message.id)
  const press = useRef<{ timer: number; x: number; y: number } | null>(null)
  // WebViews can dispatch a mouse click onto the new sheet when the held finger lifts.
  // Cancel only that touch's compatibility events; the next deliberate tap remains active.
  const heldTouch = useRef(false)
  useEffect(() => {
    const release = (event: TouchEvent) => {
      if (heldTouch.current && event.cancelable) {
        event.preventDefault()
      }
      heldTouch.current = false
    }
    const reset = () => {
      heldTouch.current = false
    }
    document.addEventListener('touchend', release, { capture: true, passive: false })
    document.addEventListener('touchstart', reset, { capture: true, passive: true })
    document.addEventListener('touchcancel', reset, true)
    return () => {
      document.removeEventListener('touchend', release, true)
      document.removeEventListener('touchstart', reset, true)
      document.removeEventListener('touchcancel', reset, true)
    }
  }, [])
  const clearPress = useCallback(() => {
    if (press.current) {
      clearTimeout(press.current.timer)
    }
    press.current = null
  }, [])
  useEffect(() => clearPress, [sessionId, clearPress])
  const open = useCallback(
    (id: string, row?: HTMLElement) => {
      clearPress()
      const selection = window.getSelection()
      const ownSelection =
        selection && row?.contains(selection.anchorNode) && row.contains(selection.focusNode)
      setMenu({ id, selection: ownSelection ? selection.toString().trim() : '' })
    },
    [clearPress]
  )
  const startPress = (event: ReactPointerEvent<HTMLDivElement>) => {
    clearPress()
    if (selecting || !event.isPrimary || event.button !== 0 || event.pointerType === 'mouse') {
      return
    }
    const target = event.target
    if (!(target instanceof Element) || target.closest(interactive)) {
      return
    }
    const row = rowFor(target)
    const id = row?.dataset.messageId
    if (id && row) {
      press.current = {
        x: event.clientX,
        y: event.clientY,
        timer: window.setTimeout(() => {
          heldTouch.current = true
          open(id, row)
        }, 520),
      }
    }
  }
  const toggle = (id: string) =>
    setSelected((previous) => {
      const next = new Set(previous)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  useBackLayer(selecting, () => setSelected(null), -1)
  const lastFocus = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (!selecting) {
      return
    }
    const first = document.querySelector<HTMLInputElement>('.dc-message-selector input:checked')
    first?.focus({ preventScroll: true })
    return () => {
      if (lastFocus.current?.isConnected) {
        lastFocus.current.focus({ preventScroll: true })
      }
    }
  }, [selecting])
  const controls = selecting ? (
    <div
      className="dc-selection-bar"
      role="toolbar"
      aria-label={en ? 'Selected messages' : '多选消息'}
    >
      <Button variant="outlined" size="m" onClick={() => setSelected(null)}>
        {en ? 'Cancel' : '取消'}
      </Button>
      <span aria-live="polite">
        {en ? `${ordered.length} selected` : `已选 ${ordered.length} 条`}
      </span>
      <Button size="m" disabled={!ordered.length} onClick={() => setPreview(ordered)}>
        {en ? 'Share preview' : '分享预览'}
      </Button>
    </div>
  ) : null
  const dialogs = (
    <ModalPresence>
      {message && menu ? (
        <Modal
          key="actions"
          title={en ? 'Message actions' : '消息操作'}
          placement={mobile ? 'bottom' : 'center'}
          closable
          onClose={() => setMenu(null)}
        >
          <div className="dc-message-menu">
            {(body || menu.selection) && (
              <button
                onClick={() => {
                  void copy(menu.selection || body, en)
                  setMenu(null)
                }}
              >
                <IconCopyOutline16 />
                {en ? 'Copy' : '复制'}
              </button>
            )}
            <button
              onClick={() => {
                try {
                  const saved = toggleFavorite(
                    sessionId,
                    message.id,
                    body || entry?.files.join(' · ') || (en ? 'Message' : '消息')
                  )
                  showToast(
                    saved
                      ? en
                        ? 'Added to favorites'
                        : '已加入收藏'
                      : en
                        ? 'Removed from favorites'
                        : '已取消收藏'
                  )
                  setMenu(null)
                } catch {
                  showToast(en ? 'Could not update favorites' : '收藏未能保存，请重试')
                }
              }}
            >
              <LibraryIcon name="favorite" />
              {favorite
                ? en
                  ? 'Remove from favorites'
                  : '取消收藏'
                : en
                  ? 'Add to favorites'
                  : '收藏'}
            </button>
            {(body || menu.selection) && (
              <button
                onClick={() => {
                  setMemory(menu.selection || body)
                  setMenu(null)
                }}
              >
                <LibraryIcon name="memory" />
                {en ? 'Save to memory' : '保存为记忆'}
              </button>
            )}
            <button
              onClick={() => {
                const row = document.querySelector(`[data-message-id="${CSS.escape(message.id)}"]`)
                lastFocus.current =
                  row?.querySelector<HTMLElement>('[aria-haspopup="dialog"]') ?? null
                setSelected(new Set([message.id]))
                setMenu(null)
              }}
            >
              <LibraryIcon name="select" />
              {en ? 'Select messages' : '多选消息'}
            </button>
            {message.role === 'assistant' && Boolean(message.lastRequestMemories?.length) && (
              <details className="dc-used-memories">
                <summary>
                  {en ? 'Memories sent with the last request' : '上次请求携带的记忆'}
                </summary>
                <ul>
                  {message.lastRequestMemories?.map((text, index) => (
                    <li key={index}>{text}</li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        </Modal>
      ) : memory !== null ? (
        <MemoryEditor key="memory" sessionId={sessionId} message={memory} onClose={() => setMemory(null)} />
      ) : preview ? (
        <SharePreview key="preview" messages={preview} onClose={() => setPreview(null)} />
      ) : null}
    </ModalPresence>
  )
  return {
    selecting,
    selected,
    open,
    toggle,
    controls,
    dialogs,
    handlers: {
      onPointerDown: startPress,
      onPointerCancel: clearPress,
      onPointerUp: clearPress,
      onPointerLeave: clearPress,
      onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
        const current = press.current
        if (current && Math.hypot(event.clientX - current.x, event.clientY - current.y) > 9) {
          clearPress()
        }
      },
      onContextMenu(event: React.MouseEvent<HTMLDivElement>) {
        const target = event.target
        if (!(target instanceof Element) || target.closest(interactive) || selecting) {
          return
        }
        const row = rowFor(target)
        if (row?.dataset.messageId) {
          event.preventDefault()
          heldTouch.current ||= Boolean(press.current)
          open(row.dataset.messageId, row)
        }
      },
    },
    label(index: number) {
      return en ? `Select message ${index + 1}` : `选择第 ${index + 1} 条消息`
    },
  }
}
