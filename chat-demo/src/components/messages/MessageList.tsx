import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import {
  buildMessageVersions,
  getVisibleMessages,
  type MessageVersions,
} from '../../services/chat/branches.js'
import {
  deleteMessage,
  previewMessageDeletion,
  selectMessageVersion,
} from '../../services/chat/store.js'
import { getSearchableMessageText } from '../../services/chat/search.js'
import { isReplyForQuestion } from '../../services/chat/reply.js'
import type { Session } from '../../services/chat/types.js'
import { closeSearchPanel } from '../search/searchPanelState.js'
import { Button } from '../base/Button.js'
import { IconCheckOutline16 } from '../base/icons.js'
import { ConfirmationModal, ModalPresence } from '../base/Modal.js'
import { AssistantMessage } from './AssistantMessage.js'
import { UserMessage } from './UserMessage.js'
import { useMessageTools } from './MessageTools.js'
import { clearHistoryLocation, useHistorySearch } from '../historySearch/historySearchState.js'
import { SearchHighlight } from '../historySearch/SearchHighlight.js'
import { highlightMessageText, keepMessageAnchored } from '../historySearch/messageAnchor.js'
import type { Message } from '../../services/chat/types.js'

/**
 * 会话共用可重试的附件上传失败入口，覆盖当前提问与历史消息中的附件。
 * 点击后按失败的回答重新补传附件并请求。
 */
const getUploadRetryId = (messages: Message[], streaming: boolean) => {
  const last = messages.at(-1)
  return !streaming &&
    last?.role === 'assistant' &&
    last.status === 'error' &&
    last.error?.kind === 'upload' &&
    last.error.retryable
    ? last.id
    : null
}
import styles from './MessageList.module.css'

/** 距底部小于该值时视为在底部，流式内容增长时跟随 */
const STICKY_THRESHOLD = 40
const EMPTY_VERSIONS: MessageVersions = { ids: [], index: -1 }
const canRegenerateAt = (messages: Message[], index: number): boolean => {
  const reply = messages[index]
  const question = messages[index - 1]
  return (
    reply?.role === 'assistant' && question?.role === 'user' && isReplyForQuestion(reply, question)
  )
}

