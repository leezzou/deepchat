import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { useIsSettingsMobile } from '../../app/viewport.js'
import { getConversationRoute } from '../../services/api/access.js'
import { getConversationMode } from '../../services/conversationMode/storage.js'
import { applyConversationMode } from '../../services/chat/store.js'
import { saveProfileDiscovery } from '../../services/settings.js'
import { useWorkBuddyState } from '../../services/workbuddy/provider.js'
import { WORKBUDDY_PROFILE } from '../../services/workbuddy/models.js'
import { useAnchoredPosition, useDismiss } from '../base/anchored.js'
import {
  IconCheckOutline16,
  IconChevronDownOutline14,
  IconChevronRightOutline14,
  IconSettingsOutline16,
} from '../base/icons.js'
import { Modal, ModalPresence } from '../base/Modal.js'
import { POPOVER_EXIT_MS, useMotionPresence } from '../base/motionPresence.js'
import motion from '../base/popoverMotion.module.css'
import { showToast } from '../base/toastState.js'
import { ModePanel } from '../session/ConversationControls.js'
import { useQuickModels, nativeModelName, type Route, type ModelRow } from './quickModels.js'
import './composerModelMenu.css'

type Props = { sessionId: string | null; route: Route; en: boolean; disabled: boolean }

export function ComposerModelMenu({ sessionId, route, en, disabled }: Props) {
  // Remount if a provider changes/renews while its list is on screen.
  return (
    <Menu
      key={JSON.stringify([sessionId, route.destination])}
      {...{ sessionId, route, en, disabled }}
    />
  )
}
function Menu({ sessionId, route, en, disabled }: Props) {
  const mobile = useIsSettingsMobile()
  const [open, setOpen] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const wantsAdvanced = useRef(false)
  const title = en ? 'Choose model' : '选择模型'
  const id = useId()
  const wbName = useWorkBuddyState((state) => {
    if (route.profileId !== WORKBUDDY_PROFILE) {
      return ''
    }
    const row = state.models.find((m) => m.id === route.model)
    if (!row) {
      return ''
    }
    const ambiguous = state.models.some((m) => m.id !== row.id && m.name === row.name)
    return ambiguous ? row.id : row.name
  })
  const name = wbName || nativeModelName(route.model) || (en ? 'Model' : '模型')
  const compactName = name.replace(/^DeepSeek[\s-]+/iu, '') || name
  const leave = () => {
    if (wantsAdvanced.current) {
      wantsAdvanced.current = false
      setAdvanced(true)
    }
  }
  const desktop = open && !mobile && !disabled
  const { present, closing } = useMotionPresence(desktop, POPOVER_EXIT_MS, leave)
  const anchor = useAnchoredPosition<HTMLButtonElement, HTMLDivElement>(present, {
    side: 'top',
    align: 'start',
    offset: 8,
  })
  function dismiss() {
    setOpen(false)
    anchor.anchorRef.current?.focus({ preventScroll: true })
  }
  useDismiss(present, [anchor.anchorRef, anchor.floatingRef], dismiss)
  const positioned = !!anchor.position
  useLayoutEffect(() => {
    if (disabled) {
      setOpen(false)
    }
    if (desktop && positioned) {
      const panel = anchor.floatingRef.current
      const selected = panel?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')
      ;(selected || panel)?.focus({ preventScroll: true })
    }
  }, [anchor.floatingRef, desktop, disabled, positioned])
  const content = (open || present) && (
    <MenuContent
      {...{ sessionId, route, en }}
      disabled={disabled || closing}
      close={dismiss}
      configure={() => {
        wantsAdvanced.current = true
        dismiss()
      }}
    />
  )
  return (
    <>
      <button
        className="composer-model-trigger"
        type="button"
        ref={anchor.anchorRef}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        data-model-menu-trigger
        aria-label={`${title} · ${name}`}
        title={name}
        disabled={disabled}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            setOpen(true)
          }
        }}
      >
        <span className="composer-model-full">{name}</span>
        <span className="composer-model-compact">{compactName}</span>
        <IconChevronDownOutline14 />
      </button>
      <ModalPresence onExited={leave}>
        {open && mobile && !disabled && (
          <Modal title={title} placement="bottom" closable onClose={dismiss}>
            <div id={id} data-quick-model-menu>
              {content}
            </div>
          </Modal>
        )}
      </ModalPresence>
      {present &&
        createPortal(
          <div
            id={id}
            data-quick-model-menu
            data-state={closing ? 'closing' : 'open'}
            tabIndex={-1}
            className={`composer-model-popover ${motion.popover}`}
            ref={anchor.floatingRef}
            style={anchor.position ?? { visibility: 'hidden' }}
            role="dialog"
            aria-label={title}
            onBlur={(e) => {
              if (
                e.relatedTarget instanceof HTMLElement &&
                !e.currentTarget.contains(e.relatedTarget) &&
                e.relatedTarget !== anchor.anchorRef.current
              ) {
                setOpen(false)
              }
            }}
          >
            {content}
          </div>,
          document.body
        )}
      <ModalPresence>
        {advanced && <ModePanel sessionId={sessionId} close={() => setAdvanced(false)} />}
      </ModalPresence>
    </>
  )
}
function MenuContent({
  sessionId,
  route,
  en,
  disabled,
  close,
  configure,
}: Props & { close: () => void; configure: () => void }) {
  const { rows, note } = useQuickModels(route, en)
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(45)
  const needsReview = route.needsApproval || route.missing
  const list = useRef<HTMLDivElement>(null)
  const words = query.trim().toLowerCase().split(/\s+/u)
  const matches = rows.filter((row) => {
    const family =
      route.workbuddy && /^(?:hy[0-9]|hunyuan(?:-|$))/iu.test(row.id) ? ' 混元 hunyuan' : ''
    const label = `${row.name} ${row.id}${family}`.toLowerCase()
    return words.every((word) => label.includes(word))
  })
  // Keep the current choice visible without opening a long catalog halfway down.
  const currentIndex = matches.findIndex((row) => row.id === route.model)
  if (currentIndex > 0) {
    matches.unshift(...matches.splice(currentIndex, 1))
  }
  const provider =
    route.account && en
      ? 'DeepSeek account'
      : route.profile?.name || (en && !route.workbuddy ? 'Default API' : route.name)
  function select(row: ModelRow) {
    const latest = getConversationRoute(sessionId)
    if (
      disabled ||
      latest.needsApproval ||
      latest.missing ||
      latest.destination !== route.destination
    ) {
      return
    }
    try {
      if (
        applyConversationMode(sessionId, {
          ...getConversationMode(sessionId),
          profileId: route.profileId ?? undefined,
          model: row.id,
        })
      ) {
        if (row.live && route.profile) {
          void saveProfileDiscovery(route.profile, row.live).catch(() =>
            showToast(en ? 'Could not save model details' : '未能保存模型参数')
          )
        }
        close()
      }
    } catch {
      showToast(en ? 'Could not save the model selection' : '未能保存选择的模型')
    }
  }
  function keys(e: KeyboardEvent) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') {
      return
    }
    const buttons = Array.from(
      list.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []
    )
    if (buttons.length) {
      e.preventDefault()
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
      const next =
        index < 0
          ? e.key === 'ArrowDown'
            ? 0
            : buttons.length - 1
          : (index + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
      buttons[next]?.focus()
    }
  }
  return (
    <div className="composer-model-panel" onKeyDown={keys}>
      <header>
        <strong>{provider}</strong>
        {note && <small role="status">{note}</small>}
      </header>
      {!needsReview && (rows.length > 6 || query) && (
        <input
          type="search"
          aria-label={en ? 'Search models' : '搜索模型'}
          placeholder={en ? 'Search models' : '搜索模型'}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setLimit(45)
          }}
        />
      )}
      {!needsReview && (
        <div
          ref={list}
          className="composer-model-list"
          role="listbox"
          aria-label={en ? 'Available models' : '可选模型'}
        >
          {matches.slice(0, limit).map((r) => (
            <button
              type="button"
              role="option"
              aria-selected={route.model === r.id}
              key={r.id}
              data-model-id={r.id}
              disabled={disabled}
              onClick={() => select(r)}
            >
              <span className="composer-model-name">
                <strong>{r.name}</strong>
                {r.detail && <small>{r.detail}</small>}
              </span>
              {r.price && (
                <span className="composer-model-price" data-free={r.free || undefined}>
                  {r.price}
                </span>
              )}
              <span className="composer-model-check">
                {route.model === r.id && <IconCheckOutline16 />}
              </span>
            </button>
          ))}
        </div>
      )}
      {!needsReview && matches.length > limit && (
        <button className="composer-model-more" type="button" onClick={() => setLimit(limit + 60)}>
          {en ? 'Show more' : '显示更多'}
        </button>
      )}
      {(needsReview || !matches.length) && (
        <p role="status">
          {needsReview
            ? en
              ? 'Review this provider to choose a model.'
              : '请先确认此会话的服务方案。'
            : en
              ? 'No matching models'
              : '没有匹配的模型'}
        </p>
      )}
      <button className="composer-model-configure" type="button" onClick={configure}>
        <IconSettingsOutline16 />
        <span>{en ? 'Providers and templates' : '服务方案与模板'}</span>
        <IconChevronRightOutline14 />
      </button>
    </div>
  )
}
