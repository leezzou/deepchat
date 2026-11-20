import { create } from 'zustand'
import { endpointProvider, warmModelWindows } from '../api/modelWindows.js'
import { isDeepSeekApiOrigin } from '../api/providerParity.js'
import { createId } from '../../utils/id.js'
import { ApiError, streamMessage } from '../api/client.js'
import {
  getChatAccess,
  getConversationRoute,
  requireChatAccess,
  type ChatAccess,
} from '../api/access.js'
import type { CreateMessageRequest } from '../api/types.js'
import {
  extractFileIds,
  getFileErrorCode,
  isRetryableApiError,
  isContextOverflow,
} from '../api/errors.js'
import { cancelUpload, describeUploadError, uploadAttachment, useUploads } from '../attachments.js'
import { usesDeepSeekFileLimits } from '../attachmentLimits.js'
import { isOpenAiFiles, OPENAI_FILE_BYTES, originalFileIssue } from '../api/fileCapabilities.js'
import {
  getConversationMode,
  setConversationMode,
  promoteConversationMode,
  removeConversationMode,
  flagUnboundSessions,
  type ConversationMode,
} from '../conversationMode/storage.js'
import { conversationInstructions } from '../conversationMode/prompt.js'
import { promoteLibraryDraft, removeLibrarySession, setDraftFolder } from '../library/index.js'
import { promoteSearchGrant } from '../api/searchConsent.js'
import { useSettings } from '../settings.js'
import { resolveLocale } from '../../i18n/index.js'
import { appendBranch, getVisibleMessages, normalizeSession, selectVersion } from './branches.js'
import * as db from './db.js'
import { historyTopic, needsTopic, providerTitle, questionTopic, refineTopic } from './titles.js'
import {
  clearAllDrafts,
  clearDraft,
  clearSentDraft,
  getDraft,
  prepareDraftMessage,
} from './drafts.js'
import { createLatestReminder } from './latestReminder.js'
import { useContextPreferences } from './contextPreferences.js'
import { estimateRequestTokens, estimateTokens, indexRequestFiles, requestFileLimit } from './contextBudget.js'
import { createContextBatcher } from './contextStreamBatcher.js'
import { buildMessageDeletion, type MessageDeletionMode } from './contextDeletion.js'
export { previewMessageDeletion, type MessageDeletionMode } from './contextDeletion.js'
import {
  applyEvent,
  canContinueReply,
  getContextRounds,
  getEffectiveContext,
  isReplyForQuestion,
  settleReply,
  toRequestMessages,
} from './reply.js'
import {
  toSessionSummary,
  type AssistantMessage,
  type FileAttachment,
  type Message,
  type Session,
  type SessionSummary,
  type UserMessage,
} from './types.js'

/** 保留最近打开的详情；当前会话、生成中及尚未成功保存的会话不淘汰。 */
const SESSION_CACHE_LIMIT = 5
/** 安全审核固定开启，所有请求都走扩展模式 */
const SAFETY_CHECK = { level: 'high' } as const
/** 服务端判定 file_id 失效后，重新补传并重发的最多次数（不含首次请求） */
const FILE_RETRY_LIMIT = 2
/** 退避基数，第 n 次重试等待 2^n 倍；连续失败达到上限就放弃，把原始报错展示出来 */
const FILE_RETRY_BASE_DELAY = 1000

/** 阅读链接始终开启，智能搜索开关控制是否另行声明搜索工具（含边想边搜）。 */
const serverTools = (search: boolean): CreateMessageRequest['tools'] => {
  const tools: CreateMessageRequest['tools'] = [
    { type: 'deepseek_read_url', name: 'deepseek_read_url' },
  ]
  if (search) {
    tools.push({ type: 'deepseek_web_search', name: 'deepseek_web_search' })
  }
  return tools
}

/** Optional title-only requests run separately from the foreground response. */
const titleJobs = new Map<string, AbortController>()

type ChatState = {
  ready: boolean
  initError: boolean
  /** 历史导入或全部删除期间锁定交互，提交成功前仍展示原有记录。 */
  importingHistory: boolean
  /** 仅列表元数据，按 updatedAt 降序；流式消息更新不会改变此数组。 */
  sessions: SessionSummary[]
  sessionCache: Record<string, Session>
  sessionLoadErrors: Record<string, boolean>
  sessionSaveErrors: Record<string, boolean>
  /** null 表示新对话（欢迎页） */
  activeId: string | null
  /** 正在生成回复的会话 */
  streaming: Record<string, AbortController>
  /** 手动/自动摘要共享会话锁，可取消；不写入磁盘。 */
  compacting: Record<string, AbortController>
  contextErrors: Record<string, string>
}

export const useChatStore = create<ChatState>(() => ({
  ready: false,
  initError: false,
  importingHistory: false,
  sessions: [],
  sessionCache: {},
  sessionLoadErrors: {},
  sessionSaveErrors: {},
  activeId: null,
  streaming: {},
  compacting: {},
  contextErrors: {},
}))

const { getState: get, setState: set } = useChatStore

const sortSessions = (sessions: SessionSummary[]) =>
  [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)

const getSession = (id: string) => {
  const cache = get().sessionCache
  return Object.hasOwn(cache, id) ? cache[id] : undefined
}

const getStreamController = (id: string) => {
  const streams = get().streaming
  return Object.hasOwn(streams, id) ? streams[id] : undefined
}

const isSessionBusy = (id: string) => Boolean(getStreamController(id) || get().compacting[id])

export const cancelCompaction = (id: string) => get().compacting[id]?.abort()

const sameSummary = (a: SessionSummary, b: SessionSummary) =>
  a.title === b.title && a.titleSource === b.titleSource && a.createdAt === b.createdAt && a.updatedAt === b.updatedAt

const sessionAccess = new Map<string, number>()
const unsavedSessions = new Set<string>()
/** 保存失败时保留原件，重试成功后才释放。 */
const pendingFiles = new Map<string, db.StoredFile[]>()
/** 删除消息后待清理的附件 id；随下一次会话保存一起处理。 */
const pendingFileDeletes = new Map<string, Set<string>>()
const deletingSessions = new Set<string>()
const deletionTasks = new Set<Promise<boolean>>()
const streamFlushes = new Map<string, () => void>()
const pendingSaves = new Set<Promise<void>>()
let accessSequence = 0
let historyEpoch = 0
let initTask: Promise<void> | undefined
const sessionLoads = new Map<string, { promise: Promise<void> }>()

const touchSession = (id: string) => sessionAccess.set(id, ++accessSequence)