const DeleteMessageDialog = ({
  session,
  messageId,
  onClose,
}: {
  session: Session
  messageId: string
  onClose: () => void
}) => {
  const t = useTranslate()
  const [mode, setMode] = useState<'single' | 'following'>('single')
  const [step, setStep] = useState<1 | 2 | 3>(1)
  const cancelId = useId()
  useLayoutEffect(() => {
    document.getElementById(cancelId)?.focus({ preventScroll: true })
  }, [step, cancelId])
  const [error, setError] = useState<string | null>(null)
  const [coolingDown, setCoolingDown] = useState(false)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const guardUntilRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const confirmedIdsRef = useRef<string[] | null>(null)
  const preview = previewMessageDeletion(session, messageId, mode)
  const ids = new Set(preview.messageIds)
  const selectedMessages = session.messages.filter((message) => ids.has(message.id))
  const visible = new Set(getVisibleMessages(session).map((message) => message.id))
  const hiddenCount = preview.messageIds.filter((id) => !visible.has(id)).length
  const sameRange = (first: string[], second: string[]) =>
    first.length === second.length && first.every((id) => ids.has(id))
  useEffect(
    () => () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
      }
    },
    []
  )

  const confirm = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (
      event.detail > 1 ||
      busyRef.current ||
      performance.now() < guardUntilRef.current ||
      !preview.messageIds.length
    ) {
      return
    }
    if (
      step > 1 &&
      confirmedIdsRef.current &&
      !sameRange(confirmedIdsRef.current, preview.messageIds)
    ) {
      confirmedIdsRef.current = null
      setStep(1)
      setError(t('deleteRangeChanged'))
      return
    }
    if (step < 3) {
      if (step === 1) {
        confirmedIdsRef.current = [...preview.messageIds]
      }
      setError(null)
      setStep(step === 1 ? 2 : 3)
      guardUntilRef.current = performance.now() + 400
      setCoolingDown(true)
      timerRef.current = setTimeout(() => setCoolingDown(false), 400)
      return
    }
    busyRef.current = true
    setBusy(true)
    let deleted = false
    try {
      deleted = deleteMessage(session.id, messageId, mode, confirmedIdsRef.current ?? undefined)
    } catch {
      // Preserve the confirmation surface and allow a retry if the operation cannot complete.
    }
    if (deleted) {
      const location = useHistorySearch.getState().location
      if (location?.sessionId === session.id && ids.has(location.messageId)) {
        clearHistoryLocation()
      }
      onClose()
    } else {
      busyRef.current = false
      setBusy(false)
      setStep(1)
      confirmedIdsRef.current = null
      setError(t('deleteMessageUnavailable'))
    }
  }

  return (
    <ConfirmationModal
      title={t('deleteConfirmTitle', { step })}
      onClose={() => {
        if (!busyRef.current) {
          onClose()
        }
      }}
      footer={
        <>
          <Button id={cancelId} variant="outlined" disabled={busy} onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            key={step}
            variant={step === 3 ? 'danger' : 'primary'}
            disabled={busy || coolingDown || !preview.messageIds.length}
            onClick={confirm}
          >
            {t(
              step === 1
                ? 'deleteConfirmFirst'
                : step === 2
                  ? 'deleteConfirmSecond'
                  : 'deleteConfirmFinal'
            )}
          </Button>
        </>
      }
    >
      <div className={styles.deleteMessageText}>
        <p role="status" aria-live="polite">
          {t(step === 1 ? 'deleteStepOne' : step === 2 ? 'deleteStepTwo' : 'deleteStepThree')}
        </p>
        {step === 1 ? (
          <fieldset className={styles.deleteScopes}>
            <legend>{t('deleteScopeLabel')}</legend>
            {(['single', 'following'] as const).map((scope) => (
              <label key={scope} className={styles.deleteScope}>
                <input
                  type="radio"
                  name="delete-message-scope"
                  value={scope}
                  checked={mode === scope}
                  onChange={() => {
                    setMode(scope)
                    setError(null)
                  }}
                />
                <span>
                  <strong>
                    {t(scope === 'single' ? 'deleteScopeSingle' : 'deleteScopeFollowing')}
                  </strong>
                  <span>
                    {t(scope === 'single' ? 'deleteScopeSingleHint' : 'deleteScopeFollowingHint')}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
        ) : (
          <p className={styles.deleteMode}>
            {t(mode === 'single' ? 'deleteScopeSingle' : 'deleteScopeFollowing')}
          </p>
        )}
        <p className={styles.deleteCount}>
          {t('deleteScopeCount', { count: preview.messageIds.length })}
        </p>
        {hiddenCount ? <p>{t('deleteScopeHidden', { count: hiddenCount })}</p> : null}
        <ol className={styles.deletePreview}>
          {selectedMessages.slice(0, 3).map((message) => (
            <li key={message.id}>
              <span className={styles.deleteRole}>
                {t(message.role === 'user' ? 'historySearchUser' : 'historySearchAssistant')}
              </span>
              <span>
                {getSearchableMessageText(message).replace(/\s+/g, ' ').trim().slice(0, 140) ||
                  t('deletePreviewEmpty')}
              </span>
            </li>
          ))}
        </ol>
        {selectedMessages.length > 3 ? (
          <p>{t('deletePreviewMore', { count: selectedMessages.length - 3 })}</p>
        ) : null}
        {error || !preview.messageIds.length ? (
          <p role="alert">{error ?? t('deleteMessageUnavailable')}</p>
        ) : null}
      </div>
    </ConfirmationModal>
  )
}

export const MessageList = ({
  session,
  streaming,
  footer,
}: {
  session: Session
  streaming: boolean
  footer: React.ReactNode
}) => {
  const isMobile = useIsMobile()
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const stickyRef = useRef(true)
  const searchAnchoredRef = useRef(false)
  const releasedSearchRequestRef = useRef<number | null>(null)
  const location = useHistorySearch((state) => state.location)
  const located = location?.sessionId === session.id ? location : null
  const scrollTopRef = useRef(0)
  const restoreScrollRef = useRef<{ messageId: string; top: number } | null>(null)
  const t = useTranslate()
  const messages = getVisibleMessages(session)
  const tools = useMessageTools(session.id, messages)
  const [pendingDelete, setPendingDelete] = useState<Message | null>(null)
  useEffect(() => setPendingDelete(null), [session.id])
  const [previousVersions, setPreviousVersions] = useState(() =>
    buildMessageVersions(session, new Map())
  )
  const versions = useMemo(
    () => buildMessageVersions(session, previousVersions),
    [session, previousVersions]
  )
  if (versions !== previousVersions) {
    setPreviousVersions(versions)
  }
  const lastMessageId = messages.at(-1)?.id
  const previousPathRef = useRef({
    sessionId: session.id,
    lastMessageId,
    requestId: located?.requestId,
  })
  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current
    if (el && stickyRef.current) {
      el.scrollTop = el.scrollHeight
      scrollTopRef.current = el.scrollTop
    }
  }, [])

  // 内容、键盘和输入框高度变化时，继续遵循当前跟随状态。
  useLayoutEffect(() => {
    const content = contentRef.current
    const scroll = scrollRef.current
    if (!content || !scroll) {
      return
    }
    const observer = new ResizeObserver(scrollToBottom)
    observer.observe(content)
    observer.observe(scroll)
    return () => observer.disconnect()
  }, [isMobile, scrollToBottom])

  // 切换版本后将选择器留在原位置，避免回答长短变化导致操作区跳出视口。
  useLayoutEffect(() => {
    const anchor = restoreScrollRef.current
    const scroll = scrollRef.current
    if (anchor && scroll) {
      const switcher = scroll.querySelector<HTMLElement>(
        `[data-message-version="${CSS.escape(anchor.messageId)}"]`
      )
      if (switcher) {
        scroll.scrollTop += switcher.getBoundingClientRect().top - anchor.top
      }
      restoreScrollRef.current = null
      return
    }
    if (useHistorySearch.getState().location?.sessionId === session.id) {
      stickyRef.current = false
      return
    }
    stickyRef.current = true
    scrollToBottom()
  }, [session.id, lastMessageId, scrollToBottom])

  useLayoutEffect(() => {
    const scroll = scrollRef.current
    const content = contentRef.current
    if (!located || !scroll || !content || releasedSearchRequestRef.current === located.requestId) {
      return
    }
    const target = content.querySelector<HTMLElement>(
      `[data-message-id="${CSS.escape(located.messageId)}"]`
    )
    if (!target) {
      return
    }
    stickyRef.current = false
    searchAnchoredRef.current = true
    const stop = keepMessageAnchored(scroll, content, target, () => {
      releasedSearchRequestRef.current = located.requestId
      searchAnchoredRef.current = false
      stickyRef.current = false
      scrollTopRef.current = scroll.scrollTop
    })
    scrollTopRef.current = scroll.scrollTop
    target.focus({ preventScroll: true })
    return () => {
      searchAnchoredRef.current = false
      stop()
    }
  }, [located, isMobile])

  // A newly sent message resumes the normal follow-to-bottom behavior after search.
  useLayoutEffect(() => {
    const previous = previousPathRef.current
    previousPathRef.current = {
      sessionId: session.id,
      lastMessageId,
      requestId: located?.requestId,
    }
    if (
      located &&
      previous.sessionId === session.id &&
      previous.lastMessageId !== lastMessageId &&
      previous.requestId === located.requestId
    ) {
      clearHistoryLocation()
      stickyRef.current = true
      scrollToBottom()
    }
  }, [session.id, lastMessageId, located, scrollToBottom])

  const locatedMessage = located
    ? session.messages.find((message) => message.id === located.messageId)
    : undefined
  useLayoutEffect(() => {
    const target =
      located &&
      contentRef.current?.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(located.messageId)}"]`
      )
    if (target && located) {
      return highlightMessageText(target, located.query)
    }
    return undefined
  }, [located, locatedMessage])

  useEffect(closeSearchPanel, [session.id, lastMessageId])

  const selectVersion = useCallback(
    (messageId: string, anchorTop: number) => {
      if (streaming) {
        return
      }
      clearHistoryLocation()
      restoreScrollRef.current = { messageId, top: anchorTop }
      stickyRef.current = false
      closeSearchPanel()
      selectMessageVersion(session.id, messageId)
    },
    [session.id, streaming]
  )

  // 跨移动端断点时切换滚动层，并保持输入框及当前阅读位置。
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) {
      return
    }
    if (stickyRef.current) {
      scrollToBottom()
    } else {
      el.scrollTop = scrollTopRef.current
    }
    const onScroll = () => {
      if (searchAnchoredRef.current) {
        scrollTopRef.current = el.scrollTop
        return
      }
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICKY_THRESHOLD
      // 仅在用户向上滚动时停止跟随底部，布局或内容增高时保持跟随状态。
      if (nearBottom) {
        stickyRef.current = true
      } else if (el.scrollTop < scrollTopRef.current) {
        stickyRef.current = false
      }
      scrollTopRef.current = el.scrollTop
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [isMobile, scrollToBottom])

  const lastIndex = messages.length - 1
  const uploadRetryId = getUploadRetryId(messages, streaming)
  return (
    <>
      <div ref={isMobile ? undefined : scrollRef} className={styles.container}>
        <div ref={isMobile ? scrollRef : undefined} className={styles.scroll}>
          <div ref={contentRef} className={styles.column} {...tools.handlers}>
            {messages.map((message, index) => (
              <div
                key={message.id}
                data-message-id={message.id}
                tabIndex={-1}
                data-selecting={tools.selecting || undefined}
                data-selected={tools.selected?.has(message.id) || undefined}
                className={located?.messageId === message.id ? styles.locatedMessage : undefined}
              >
                {tools.selecting && (
                  <label className="dc-message-selector">
                    <input
                      type="checkbox"
                      checked={tools.selected?.has(message.id) ?? false}
                      aria-label={tools.label(index)}
                      aria-describedby={`message-body-${message.id}`}
                      onChange={() => tools.toggle(message.id)}
                    />
                    <span className="dc-selection-check" aria-hidden="true">
                      <IconCheckOutline16 />
                    </span>
                  </label>
                )}
                <div
                  className="dc-message-content"
                  id={`message-body-${message.id}`}
                  {...(tools.selecting ? { inert: '' } : {})}
                >
                  {located?.messageId === message.id ? (
                    <div className={styles.locationLabel} data-search-location-label>
                      <div className={styles.locationHeading}>
                        <span>
                          {t(located.query ? 'historySearchLocated' : 'libFavoriteReply')}
                        </span>
                        <button type="button" onClick={clearHistoryLocation}>
                          {t('historySearchClearLocation')}
                        </button>
                      </div>
                      <div>
                        {located.snippet.before ? '…' : ''}
                        <SearchHighlight text={located.snippet.text} query={located.query} />
                        {located.snippet.after ? '…' : ''}
                      </div>
                    </div>
                  ) : null}
                  {message.role === 'user' ? (
                    <UserMessage
                      key={message.id}
                      sessionId={session.id}
                      message={message}
                      retryUploadId={uploadRetryId}
                      isFirst={index === 0}
                      isLast={index === lastIndex || index === lastIndex - 1}
                      busy={streaming}
                      versions={versions.get(message.id) ?? EMPTY_VERSIONS}
                      onSelectVersion={selectVersion}
                      onDelete={setPendingDelete}
                      onOpenMenu={tools.open}
                    />
                  ) : (
                    <AssistantMessage
                      key={message.id}
                      sessionId={session.id}
                      message={message}
                      canRegenerate={canRegenerateAt(messages, index)}
                      isLast={index === lastIndex}
                      streaming={streaming && index === lastIndex}
                      busy={streaming}
                      versions={versions.get(message.id) ?? EMPTY_VERSIONS}
                      onSelectVersion={selectVersion}
                      onDelete={setPendingDelete}
                      onOpenMenu={tools.open}
                    />
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
        <div style={{ display: tools.selecting ? 'none' : 'contents' }}>{footer}</div>
        {tools.controls}
      </div>
      {tools.dialogs}
      <ModalPresence>
        {pendingDelete ? (
          <DeleteMessageDialog
            key={`${session.id}:${pendingDelete.id}`}
            session={session}
            messageId={pendingDelete.id}
            onClose={() => setPendingDelete(null)}
          />
        ) : null}
      </ModalPresence>
    </>
  )
}
