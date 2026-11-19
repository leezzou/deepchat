import clsx from 'clsx'
import { memo, useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import {
  IconArrowUp24,
  IconGlobeLanguageOutline14,
  IconPaperclipOutline16,
  IconPlusCircle24,
  IconSendOutline16,
  IconStopFill16,
  IconThinkOutline14,
} from '../base/icons.js'
import { setSearch, setThinking, useSettings } from '../../services/settings.js'
import {
  useConversationModes,
  getConversationMode,
  setConversationMode,
} from '../../services/conversationMode/storage.js'
import { useWorkBuddyState } from '../../services/workbuddy/provider.js'
import { getConversationRoute, requireChatAccess } from '../../services/api/access.js'
import { useIsMobile } from '../../app/viewport.js'
import { sendMessage, stopReply, useChatStore } from '../../services/chat/store.js'
import {
  addDraftFiles,
  EMPTY_DRAFT,
  getDraft,
  prepareDraftMessage,
  removeDraftAttachment,
  retryDraftAttachment,
  setDraftText,
  useDrafts,
} from '../../services/chat/drafts.js'
import { stopReadAloud } from '../../services/speech/readAloud.js'
import { IconButton } from '../base/IconButton.js'
import { Tooltip } from '../base/Tooltip.js'
import { ensureApiKey } from '../settings/settingsDialogState.js'
import { DragMask, useFileDrop } from './DragMask.js'
import { showToast } from '../base/toastState.js'
import { ACCEPT, useUploads, validateFiles } from '../../services/attachments.js'
import { DraftAttachments } from './DraftAttachments.js'
import { useVoiceInput } from './useVoiceInput.js'
import { VoiceButton } from './VoiceButton.js'
import { Spectrum } from './Spectrum.js'
import { resolveLocale, useTranslate } from '../../i18n/index.js'
import { usePendingEdit } from '../../services/pendingEdits.js'
import styles from './ChatInput.module.css'

/** 输入框：自适应高度的文本框 + 文件 + 深度思考与智能搜索开关 + 语音输入 + 发送 / 停止 */
export const ChatInput = memo(function ChatInput({ sessionId }: { sessionId: string | null }) {
  // 切换目标时释放录音、转写和 DOM 状态；文字与附件由草稿服务保留。
  return <Input key={sessionId === null ? 'new' : `session:${sessionId}`} sessionId={sessionId} />
})

const Input = ({ sessionId }: { sessionId: string | null }) => {
  const t = useTranslate()
  const english = useSettings((s) => resolveLocale(s.locale) === 'en-US')
  const draft = useDrafts((state) => state.drafts.get(sessionId) ?? EMPTY_DRAFT)
  const { text, attachments } = draft
  const setText = (value: string) => {
    // Pin a welcome draft to the destination visible when its author starts typing.
    const route = getConversationRoute(sessionId)
    if (sessionId === null && value && route.profileId && !getConversationMode(null).profileId) {
      try {
        setConversationMode(
          null,
          { ...getConversationMode(null), profileId: route.profileId },
          route.destination
        )
      } catch {
        showToast(
          english
            ? 'Could not save the conversation settings. Try again.'
            : '未能保存会话方案，请重试。'
        )
      }
    }
    setDraftText(sessionId, value)
  }
  const draftReady = useUploads((state) => prepareDraftMessage(draft, state.tasks) !== null)
  const streaming = useChatStore(
    (state) =>
      sessionId !== null &&
      (Object.hasOwn(state.streaming, sessionId) || Object.hasOwn(state.compacting, sessionId))
  )
  const thinking = useSettings((state) => state.thinking)
  const importingHistory = useChatStore((state) => state.importingHistory)
  const isMobile = useIsMobile()
  const search = useSettings((state) => state.search)
  useSettings((state) => state.apiProfiles)
  useSettings((state) => state.activeProfileId)
  useSettings((state) => state.chatSource)
  useWorkBuddyState((state) => state.metadata)
  useConversationModes()
  const route = getConversationRoute(sessionId)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const togglesRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const toggles = togglesRef.current
    if (!toggles) {
      return
    }

    const updateLabels = () => {
      toggles.classList.remove(styles.collapsedToggles)
      toggles.classList.toggle(styles.collapsedToggles, toggles.scrollWidth > toggles.clientWidth)
    }

    updateLabels()
    const observer = new ResizeObserver(updateLabels)
    observer.observe(toggles)
    return () => observer.disconnect()
  }, [t])

  const acceptFiles = (files: File[]) => {
    if (
      files.length === 0 ||
      useChatStore.getState().importingHistory ||
      !ensureApiKey(sessionId)
    ) {
      return
    }
    if (!route.files) {
      showToast({ key: 'uploadFileModel' })
      return
    }
    if (!getConversationMode(sessionId).profileId && route.profileId) {
      try {
        setConversationMode(
          sessionId,
          { ...getConversationMode(sessionId), profileId: route.profileId },
          route.destination
        )
      } catch {
        showToast(
          english
            ? 'Could not save the conversation settings. Try again.'
            : '未能保存会话方案，请重试。'
        )
        return
      }
    }
    const error = addDraftFiles(sessionId, files, requireChatAccess(sessionId))
    if (error) {
      showToast(error)
    }
  }
  const retryFile = useCallback(
    (id: string) => {
      if (!useChatStore.getState().importingHistory && ensureApiKey(sessionId)) {
        retryDraftAttachment(sessionId, id, requireChatAccess(sessionId))
      }
    },
    [sessionId]
  )
  const removeFile = useCallback(
    (id: string) => {
      if (!useChatStore.getState().importingHistory) {
        removeDraftAttachment(sessionId, id)
      }
    },
    [sessionId]
  )
  const dragging = useFileDrop(acceptFiles)

  /** 转写结果插入到光标处，并把光标移到插入内容之后 */
  const voice = useVoiceInput(sessionId, (transcript) => {
    const textarea = textareaRef.current
    const current = getDraft(sessionId).text
    const start = textarea?.selectionStart ?? current.length
    const end = textarea?.selectionEnd ?? current.length
    setText(current.slice(0, start) + transcript + current.slice(end))
    requestAnimationFrame(() => {
      textarea?.focus({ preventScroll: true })
      textarea?.setSelectionRange(start + transcript.length, start + transcript.length)
    })
  })

  // 欢迎页导入后会话 ID 不变，不能依赖卸载取消语音；订阅开始事件也覆盖快速完成的导入。
  const cancelVoice = voice.cancel
  useEffect(
    () =>
      useChatStore.subscribe((state, previous) => {
        if (state.importingHistory && !previous.importingHistory) {
          cancelVoice()
        }
      }),
    [cancelVoice]
  )

  // 移动端录音时用频谱替代输入框内容
  const recording = voice.status === 'recording'
  usePendingEdit(voice.status !== 'idle')

  // 排队、上传中或上传失败的附件都留在输入框，全部上传成功后才能发送
  const canSend = !importingHistory && !streaming && voice.status === 'idle' && draftReady
  // 附件也可以单独发送。上传期间显示禁用的发送键，直到全部附件就绪。
  const hasDraftContent = text.trim().length > 0 || attachments.length > 0

  const send = () => {
    if (
      useChatStore.getState().importingHistory ||
      voice.status !== 'idle' ||
      !prepareDraftMessage(getDraft(sessionId), useUploads.getState().tasks)
    ) {
      return
    }
    // 文本与上传完成态由提交动作读取最新快照，不使用上一次渲染的草稿。
    if (route.needsApproval || route.missing) {
      showToast(
        english
          ? 'Review the provider in the conversation header.'
          : '请在会话顶栏检查模型并确认服务方案。'
      )
      return
    }
    if (!ensureApiKey(sessionId)) {
      return
    }
    if (attachments.length) {
      if (!route.files) {
        showToast({ key: 'uploadFileModel' })
        return
      }
      const issue = validateFiles(
        attachments.map((item) => item.file),
        [],
        requireChatAccess(sessionId)
      )
      if (issue) {
        showToast(issue)
        return
      }
    }
    try {
      if (!sendMessage(sessionId)) {
        return
      }
    } catch {
      showToast(
        english
          ? 'Could not save the conversation settings. Your draft is still here.'
          : '未能保存会话方案，草稿已保留。'
      )
      return
    }
    stopReadAloud()
    if (isMobile) {
      textareaRef.current?.blur()
    } else {
      textareaRef.current?.focus()
    }
  }

  return (
    <div
      className={clsx(styles.wrapper, sessionId === null ? styles.home : styles.session)}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          textareaRef.current?.focus({ preventScroll: true })
        }
      }}
    >
      <DraftAttachments items={attachments} onRetry={retryFile} onRemove={removeFile} />
      <div className={styles.textareaWrapper}>
        <textarea
          ref={textareaRef}
          className={clsx(styles.textarea, recording && isMobile && styles.textareaHidden)}
          aria-label={english ? 'Message' : '消息'}
          placeholder={
            isMobile
              ? attachments.length
                ? english
                  ? 'Add a message (optional)'
                  : '补充说明（可选）'
                : english
                  ? 'Message DeepSeek'
                  : '给 DeepSeek 发消息'
              : t('chatInputPlaceholderChat')
          }
          rows={2}
          // 移动端不自动聚焦，避免一打开就弹出键盘
          autoFocus={!isMobile}
          disabled={importingHistory}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onMouseDown={(event) => {
            // 首次点击时手动聚焦，避免 Safari 把整个页面滚到输入框位置。
            if (isMobile && event.button === 0 && document.activeElement !== event.currentTarget) {
              event.preventDefault()
              event.currentTarget.focus({ preventScroll: true })
            }
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              send()
            }
          }}
          onPaste={(event) => {
            const files = Array.from(event.clipboardData.files)
            if (files.length > 0) {
              event.preventDefault()
              acceptFiles(files)
            }
          }}
        />
        {recording && isMobile ? <Spectrum getAnalyser={voice.getAnalyser} /> : null}
        <div className={styles.mirror} aria-hidden>
          {`${text}\n`}
        </div>
      </div>
      <div className={styles.functionRow}>
        {/* 深度思考 / 智能搜索开关，tooltip 在按钮上方 */}
        <div ref={togglesRef} className={styles.toggles}>
          <Tooltip content={t('deactivatedThinkTooltip')}>
            <button
              type="button"
              className={clsx(styles.toggle, route.thinking && thinking && styles.selected)}
              aria-label={t('thinkingSwitch')}
              aria-pressed={route.thinking && thinking}
              disabled={!route.thinking}
              onClick={() => setThinking(!thinking)}
            >
              <IconThinkOutline14 />
              <span className={styles.toggleLabel}>{t('thinkingSwitch')}</span>
            </button>
          </Tooltip>
          <Tooltip content={route.workbuddy
            ? english ? 'Search WorkBuddy with this question before answering' : '先用本轮问题在 WorkBuddy 搜索，再结合来源回答'
            : t('deactivatedSearchTooltip')}>
            <button
              type="button"
              className={clsx(styles.toggle, route.search && search && styles.selected)}
              aria-label={t('search')}
              aria-pressed={route.search && search}
              disabled={!route.search}
              onClick={() => setSearch(!search)}
            >
              <IconGlobeLanguageOutline14 />
              <span className={styles.toggleLabel}>{t('search')}</span>
            </button>
          </Tooltip>
        </div>
        <div className={styles.right}>
          <IconButton
            size="m"
            tone="primary"
            icon={isMobile ? <IconPlusCircle24 /> : <IconPaperclipOutline16 />}
            tooltip={t('uploadFile')}
            disabled={importingHistory || !route.files}
            onClick={() => ensureApiKey(sessionId) && fileInputRef.current?.click()}
          />
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            accept={ACCEPT}
            onChange={(event) => {
              acceptFiles(Array.from(event.target.files ?? []))
              event.target.value = ''
            }}
          />
          {/* 移动端有文字时语音键让位给发送键（官方交互） */}
          {!isMobile || (!streaming && !hasDraftContent) || voice.status !== 'idle' ? (
            <VoiceButton
              status={voice.status}
              disabled={!voice.available || !route.speech}
              seconds={voice.seconds}
              onClick={() => {
                if (
                  voice.status !== 'idle' ||
                  (!useChatStore.getState().importingHistory && ensureApiKey(sessionId))
                ) {
                  void voice.toggle()
                }
              }}
            />
          ) : null}
          {streaming && sessionId ? (
            <button
              type="button"
              className={styles.sendButton}
              aria-label={t('chatInputStopButtonTooltip')}
              onClick={() => {
                stopReadAloud()
                stopReply(sessionId)
              }}
            >
              <IconStopFill16 />
            </button>
          ) : isMobile && !hasDraftContent ? null : (
            <button
              type="button"
              className={clsx(styles.sendButton, !canSend && styles.disabled)}
              aria-label={t('send')}
              disabled={!canSend}
              onClick={send}
            >
              {isMobile ? <IconArrowUp24 /> : <IconSendOutline16 />}
            </button>
          )}
        </div>
      </div>
      {dragging ? <DragMask /> : null}
    </div>
  )
}