const trimSessionCache = () => {
  const state = get()
  const ids = Object.keys(state.sessionCache)
  if (ids.length <= SESSION_CACHE_LIMIT) {
    return
  }
  const removable = ids
    .filter(
      (id) =>
        id !== state.activeId &&
        !Object.hasOwn(state.streaming, id) &&
        !titleJobs.has(id) &&
        !unsavedSessions.has(id) &&
        !deletingSessions.has(id)
    )
    .sort((a, b) => (sessionAccess.get(a) ?? 0) - (sessionAccess.get(b) ?? 0))
  const evicted = new Set(removable.slice(0, ids.length - SESSION_CACHE_LIMIT))
  for (const id of evicted) {
    sessionAccess.delete(id)
  }
  if (evicted.size > 0) {
    set({
      sessionCache: Object.fromEntries(
        Object.entries(state.sessionCache).filter(([id]) => !evicted.has(id))
      ),
    })
  }
}

const updateSession = (id: string, update: (session: Session) => Session) =>
  set((state) => {
    const previous = Object.hasOwn(state.sessionCache, id) ? state.sessionCache[id] : undefined
    if (!previous) {
      return state
    }
    const session = update(previous)
    if (session === previous) {
      return state
    }
    return {
      sessionCache: { ...state.sessionCache, [id]: session },
      sessions: sameSummary(previous, session)
        ? state.sessions
        : sortSessions(
            state.sessions.map((summary) =>
              summary.id === id ? toSessionSummary(session) : summary
            )
          ),
    }
  })

const updateReply = (sessionId: string, reply: AssistantMessage) =>
  updateSession(sessionId, (session) => ({
    ...session,
    messages: session.messages.map((message) =>
      message.id === reply.id
        ? { ...reply, parentId: message.parentId, selectedChildId: message.selectedChildId }
        : message
    ),
  }))

/**
 * 上下文压缩：写入摘要检查点并记录压缩覆盖到哪条消息。
 * 原始消息一条都不删，仍保存在会话里可回看，只是不再发给模型。
 */
export const applyCompaction = (
  sessionId: string,
  compactedThrough: string,
  checkpoint: NonNullable<Session['checkpoint']>
) => {
  updateSession(sessionId, (session) => ({
    ...session,
    checkpoint,
    compactedThrough,
    updatedAt: Date.now(),
  }))
  persist(sessionId)
}

/** 编辑压缩摘要：只替换 checkpoint 文本，消息与压缩时间保持不变 */
export const updateCheckpointText = (sessionId: string, text: string) => {
  if (
    get().importingHistory ||
    deletingSessions.has(sessionId) ||
    isSessionBusy(sessionId) ||
    !text.trim()
  ) {
    return
  }
  updateSession(sessionId, (session) =>
    session.checkpoint
      ? { ...session, checkpoint: { ...session.checkpoint, text }, updatedAt: Date.now() }
      : session
  )
  persist(sessionId)
}

/** 恢复完整上下文：清掉压缩标记，让全部原始消息重新参与请求 */
export const clearCompaction = (sessionId: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId) || isSessionBusy(sessionId)) {
    return
  }
  updateSession(sessionId, (session) => {
    if (!session.checkpoint && !session.compactedThrough) {
      return session
    }
    const restored = { ...session, updatedAt: Date.now() }
    delete restored.checkpoint
    delete restored.compactedThrough
    return restored
  })
  persist(sessionId)
}

/** 按整轮修改上下文；来源受影响的摘要必须失效，避免被排除内容经摘要回流。 */
export const setContextRoundIncluded = (sessionId: string, userId: string, included: boolean) => {
  if (get().importingHistory || deletingSessions.has(sessionId) || isSessionBusy(sessionId)) {
    return
  }
  updateSession(sessionId, (session) => {
    if (
      !getVisibleMessages(session).some(
        (message) => message.id === userId && message.role === 'user'
      )
    ) {
      return session
    }
    const excluded = new Set(session.excludedContextRoundIds ?? [])
    if (included) {
      excluded.delete(userId)
    } else {
      excluded.add(userId)
    }
    if (
      excluded.size === (session.excludedContextRoundIds?.length ?? 0) &&
      [...excluded].every((id) => session.excludedContextRoundIds?.includes(id))
    ) {
      return session
    }
    // 恢复曾被排除的旧轮也会改变摘要覆盖区间，因此一并恢复原文后重新选择。
    const next = { ...session, excludedContextRoundIds: [...excluded], updatedAt: Date.now() }
    delete next.checkpoint
    delete next.compactedThrough
    return next
  })
  persist(sessionId)
}

export const retainContextRounds = (sessionId: string, count: 5 | 10 | 'all') => {
  if (get().importingHistory || deletingSessions.has(sessionId) || isSessionBusy(sessionId)) {
    return
  }
  updateSession(sessionId, (session) => {
    const rounds = getContextRounds(getVisibleMessages(session))
    const visible = new Set(rounds.map(([user]) => user.id))
    const excluded =
      count === 'all'
        ? []
        : [
            ...(session.excludedContextRoundIds ?? []).filter((id) => !visible.has(id)),
            ...rounds.slice(0, Math.max(0, rounds.length - count)).map(([user]) => user.id),
          ]
    const next = { ...session, excludedContextRoundIds: excluded, updatedAt: Date.now() }
    delete next.checkpoint
    delete next.compactedThrough
    return next
  })
  set((state) => ({
    contextErrors: Object.fromEntries(
      Object.entries(state.contextErrors).filter(([id]) => id !== sessionId)
    ),
  }))
  persist(sessionId)
}

const persist = (sessionId: string) => {
  const session = getSession(sessionId)
  if (session) {
    unsavedSessions.add(sessionId)
    if (deletingSessions.has(sessionId)) {
      return
    }
    const epoch = historyEpoch
    const files = pendingFiles.get(sessionId)
    const fileDeletes = pendingFileDeletes.get(sessionId)
    const task = db
      .saveSession(session, files, fileDeletes ? [...fileDeletes] : [])
      .then(() => {
        if (epoch !== historyEpoch || !getSession(sessionId)) {
          return
        }
        if (pendingFiles.get(sessionId) === files) {
          pendingFiles.delete(sessionId)
        }
        if (pendingFileDeletes.get(sessionId) === fileDeletes) {
          pendingFileDeletes.delete(sessionId)
        }
        if (getSession(sessionId) === session) {
          unsavedSessions.delete(sessionId)
          set((state) => ({
            sessionSaveErrors: Object.fromEntries(
              Object.entries(state.sessionSaveErrors).filter(([id]) => id !== sessionId)
            ),
          }))
          trimSessionCache()
        }
      })
      .catch((error: unknown) => {
        db.reportStorageError('save session')(error)
        if (epoch === historyEpoch && getSession(sessionId)) {
          set((state) => ({
            sessionSaveErrors: { ...state.sessionSaveErrors, [sessionId]: true },
          }))
        }
      })
      .finally(() => pendingSaves.delete(task))
    pendingSaves.add(task)
  }
}

export const retrySaveSessions = () => {
  if (!get().importingHistory) {
    unsavedSessions.forEach(persist)
  }
}

/** 更新/刷新前的可等待保存屏障；失败拒绝，调用者可继续保留当前页面。 */
export const flushChatPersistence = async (): Promise<void> => {
  for (const [id, flush] of streamFlushes) {
    flush()
    persist(id)
  }
  unsavedSessions.forEach(persist)
  await Promise.all(pendingSaves)
  if (unsavedSessions.size > 0 || Object.keys(get().sessionSaveErrors).length > 0) {
    throw new Error('Local conversations could not be saved')
  }
}

/** 离开前先合并尚未绘制的增量；隐藏期间浏览器可能暂停动画帧。 */
export const bindChatPersistence = () => {
  const save = () => {
    if (get().importingHistory) {
      return
    }
    for (const [id, flush] of streamFlushes) {
      flush()
      persist(id)
    }
    for (const id of unsavedSessions) {
      if (!streamFlushes.has(id)) {
        persist(id)
      }
    }
  }
  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') {
      save()
    }
  }
  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('pagehide', save)
  return () => {
    document.removeEventListener('visibilitychange', onVisibilityChange)
    window.removeEventListener('pagehide', save)
  }
}

/** 按当前开关创建回复：深度思考对应 thinking，智能搜索控制 deepseek_web_search。 */
const createReply = (sessionId: string, contextUserId: string): AssistantMessage => {
  const route = getConversationRoute(sessionId)
  const { thinking, search } = useSettings.getState()
  return {
    id: createId(),
    role: 'assistant',
    contextUserId,
    createdAt: Date.now(),
    model: route.model,
    thinking: thinking && route.thinking,
    search: search && route.search,
    prefix: true,
    status: 'pending',
    blocks: [],
  }
}

/** 仍在生成中的回复（页面关闭或导出时未结束）按「已停止」处理 */
const settleInterrupted = (session: Session): Session => {
  if (
    !session.messages.some(
      (m) => m.role === 'assistant' && (m.status === 'pending' || m.status === 'streaming')
    )
  ) {
    return session
  }
  return {
    ...session,
    messages: session.messages.map((m) =>
      m.role === 'assistant' && (m.status === 'pending' || m.status === 'streaming')
        ? settleReply(m, 'stopped', session.updatedAt)
        : m
    ),
  }
}

export const initChat = (): Promise<void> => {
  if (get().ready) {
    return Promise.resolve()
  }
  if (initTask) {
    return initTask
  }
  const epoch = historyEpoch
  set({ initError: false })
  initTask = (async () => {
    try {
      const summaries = await db.loadSessionSummaries()
      if (epoch === historyEpoch) {
        flagUnboundSessions(summaries.map((row) => row.id))
        set({ ready: true, sessions: sortSessions(summaries) })
      }
    } catch (error) {
      if (epoch === historyEpoch) {
        set({ initError: true })
        db.reportStorageError('read local sessions')(error)
      }
    } finally {
      if (epoch === historyEpoch) {
        initTask = undefined
      }
    }
  })()
  return initTask
}

/** 同一会话合并并发读取；切换只改变 activeId，旧请求不会把界面切回去。 */
export const ensureSessionLoaded = (id: string): Promise<void> => {
  if (getSession(id)) {
    return Promise.resolve()
  }
  const pending = sessionLoads.get(id)
  if (pending) {
    return pending.promise
  }
  const epoch = historyEpoch
  set((state) => ({ sessionLoadErrors: { ...state.sessionLoadErrors, [id]: false } }))
  const load = { promise: Promise.resolve() }
  sessionLoads.set(id, load)
  load.promise = (async () => {
    try {
      const stored = await db.loadSession(id)
      if (epoch !== historyEpoch || sessionLoads.get(id) !== load) {
        return
      }
      const summary = get().sessions.find((session) => session.id === id)
      if (!summary) {
        return
      }
      if (!stored) {
        throw new Error(`Session ${id} is missing from local storage`)
      }
      const settled = settleInterrupted(normalizeSession(stored))
      // 读取期间可能已在列表重命名，保留最新元数据，不能让旧读取覆盖它。
      const latest = sameSummary(settled, summary) ? settled : { ...settled, ...summary }
      const session = needsTopic(latest)
        ? historyTopic(latest, getVisibleMessages(latest), resolveLocale(useSettings.getState().locale))
        : latest
      touchSession(id)
      set((state) => ({
        sessionCache: { ...state.sessionCache, [id]: session },
        sessions: sameSummary(session, summary) ? state.sessions : state.sessions.map((s) => s.id === id ? toSessionSummary(session) : s),
      }))
      if (session !== stored) {
        persist(id)
      }
      trimSessionCache()
    } catch (error) {
      if (epoch === historyEpoch && sessionLoads.get(id) === load) {
        set((state) => ({ sessionLoadErrors: { ...state.sessionLoadErrors, [id]: true } }))
        db.reportStorageError('read session')(error)
      }
    } finally {
      if (sessionLoads.get(id) === load) {
        sessionLoads.delete(id)
      }
    }
  })()
  return load.promise
}

/** 等所有回复的收尾（落盘）完成 */
const waitForIdle = (sessionId?: string) =>
  new Promise<void>((resolve) => {
    const isIdle = (state: ChatState) =>
      sessionId === undefined
        ? Object.keys(state.streaming).length === 0 && Object.keys(state.compacting).length === 0
        : !Object.hasOwn(state.streaming, sessionId) && !Object.hasOwn(state.compacting, sessionId)
    if (isIdle(get())) {
      resolve()
      return
    }
    const unsubscribe = useChatStore.subscribe((state) => {
      if (isIdle(state)) {
        unsubscribe()
        resolve()
      }
    })
  })

/**
 * 替换历史对话：先写入暂存，成功后原子替换旧记录；写入为空即删除全部会话与附件。
 * 期间停止生成并禁止修改会话；失败时清除暂存，保留原有记录。
 */
export const replaceHistory = async (write: () => Promise<void>): Promise<number> => {
  if (get().importingHistory) {
    throw new Error('History replacement is already in progress')
  }
  set({ importingHistory: true })
  try {
    for (const controller of [
      ...Object.values(get().streaming),
      ...Object.values(get().compacting),
      ...titleJobs.values(),
    ]) {
      controller.abort()
    }
    // 已开始的删除与生成先收尾，写入原文/附件成功后才允许创建恢复快照和替换历史。
    await Promise.all(deletionTasks)
    await waitForIdle()
    await flushChatPersistence()
    historyEpoch += 1
    initTask = undefined
    sessionLoads.clear()
    await db.clearStaging()
    let summaries: SessionSummary[]
    try {
      await write()
      summaries = await db.commitStaging()
    } catch (error) {
      await db.clearStaging().catch(db.reportStorageError('clear unfinished history replacement'))
      throw error
    }
    sessionAccess.clear()
    unsavedSessions.clear()
    pendingFiles.clear()
    pendingFileDeletes.clear()
    clearAllDrafts()
    set({
      ready: true,
      initError: false,
      sessions: sortSessions(summaries),
      sessionCache: {},
      sessionLoadErrors: {},
      sessionSaveErrors: {},
      contextErrors: {},
      activeId: null,
    })
    return summaries.length
  } finally {
    set({ importingHistory: false })
    retrySaveSessions()
    const { activeId, ready } = get()
    // 替换失败时恢复被取消的详情读取，原有记录继续可用。
    if (activeId !== null) {
      void ensureSessionLoaded(activeId)
    } else if (!ready) {
      void initChat()
    }
  }
}

export const newChat = (folderId: string | null = null) => {
  if (!get().importingHistory) {
    setDraftFolder(folderId)
    set({ activeId: null })
    trimSessionCache()
  }
}

export const selectSession = (id: string) => {
  if (!get().importingHistory && get().sessions.some((session) => session.id === id)) {
    touchSession(id)
    set({ activeId: id })
    void ensureSessionLoaded(id)
    trimSessionCache()
  }
}

/** 搜索结果跳转：加载目标并一次恢复全部祖先选择，不改变列表排序时间。 */
export const revealMessage = async (
  sessionId: string,
  messageId: string,
  signal?: AbortSignal
): Promise<'ok' | 'missing' | 'busy' | 'failed'> => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return 'busy'
  }
  if (!get().sessions.some((session) => session.id === sessionId)) {
    return 'missing'
  }
  touchSession(sessionId)
  await ensureSessionLoaded(sessionId)
  if (signal?.aborted) {
    return 'failed'
  }
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return 'busy'
  }
  const current = getSession(sessionId)
  if (!current) {
    return get().sessionLoadErrors[sessionId] ? 'failed' : 'missing'
  }
  if (!current.messages.some((message) => message.id === messageId)) {
    return 'missing'
  }
  if (!getVisibleMessages(current).some((message) => message.id === messageId)) {
    if (isSessionBusy(sessionId)) {
      return 'busy'
    }
    const session = normalizeSession(current)
    const byId = new Map(session.messages.map((message) => [message.id, message]))
    const selection = new Map<string, string>()
    const visited = new Set<string>()
    let node = byId.get(messageId)
    while (node?.parentId) {
      if (visited.has(node.id)) {
        return 'failed'
      }
      visited.add(node.id)
      selection.set(node.parentId, node.id)
      node = byId.get(node.parentId)
    }
    if (!node) {
      return 'failed'
    }
    const rootMessageId = node.id
    updateSession(sessionId, () => ({
      ...session,
      rootMessageId,
      messages: session.messages.map((message) =>
        selection.has(message.id)
          ? { ...message, selectedChildId: selection.get(message.id) }
          : message
      ),
    }))
    persist(sessionId)
  }
  touchSession(sessionId)
  set({ activeId: sessionId })
  trimSessionCache()
  return 'ok'
}

export const renameSession = (id: string, title: string) => {
  if (get().importingHistory || deletingSessions.has(id)) {
    return
  }
  titleJobs.get(id)?.abort()
  if (getSession(id)) {
    updateSession(id, (session) => ({ ...session, title, titleSource: 'manual' }))
    persist(id)
  } else {
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === id ? { ...session, title, titleSource: 'manual' } : session
      ),
    }))
    void db.renameSession(id, title).catch(db.reportStorageError('rename session'))
  }
}

/**
 * 删除会话；本地原件仅在没有其他会话引用时清理。远端文件不删：导入、编辑、重新生成都会复用同一个附件，
 * 同一服务端文件可能被多个会话引用，不维护引用计数。
 */
export const removeSession = (id: string): Promise<boolean> => {
  const task = removeSessionData(id).finally(() => deletionTasks.delete(task))
  deletionTasks.add(task)
  return task
}

const removeSessionData = async (id: string): Promise<boolean> => {
  if (get().importingHistory || deletingSessions.has(id)) {
    return false
  }
  const epoch = historyEpoch
  deletingSessions.add(id)
  try {
    getStreamController(id)?.abort()
    titleJobs.get(id)?.abort()
    cancelCompaction(id)
    // 等本会话的流收尾，避免删除之后又被收尾保存写回来。
    await waitForIdle(id)
    if (epoch !== historyEpoch) {
      return false
    }
    await db.deleteSession(id)
    if (epoch !== historyEpoch) {
      return true
    }
    sessionLoads.delete(id)
    sessionAccess.delete(id)
    unsavedSessions.delete(id)
    pendingFiles.delete(id)
    pendingFileDeletes.delete(id)
    clearDraft(id)
    try {
      removeConversationMode(id)
      removeLibrarySession(id)
    } catch (error) {
      db.reportStorageError('clean session metadata')(error)
    }
    set((state) => ({
      sessions: state.sessions.filter((session) => session.id !== id),
      sessionCache: Object.fromEntries(
        Object.entries(state.sessionCache).filter(([key]) => key !== id)
      ),
      sessionLoadErrors: Object.fromEntries(
        Object.entries(state.sessionLoadErrors).filter(([key]) => key !== id)
      ),
      sessionSaveErrors: Object.fromEntries(
        Object.entries(state.sessionSaveErrors).filter(([key]) => key !== id)
      ),
      activeId: state.activeId === id ? null : state.activeId,
    }))
    return true
  } catch (error) {
    db.reportStorageError('delete session')(error)
    return false
  } finally {
    deletingSessions.delete(id)
    // 删除失败时保留会话，并保存停止生成后的最新状态。
    if (getSession(id)) {
      if (get().importingHistory) {
        unsavedSessions.add(id)
      } else {
        persist(id)
      }
    }
  }
}

export const stopReply = (sessionId: string) => {
  getStreamController(sessionId)?.abort()
  cancelCompaction(sessionId)
}

function createEmptySession(id: string, title: string) {
  const now = Date.now()
  const session: Session = {
    id,
    title,
    createdAt: now,
    updatedAt: now,
    messages: [],
    rootMessageId: null,
  }
  touchSession(id)
  set((state) => ({
    sessions: [toSessionSummary(session), ...state.sessions],
    sessionCache: { ...state.sessionCache, [id]: session },
    activeId: id,
  }))
}

/** Receive a share alongside an existing welcome draft without consuming its model or text. */
export function createDraftSession(title: string): string | null {
  if (!get().ready || get().importingHistory) {
    return null
  }
  const id = createId()
  createEmptySession(id, title)
  persist(id)
  return id
}

/** Called after explicit approval of a new destination. Original attachment blobs remain local. */
export function applyConversationMode(sessionId: string | null, mode: ConversationMode) {
  if (
    get().importingHistory ||
    (sessionId && (isSessionBusy(sessionId) || !getSession(sessionId)))
  ) {
    return false
  }
  const previous = getConversationRoute(sessionId)
  const next = getConversationRoute(sessionId, mode)
  if (next.missing) {
    return false
  }
  setConversationMode(sessionId, mode, next.destination)
  if (sessionId && (previous.destination !== next.destination || previous.model !== next.model)) {
    titleJobs.get(sessionId)?.abort()
  }
  if (previous.destination !== next.destination || previous.needsApproval) {
    for (const item of getDraft(sessionId).attachments) {
      if (useUploads.getState().tasks[item.id]) {
        cancelUpload(item.id)
        useUploads.setState((s) => ({
          tasks: {
            ...s.tasks,
            [item.id]: {
              status: 'error',
              retryable: true,
              error: { key: 'draftAttachmentRestored' },
            },
          },
        }))
      }
    }
    if (sessionId) {
      updateSession(sessionId, (session) => ({
        ...session,
        messages: session.messages.map((message) => {
          if (message.role !== 'user' || !message.files.length) {
            return message
          }
          return {
            ...message,
            files: message.files.map((file) => {
              cancelUpload(file.id)
              return { ...file, serverId: null }
            }),
          }
        }),
      }))
      persist(sessionId)
    }
  }
  return true
}

/**
 * 提交指定会话的最新草稿；null 表示新建会话。
 * 同步接收成功才清空草稿，附件原件由会话接管；保存失败仍通过保存入口重试。
 */
export const sendMessage = (targetSessionId: string | null) => {
  if (get().importingHistory || !get().ready) {
    return false
  }
  const prepared = prepareDraftMessage(getDraft(targetSessionId), useUploads.getState().tasks)
  if (!prepared) {
    return false
  }
  const { text, files } = prepared
  const now = Date.now()
  let sessionId = targetSessionId
  if (
    sessionId !== null &&
    (deletingSessions.has(sessionId) || isSessionBusy(sessionId) || !getSession(sessionId))
  ) {
    return false
  }
  const route = getConversationRoute(targetSessionId)
  if (!getChatAccess(targetSessionId) || (files.length && !route.files)) {
    return false
  }
  const selected = {
    ...getConversationMode(targetSessionId),
    profileId: route.profileId ?? undefined,
  }
  if (sessionId === null) {
    sessionId = createId()
    const createdId = sessionId
    promoteConversationMode(createdId, selected, route.destination, () =>
      promoteLibraryDraft(createdId)
    )
    promoteSearchGrant(route, createdId)
    createEmptySession(sessionId, '')
  } else if (!getConversationMode(sessionId).profileId) {
    setConversationMode(sessionId, selected, route.destination)
  }
  const current = getSession(sessionId)
  if (!current) {
    return false
  }
  const history = getVisibleMessages(current)
  const question: UserMessage = {
    id: createId(),
    role: 'user',
    content: text,
    files: files.map(({ id, serverId, name, size, isImage, mimeType }) => ({
      id,
      serverId,
      name,
      size,
      isImage,
      mimeType,
    })),
    createdAt: now,
  }
  const topic = needsTopic(current) ? questionTopic(question, resolveLocale(useSettings.getState().locale)) : undefined
  const firstTopic = !current.messages.length && topic && !topic.provisional ? topic : undefined
  const reply = createReply(sessionId, question.id)
  updateSession(sessionId, (session) => ({
    ...appendBranch(session, history.at(-1)?.id ?? null, [question, reply]),
    ...(topic && { title: topic.title, titleSource: topic.provisional ? 'provisional' : undefined }),
    updatedAt: now,
  }))
  if (files.length > 0) {
    pendingFiles.set(sessionId, [
      ...(pendingFiles.get(sessionId) ?? []),
      ...files.map(({ id, blob }) => ({ id, blob })),
    ])
  }
  persist(sessionId)
  clearSentDraft(targetSessionId)
  void streamReply(sessionId, reply, { history, question }, firstTopic)
  return true
}

/** 重新生成当前路径上的回答：在原问题下新增版本，不覆盖旧回答和后续对话。 */
export const regenerateReply = (sessionId: string, messageId?: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  const session = getSession(sessionId)
  if (!session || isSessionBusy(sessionId) || !getChatAccess(sessionId)) {
    return
  }
  const path = getVisibleMessages(session)
  const index =
    messageId === undefined ? path.length - 1 : path.findIndex((m) => m.id === messageId)
  const question = path[index - 1]
  const previous = path[index]
  if (
    question?.role !== 'user' ||
    previous?.role !== 'assistant' ||
    !isReplyForQuestion(previous, question)
  ) {
    return
  }
  const history = path.slice(0, index - 1)
  const reply = createReply(sessionId, question.id)
  updateSession(sessionId, (s) => ({
    ...appendBranch(s, question.id, [reply]),
    updatedAt: Date.now(),
  }))
  persist(sessionId)
  void streamReply(sessionId, reply, { history, question, regenerate: true })
}

/** 编辑提问后新增同父版本，保留原文件；旧问题的所有回答与后续对话仍可切回。 */
export const editMessage = (sessionId: string, messageId: string, content: string): boolean => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return false
  }
  const session = getSession(sessionId)
  if (!session || isSessionBusy(sessionId) || !getChatAccess(sessionId)) {
    return false
  }
  const path = getVisibleMessages(session)
  const index = path.findIndex((message) => message.id === messageId)
  const previous = path[index]
  const text = content.trim()
  if (previous?.role !== 'user' || (!text && previous.files.length === 0)) {
    return false
  }
  const question: UserMessage = {
    id: createId(),
    role: 'user',
    content: text,
    files: previous.files,
    createdAt: Date.now(),
  }
  const reply = createReply(sessionId, question.id)
  updateSession(sessionId, (s) => ({
    ...appendBranch(s, path[index - 1]?.id ?? null, [question, reply]),
    updatedAt: Date.now(),
  }))
  persist(sessionId)
  void streamReply(sessionId, reply, { history: path.slice(0, index), question })
  return true
}

/** 按确认范围删除单条或目标全部后代；执行前再次核对范围，避免确认期间变化。 */
export const deleteMessage = (
  sessionId: string,
  messageId: string,
  mode: MessageDeletionMode = 'following',
  expectedIds?: string[]
): boolean => {
  if (get().importingHistory || deletingSessions.has(sessionId) || isSessionBusy(sessionId)) {
    return false
  }
  const session = getSession(sessionId)
  if (!session) {
    return false
  }
  const deletion = buildMessageDeletion(session, messageId, mode, expectedIds)
  if (!deletion) {
    return false
  }
  updateSession(sessionId, () => deletion.session)
  if (deletion.removedFileIds.length > 0) {
    const pending = pendingFileDeletes.get(sessionId) ?? new Set<string>()
    for (const id of deletion.removedFileIds) {
      pending.add(id)
    }
    pendingFileDeletes.set(sessionId, pending)
  }
  persist(sessionId)
  return true
}

export const selectMessageVersion = (sessionId: string, messageId: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  if (isSessionBusy(sessionId)) {
    return
  }
  updateSession(sessionId, (session) => selectVersion(session, messageId))
  persist(sessionId)
}

export const canResumeReply = (sessionId: string, reply: AssistantMessage) => {
  if (canContinueReply(reply)) {
    return true
  }
  const route = getConversationRoute(sessionId)
  const nativeThinking = route.protocol === 'deepseek' && route.thinking && (reply.thinking ?? useSettings.getState().thinking)
  return nativeThinking && canContinueReply(reply, true)
}

/** 继续最后一条未完成的回答：保留原消息与开关，仅将新流的内容追加到原块之后。 */
export const continueReply = (sessionId: string, messageId: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  const session = getSession(sessionId)
  if (!session || isSessionBusy(sessionId) || !getChatAccess(sessionId)) {
    return
  }
  const path = getVisibleMessages(session)
  const question = path.at(-2)
  const previous = path.at(-1)
  if (
    question?.role !== 'user' ||
    previous?.role !== 'assistant' ||
    previous.id !== messageId ||
    !isReplyForQuestion(previous, question)
  ) {
    return
  }
  const { thinking, search } = useSettings.getState()
  const route = getConversationRoute(sessionId)
  if (!canResumeReply(sessionId, previous)) {
    return
  }
  const reply: AssistantMessage = {
    ...previous,
    // 未记录请求配置的回复，续写时使用默认模型和当前开关。
    model: route.model,
    thinking: route.thinking && (previous.thinking ?? thinking),
    search: route.search && (previous.search ?? search),
    status: 'pending',
    stopReason: undefined,
    stopDetails: undefined,
    error: undefined,
  }
  updateReply(sessionId, reply)
  updateSession(sessionId, (s) => {
    const next = { ...s, updatedAt: Date.now() }
    // 续写会原位扩展同一消息；旧摘要不再代表这条消息的完整内容。
    if (
      s.compactedThrough === previous.id ||
      s.checkpoint?.coveredMessageIds?.includes(previous.id)
    ) {
      delete next.checkpoint
      delete next.compactedThrough
    }
    return next
  })
  persist(sessionId)
  void streamReply(sessionId, reply, { history: path.slice(0, -2), question, prefix: previous })
}

/** 附件补传失败后重试：保留原回答位置，重新补传并请求 */
export const retryUpload = (sessionId: string, messageId: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  const session = getSession(sessionId)
  if (!session || isSessionBusy(sessionId) || !getChatAccess(sessionId)) {
    return
  }
  const path = getVisibleMessages(session)
  const index = path.findIndex((message) => message.id === messageId)
  const question = path[index - 1]
  const previous = path[index]
  if (
    question?.role !== 'user' ||
    previous?.role !== 'assistant' ||
    !isReplyForQuestion(previous, question) ||
    previous.error?.kind !== 'upload'
  ) {
    return
  }
  const reply: AssistantMessage = { ...previous, status: 'pending', error: undefined }
  updateReply(sessionId, reply)
  persist(sessionId)
  void streamReply(sessionId, reply, { history: path.slice(0, index - 1), question })
}

type Request = { history: Message[]; question: UserMessage; prefix?: AssistantMessage; regenerate?: boolean }

/** 把补传得到的 serverId 写回会话里所有引用同一附件的消息（编辑、重新生成会共用附件） */
const saveServerIds = (sessionId: string, serverIds: Map<string, string>) => {
  if (serverIds.size === 0) {
    return
  }
  updateSession(sessionId, (session) => ({
    ...session,
    messages: session.messages.map((message) =>
      message.role === 'user' && message.files.some((file) => serverIds.has(file.id))
        ? {
            ...message,
            files: message.files.map((file) =>
              serverIds.has(file.id) ? { ...file, serverId: serverIds.get(file.id) ?? null } : file
            ),
          }
        : message
    ),
  }))
  persist(sessionId)
}

/**
 * 附件的服务端 id：已有直接用；正在上传的等待同一任务；否则读取本地原件补传。
 * 本地也没有原件（导入的文档附件只有元数据）时返回 null，该附件只展示、不进入请求。
 */
const ensureServerId = async (
  access: ChatAccess,
  sessionId: string,
  file: FileAttachment
): Promise<string | null> => {
  if (file.serverId) {
    return file.serverId
  }
  const blob =
    pendingFiles.get(sessionId)?.find((item) => item.id === file.id)?.blob ??
    (await db.loadFile(file.id))
  if (!blob) {
    return null
  }
  return uploadAttachment(access, file.id, blob, file.name, file.isImage)
}

/** 用会话里的最新消息替换请求快照：重传前会重置附件的 serverId，快照必须跟着更新 */
const refreshRequest = (sessionId: string, request: Request): Request => {
  const session = getSession(sessionId)
  if (!session) {
    return request
  }
  const byId = new Map(session.messages.map((message) => [message.id, message]))
  const pick = <T extends Message>(message: T): T =>
    (byId.get(message.id) as T | undefined) ?? message
  return {
    history: request.history.map(pick),
    question: pick(request.question),
    prefix: request.prefix,
  }
}

const requestContext = (sessionId: string, request: Request) => {
  const session = getSession(sessionId)
  return getEffectiveContext(
    request.history,
    session?.checkpoint?.text,
    session?.compactedThrough,
    session?.excludedContextRoundIds,
    session?.checkpoint?.coveredMessageIds
  )
}

/**
 * 发送前补齐附件的 serverId。
 * - 本轮提问的附件并行补齐，任一失败则整体失败，已成功的照常写回，重试时复用成功结果；
 * - 历史轮次（仅进入上下文的）中没有 serverId 的附件，多为导入的图片：从最新的消息往前逐张补传，
 *   失败静默跳过，该附件不进入本次请求，下次发送时再试。
 */
const prepareFiles = async (
  access: ChatAccess,
  sessionId: string,
  request: Request,
  signal: AbortSignal
) => {
  const epoch = historyEpoch
  const destination = getConversationRoute(sessionId).destination
  // 服务端判定 file_id 失效时会清掉会话里的 serverId，先用最新消息替换请求快照，
  // 否则快照里仍是旧 id，补传会直接复用它。
  request = refreshRequest(sessionId, request)
  const route = getConversationRoute(sessionId)
  const rounds = requestContext(sessionId, request).rounds
  let originalBytes = 0
  for (const turn of [request.question, ...rounds.map(([user]) => user)]) {
    for (const file of turn.files) {
      if (!route.files) {
        throw new ApiError('protocol', { key: 'originalFileUnsupported' })
      }
      if (isOpenAiFiles(route.origin)) {
        originalBytes += file.size
        if (file.size >= OPENAI_FILE_BYTES || originalBytes > OPENAI_FILE_BYTES) {
          throw new ApiError('protocol', { key: 'uploadOpenAiFileSize' })
        }
      }
      const issue = originalFileIssue(route.origin, { name: file.name, type: file.mimeType, isImage: file.isImage })
      if (issue) {
        throw new ApiError('protocol', { key: issue })
      }
    }
  }
  const serverIds = new Map<string, string>()
  // 停止生成立即生效；上传本身不取消（输入框与其他消息可能共用同一任务），完成后照常写回 serverId
  const aborted = new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
  const uploads = Promise.allSettled(
    request.question.files.map(async (file) => {
      const serverId = await ensureServerId(access, sessionId, file)
      if (serverId) {
        serverIds.set(file.id, serverId)
      }
    })
  )
  void uploads.then(() => {
    const route = getConversationRoute(sessionId)
    if (epoch === historyEpoch && !route.needsApproval && route.destination === destination) {
      saveServerIds(sessionId, serverIds)
    }
  })
  const results = await Promise.race([uploads, aborted])
  const failed = results.find((result) => result.status === 'rejected')
  if (failed) {
    throw failed.reason
  }

  const pending = new Map<string, FileAttachment>()
  for (const [user] of requestContext(sessionId, request).rounds.toReversed()) {
    for (const file of user.files) {
      if (!file.serverId && !serverIds.has(file.id) && !pending.has(file.id)) {
        pending.set(file.id, file)
      }
    }
  }
  for (const file of pending.values()) {
    signal.throwIfAborted()
    try {
      const serverId = await Promise.race([ensureServerId(access, sessionId, file), aborted])
      if (serverId) {
        serverIds.set(file.id, serverId)
        saveServerIds(sessionId, new Map([[file.id, serverId]]))
      }
    } catch {
      signal.throwIfAborted()
    }
  }

  // 用补齐后的会话重新取历史与提问，保证请求里都是 serverId
  const session = getSession(sessionId)
  const resolve = <T extends Message>(message: T): T =>
    (session?.messages.find((m) => m.id === message.id) as T | undefined) ?? message
  return {
    history: request.history.map(resolve),
    question: resolve(request.question),
    prefix: request.prefix,
  }
}

/** 本次请求实际会用到的服务端 file_id */
const collectServerFileIds = (sessionId: string, request: Request): Set<string> => {
  const ids = new Set<string>()
  const add = (files: FileAttachment[]) => {
    for (const file of files) {
      if (file.serverId) {
        ids.add(file.serverId)
      }
    }
  }
  add(request.question.files)
  for (const [user] of requestContext(sessionId, request).rounds) {
    add(user.files)
  }
  return ids
}

/**
 * 服务端判定 file_id 失效时，清掉对应附件的 serverId 并丢弃旧的上传任务，
 * 下一次补齐会重新读取本地原件上传。报错里点名了 file_id 就只重置这些，
 * 没点名（如 invalid file_id）则重置本次请求用到的全部附件。
 */
const reuploadInvalidatedFiles = (sessionId: string, request: Request, error: unknown): boolean => {
  if (!(error instanceof ApiError) || !getFileErrorCode(error)) {
    return false
  }
  const mentioned = extractFileIds(error.message)
  // 重试时原始快照里还是上一轮已被清掉的 serverId，先换成会话里的最新消息
  const targets =
    mentioned.length > 0
      ? new Set(mentioned)
      : collectServerFileIds(sessionId, refreshRequest(sessionId, request))
  const session = getSession(sessionId)
  if (targets.size === 0 || !session) {
    return false
  }
  const localIds: string[] = []
  const messages = session.messages.map((message) => {
    if (message.role !== 'user') {
      return message
    }
    let changed = false
    const files = message.files.map((file) => {
      if (!file.serverId || !targets.has(file.serverId)) {
        return file
      }
      localIds.push(file.id)
      changed = true
      return { ...file, serverId: null }
    })
    return changed ? { ...message, files } : message
  })
  if (localIds.length === 0) {
    return false
  }
  updateSession(sessionId, (current) => ({ ...current, messages }))
  // 上传任务里可能还留着同一个失效的 serverId，清掉后 ensureServerId 才会重新上传
  localIds.forEach(cancelUpload)
  persist(sessionId)
  return true
}

/** 重传前的退避等待；停止生成时立即返回，由调用方按已停止收尾 */
const waitForRetry = (attempt: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    function onAbort() {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(
      () => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      },
      FILE_RETRY_BASE_DELAY * 2 ** attempt
    )
    signal.addEventListener('abort', onAbort, { once: true })
  })

/**
 * 请求并消费流：先补齐附件的 serverId，再发请求；流式增量约 80ms 合并刷新内存，完成、失败或停止后落盘。
 * 补传失败时回复记为 upload 错误，可重试。
 * 服务端判定 file_id 失效时重新补传后重发，退避重试且次数有上限，超过则按原始报错收尾。
 */
const streamReply = async (sessionId: string, initial: AssistantMessage, request: Request, firstTopic?: ReturnType<typeof questionTopic>) => {
  const configuration = () =>
    JSON.stringify([getChatAccess(sessionId), getConversationRoute(sessionId).contextWindow])
  let initialConfiguration = configuration()
  let route = getConversationRoute(sessionId)
  const grant = getChatAccess(sessionId)
  const initialAccess = JSON.stringify(grant)
  const destination = route.destination
  const { system, memories } = conversationInstructions(sessionId)
  const controller = new AbortController()
  const acceptsTitle = () => {
    const session = getSession(sessionId)
    return firstTopic && session && session.titleSource !== 'manual' && session.title === firstTopic.title &&
      session.rootMessageId === request.question.id && !deletingSessions.has(sessionId) && !get().importingHistory &&
      getConversationRoute(sessionId).destination === destination && JSON.stringify(getChatAccess(sessionId)) === initialAccess
  }
  set((state) => ({
    streaming: { ...state.streaming, [sessionId]: controller },
    contextErrors: Object.fromEntries(
      Object.entries(state.contextErrors).filter(([id]) => id !== sessionId)
    ),
  }))
  let reply = initial
  const batcher = createContextBatcher(() => updateReply(sessionId, reply))
  const flush = () => batcher.flush()
  streamFlushes.set(sessionId, flush)
  controller.signal.addEventListener('abort', flush, { once: true })

  try {
    const warming = warmModelWindows(endpointProvider(route.origin, route.profile?.providerId))
    if (warming) {
      await warming
      if (JSON.stringify(getChatAccess(sessionId)) === initialAccess) {
        route = getConversationRoute(sessionId)
        initialConfiguration = configuration()
      }
    }
    for (let attempt = 0; ; attempt += 1) {
      /** 附件补齐前出错属于上传失败，请求还没有发出 */
      let preparing = true
      let receivedContent = false
      try {
        controller.signal.throwIfAborted()
        if (configuration() !== initialConfiguration) {
          preparing = false
          throw new ApiError('protocol', { key: 'contextSummaryChanged' })
        }
        const access = requireChatAccess(sessionId)
        const prepared = await prepareFiles(access, sessionId, request, controller.signal)
        preparing = false
        if (
          !prepared.question.content.trim() &&
          !prepared.question.files.some((file) => file.serverId)
        ) {
          throw new ApiError('protocol', { key: 'contextAttachmentUnavailable' })
        }
        if (configuration() !== initialConfiguration) {
          throw new ApiError('protocol', { key: 'contextSummaryChanged' })
        }
        // 附件就绪后获取本轮信息；续写沿用原回答快照，重新生成的快照独立保存。
        const latestReminder = prepared.prefix
          ? prepared.prefix.latestReminder
          : createLatestReminder({
              ...useSettings.getState(),
              locale: resolveLocale(useSettings.getState().locale),
            })
        reply = { ...reply, latestReminder }
        updateReply(sessionId, reply)
        persist(sessionId)
        const buildMessages = () => {
          const session = getSession(sessionId)
          const messages = toRequestMessages(
            prepared.history,
            prepared.question,
            prepared.prefix,
            route.protocol === 'deepseek' && (initial.thinking ?? false),
            latestReminder,
            session?.checkpoint?.text,
            session?.compactedThrough,
            session?.excludedContextRoundIds,
            session?.checkpoint?.coveredMessageIds
          )
          if (prepared.prefix && route.protocol !== 'deepseek') {
            // Ask the selected model to continue without depending on assistant prefill.
            messages.push({ role: 'user', content: 'Continue the preceding incomplete answer from where it stopped. Write only the remaining text, in the same language and format.' })
          }
          return messages
        }
        const files = indexRequestFiles([...prepared.history, prepared.question])
        const assertFileLimits = (messages: ReturnType<typeof toRequestMessages>) => {
          if (!usesDeepSeekFileLimits(access)) {
            return
          }
          const issue = requestFileLimit(messages, files)
          if (issue) {
            throw new ApiError('protocol', issue)
          }
        }
        let messages = buildMessages()
        const window = route.contextWindow
        // Portable search plans from the latest user turn, which during continuation is our suffix instruction.
        const canUseTools = route.search && (!prepared.prefix || route.protocol === 'deepseek')
        const tools = canUseTools ? serverTools(initial.search ?? false) : []
        const overhead = estimateTokens(JSON.stringify({ system, tools }))
        const inputTokens = () => estimateRequestTokens(messages, files) + overhead
        if (useContextPreferences.getState().autoCompact) {
          const { compactSession } = await import('./compact.js')
          if (inputTokens() >= window * 0.8) {
            // Compaction cannot remove attachments from the current question.
            assertFileLimits(toRequestMessages([], prepared.question))
            const result = await compactSession(sessionId, {
              history: prepared.history,
              signal: controller.signal,
              automatic: true,
            })
            if (!result.ok && result.cancelled) {
              controller.abort()
            }
            controller.signal.throwIfAborted()
            if (!result.ok) {
              set((state) => ({
                contextErrors: { ...state.contextErrors, [sessionId]: result.message },
              }))
            }
            messages = buildMessages()
            // 失败不降级为截断；仍超窗时保留问题和原文，交由用户选择轮次再重试。
          }
        }
        assertFileLimits(messages)
        // Leave 5% for output and tokenizer variance, including when automatic summaries are off.
        if (inputTokens() >= Math.min(window * 0.95, route.context.input ?? Infinity)) {
          throw new ApiError('protocol', { key: 'contextRequestTooLarge' })
        }
        controller.signal.throwIfAborted()
        if (configuration() !== initialConfiguration) {
          throw new ApiError('protocol', { key: 'contextSummaryChanged' })
        }
        const events = streamMessage(
          access,
          {
            model: route.model,
            system,
            messages,
            thinking: { type: route.thinking && initial.thinking ? 'enabled' : 'disabled' },
            safety_check: SAFETY_CHECK,
            tools,
            ...(route.protocol === 'deepseek' && acceptsTitle() ? { title: { enabled: true } } : {}),
          },
          controller.signal,
          () => {
            reply = { ...reply, usageLedger: true, lastRequestMemories: memories }
            updateReply(sessionId, reply)
          },
          request.prefix ? 'continue' : request.regenerate ? 'regenerate' : 'chat'
        )
        const blockIndexes = new Map<number, number>()
        for await (const event of events) {
          receivedContent ||= event.type === 'content_block_start'
          if (
            event.type === 'message_delta' &&
            (event.delta.stop_reason === 'end_turn' || event.delta.stop_reason === 'max_tokens') &&
            event.delta.title?.trim() &&
            route.protocol === 'deepseek' && !controller.signal.aborted && acceptsTitle()
          ) {
            const title = providerTitle(event.delta.title, request.question.content)
            if (title) {
              updateSession(sessionId, (session) => ({ ...session, title }))
            }
          }
          reply = applyEvent(reply, event, Date.now(), blockIndexes)
          batcher.schedule()
        }
        reply = settleReply(reply, 'done', Date.now())
        break
      } catch (error) {
        if (controller.signal.aborted) {
          reply = settleReply(reply, 'stopped', Date.now())
          break
        }
        if (preparing) {
          reply = settleReply(reply, 'error', Date.now(), {
            kind: 'upload',
            message: '',
            localMessage: describeUploadError(error),
            retryable: isRetryableApiError(error),
          })
          break
        }
        // 附件失效：重新补传后重发。收到过内容块（含丢弃的客户端工具）后不自动重发。
        if (
          attempt < FILE_RETRY_LIMIT &&
          !receivedContent &&
          reuploadInvalidatedFiles(sessionId, request, error)
        ) {
          await waitForRetry(attempt, controller.signal)
          if (controller.signal.aborted) {
            reply = settleReply(reply, 'stopped', Date.now())
            break
          }
          continue
        }
        if (error instanceof ApiError && error.kind === 'interrupted' && reply.stopReason) {
          // 已收到 message_delta 的结束原因，只是缺了结尾的 message_stop
          reply = settleReply(reply, 'done', Date.now())
        } else if (error instanceof ApiError) {
          reply = settleReply(reply, 'error', Date.now(), {
            kind: error.kind,
            message: error.message,
            status: error.status,
            ...(error.status === 402 && grant?.source === 'api' && isDeepSeekApiOrigin(grant.config.origin)
              ? { officialApiBilling: true as const } : {}),
            // 上下文超限：换成「开启新对话」的提示，比原始报错可读
            localMessage: isContextOverflow(error)
              ? { key: 'replyContextFull' }
              : error.localMessage,
          })
        } else {
          reply = settleReply(reply, 'error', Date.now(), {
            kind: 'protocol',
            message: error instanceof Error ? error.message : String(error),
          })
        }
        break
      }
    }
  } finally {
    streamFlushes.delete(sessionId)
    controller.signal.removeEventListener('abort', flush)
    batcher.finish()
    set((state) => ({
      streaming: Object.fromEntries(
        Object.entries(state.streaming).filter(([id]) => id !== sessionId)
      ),
    }))
    persist(sessionId)
    if (firstTopic?.excerpt && grant && route.protocol !== 'deepseek' && reply.status === 'done' &&
        reply.stopReason === 'end_turn' && reply.blocks.some(b => b.type === 'text' && !b.isTemplate && b.text.trim()) &&
        !controller.signal.aborted && acceptsTitle()) {
      const job = new AbortController()
      titleJobs.set(sessionId, job)
      const timer = setTimeout(() => job.abort(), 12_000)
      void refineTopic(grant, firstTopic.excerpt, job).then(title => {
        if (title && !job.signal.aborted && acceptsTitle()) {
          updateSession(sessionId, session => ({ ...session, title }))
          persist(sessionId)
        }
      }).catch(() => { /* The local title is already saved. */ }).finally(() => {
        clearTimeout(timer)
        if (titleJobs.get(sessionId) === job) {
          titleJobs.delete(sessionId)
        }
        trimSessionCache()
      })
    }
  }
}
