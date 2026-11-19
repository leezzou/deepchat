import { streamMessage } from '../api/client.js'
import { getApiConfig } from '../api/origin.js'
import { getChatAccess } from '../api/access.js'
import type { CreateMessageRequest, MessageParam } from '../api/types.js'
import { usesDeepSeekFileLimits } from '../attachmentLimits.js'
import { useSettings } from '../settings.js'
import { getContextRounds, getEffectiveContext, getReplyText, toRequestMessages } from './reply.js'
import { applyCompaction, useChatStore } from './store.js'
import { getVisibleMessages } from './branches.js'
import {
  estimateTokens,
  estimateRequestTokens,
  indexRequestFiles,
  requestFileLimit,
  splitContextText,
} from './contextBudget.js'
import { translate } from '../../i18n/index.js'
import { recordCompaction } from './compactionIndex.js'
import type { Message, Session } from './types.js'

/**
 * 沿用既有结构化检查点，按当前分支与用户选择生成模型摘要。
 * 阈值 80%、保留最近约 16%，把更早的轮次压成一份结构化 checkpoint，
 * 检查点用 <compacted-summary> 包住，并配一段「这是既定背景」的前言。
 */
const THRESHOLD_RATIO = 0.8
const RETAIN_RATIO = 0.16
/** 低于这个比例不允许压缩（用户要求：80% 之后再压缩） */
export const MIN_COMPACT_RATIO = 0.8

/** 沿用手动摘要的 80% 门槛。 */
export const canCompact = (session: Session): boolean =>
  contextPressure(session) >= MIN_COMPACT_RATIO

export const SUMMARY_OPEN_TAG = '<compacted-summary>'
export const SUMMARY_CLOSE_TAG = '</compacted-summary>'

/** DSH 的压缩指令（原样保留结构，只是把「coding assistant」换成通用对话） */
const COMPACTION_INSTRUCTION = [
  'You are now acting as a compaction engine for this AI assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.',
  '',
  'Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.',
  '',
  '## Primary Request and Intent',
  "- [the user's original and evolving goals; quote verbatim where the exact wording matters]",
  '',
  '## Key Technical Concepts',
  '- [technologies, frameworks, patterns, and conventions in play]',
  '',
  '## Files and Code',
  '- [exact path: why it matters, key changes or snippets]',
  '',
  '## Errors and Fixes',
  '- [error: how it was resolved, plus any related user feedback]',
  '',
  '## Pending Jobs',
  '- [explicitly requested work not yet completed]',
  '',
  '## Current Work',
  '- [precisely what was in progress at this checkpoint]',
  '',
  '## Next Step',
  '- [the single next action, directly in line with the most recent request, or "(none)"]',
  '',
  '## Critical Context',
  '- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]',
  '',
  'Rules:',
  '- Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.',
  '- Capture user feedback and explicit instructions faithfully, especially corrections.',
  '- Do NOT mention this summarization request or that the context was compacted.',
  '- Output only the checkpoint text: do not call any tool or take any other action.',
  `- If the conversation already contains a ${SUMMARY_OPEN_TAG} block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.`,
].join('\n')

/** 把摘要正文包成 checkpoint 文本（前言 + 标签） */
export const buildCheckpointText = (body: string): string =>
  `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}\n${body.trim()}\n${SUMMARY_CLOSE_TAG}`

/** 检查点前言：让模型把它当既定背景，而不是一条用户提问 */
const CHECKPOINT_PREAMBLE =
  'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.'

export { estimateTokens } from './contextBudget.js'

/** 当前选中 API 配置的窗口优先；不把默认 DeepSeek 窗口套到其他模型。 */
export const contextWindowTokens = (): number => {
  const state = useSettings.getState()
  if (state.chatSource === 'account') {
    return 1_000_000
  }
  const active = state.apiProfiles.find((profile) => profile.id === state.activeProfileId)
  if (active?.contextWindow && Number.isFinite(active.contextWindow) && active.contextWindow > 0) {
    return active.contextWindow
  }
  return getApiConfig().protocol === 'deepseek' ? 1_000_000 : 128_000
}

export const sessionContext = (session: Session, history = getVisibleMessages(session)) =>
  getEffectiveContext(
    history,
    session.checkpoint?.text,
    session.compactedThrough,
    session.excludedContextRoundIds,
    session.checkpoint?.coveredMessageIds
  )

/** 与真实请求共用轮次、提醒快照、工具块、附件和摘要选择；只估算当前分支。 */
export const sessionContextTokens = (
  session: Session,
  path = getVisibleMessages(session)
): number => {
  const context = sessionContext(session, path)
  const rounds = context.rounds
  const last = rounds.at(-1)
  let messages: MessageParam[] = context.checkpoint
    ? [{ role: 'user', content: context.checkpoint }]
    : []
  if (last) {
    // 作为历史而不是续写估算，避免回传旧思考块。
    const placeholder = { ...last[0], id: '__budget__', content: '', files: [] }
    messages = toRequestMessages(
      path,
      placeholder,
      undefined,
      false,
      undefined,
      session.checkpoint?.text,
      session.compactedThrough,
      session.excludedContextRoundIds,
      session.checkpoint?.coveredMessageIds
    ).slice(0, -1)
  }
  const pending = path.at(-1)
  const question =
    pending?.role === 'user'
      ? pending
      : pending?.role === 'assistant' &&
          (pending.status === 'pending' || pending.status === 'streaming')
        ? path.at(-2)
        : undefined
  if (question?.role === 'user') {
    messages.push(...toRequestMessages([], question))
  }
  return estimateRequestTokens(messages, indexRequestFiles(path))
}

export const contextPressure = (session: Session): number =>
  sessionContextTokens(session) / contextWindowTokens()

export const shouldWarnContext = (session: Session): boolean =>
  contextPressure(session) >= THRESHOLD_RATIO

const summaryRequest = (messages: MessageParam[]): CreateMessageRequest => ({
  model: 'deepseek-flash',
  system: '该助手为DeepSeek，由深度求索公司创造。',
  messages,
  thinking: { type: 'disabled' },
  tools: [],
  safety_check: { level: 'high' },
})

export type CompactResult =
  | { ok: true; covered: number; kept: number }
  | { ok: false; message: string; cancelled?: boolean }
export type CompactOptions = {
  /** 自动摘要只接收当前请求的历史，不触碰本轮问题或续写前缀。 */
  history?: Message[]
  signal?: AbortSignal
  automatic?: boolean
}

const profileSignature = () =>
  JSON.stringify([getChatAccess(), useSettings.getState().activeProfileId, contextWindowTokens()])

/** 单轮超过窗口时逐段摘要所有文字；不截掉原文尾部，附件仍按原 file_id 传入。 */
const roundFragments = (
  round: ReturnType<typeof getContextRounds>[number],
  budget: number,
  files: ReturnType<typeof indexRequestFiles>,
  applyFileLimits: boolean
): MessageParam[][] => {
  const [user, reply] = round
  const placeholder = { ...user, id: '__summary__', content: '', files: [] }
  const messages = toRequestMessages(round, placeholder).slice(0, -1)
  const issue = applyFileLimits && requestFileLimit(messages, files)
  if (issue) {
    throw new Error(translate(issue.key, issue.params))
  }
  if (estimateRequestTokens(messages, files) <= budget) {
    return [messages]
  }
  const transcript = JSON.stringify({
    question: user.content,
    files: user.files.map((file) => file.name),
    answer: getReplyText(reply),
    reminder: reply.latestReminder,
    tools: reply.blocks.filter((block) => block.type !== 'text' && block.type !== 'thinking'),
  })
  const attachmentMessages = toRequestMessages([], { ...user, content: '' })
  const attachmentCost = user.files.some((file) => file.serverId)
    ? estimateRequestTokens(attachmentMessages, files)
    : 0
  const textBudget = budget - attachmentCost - 512
  if (textBudget < 256) {
    throw new Error(translate('contextSummaryAttachmentLimit'))
  }
  return splitContextText(transcript, textBudget).map((text, index) => {
    const fragment: MessageParam = {
      role: 'user',
      content: `Conversation fragment ${index + 1}:\n${text}`,
    }
    return attachmentCost ? [...attachmentMessages, fragment] : [fragment]
  })
}

/** 原文和旧检查点只在完整有效摘要完成后一起提交；任何失败/取消均不替换。 */
export const compactSession = async (
  sessionId: string,
  options: CompactOptions = {}
): Promise<CompactResult> => {
  const access = getChatAccess()
  const store = useChatStore.getState()
  const session = store.sessionCache[sessionId]
  const failure = (message: string): CompactResult => ({ ok: false, message })
  if (!access) {
    return failure(translate('contextSummaryKeyMissing'))
  }
  if (!session || store.importingHistory) {
    return failure(translate('contextSummaryChanged'))
  }
  if (store.compacting[sessionId] || (!options.automatic && store.streaming[sessionId])) {
    return failure(translate('contextControlsBusy'))
  }
  if (!options.automatic && !canCompact(session)) {
    return failure(translate('contextCompactLocked'))
  }
  const history = options.history ?? getVisibleMessages(session)
  const context = sessionContext(session, history)
  const rounds = context.rounds
  if (rounds.length === 0) {
    return failure(translate('contextNothingToSummarize'))
  }
  const controller = new AbortController()
  const cancel = () => controller.abort()
  if (options.signal?.aborted) {
    controller.abort()
  }
  options.signal?.addEventListener('abort', cancel, { once: true })
  useChatStore.setState((current) => ({
    compacting: { ...current.compacting, [sessionId]: controller },
  }))
  const signature = profileSignature()
  const unchanged = () => {
    controller.signal.throwIfAborted()
    const current = useChatStore.getState()
    if (
      current.importingHistory ||
      current.sessionCache[sessionId] !== session ||
      profileSignature() !== signature
    ) {
      throw new Error(translate('contextSummaryChanged'))
    }
  }
  try {
    const window = contextWindowTokens()
    const files = indexRequestFiles(history)
    const roundCost = (round: (typeof rounds)[number]) => {
      const placeholder = { ...round[0], content: '', files: [] }
      return estimateRequestTokens(toRequestMessages(round, placeholder).slice(0, -1), files)
    }
    // 至少保留最近一整轮，单轮历史可压缩；本轮问题从未进入 rounds。
    let keepFrom = rounds.length === 1 ? 1 : rounds.length - 1
    let keptTokens = rounds.length > 1 ? roundCost(rounds[rounds.length - 1]) : 0
    while (keepFrom > 1) {
      const cost = roundCost(rounds[keepFrom - 1])
      if (keptTokens + cost > window * RETAIN_RATIO) {
        break
      }
      keptTokens += cost
      keepFrom -= 1
    }
    const oldRounds = rounds.slice(0, keepFrom)
    const instruction = `${COMPACTION_INSTRUCTION}\n- Keep the checkpoint under ${Math.max(128, Math.floor(window * 0.1))} tokens. Do not omit unresolved requirements.`
    const reserve = estimateTokens(instruction) + 512
    const batchBudget = Math.floor(window * 0.55) - reserve
    if (batchBudget < 512) {
      return failure(translate('contextSummaryWindowSmall'))
    }
    const applyFileLimits = usesDeepSeekFileLimits(access)
    const fragments = oldRounds.flatMap((round) =>
      roundFragments(round, batchBudget, files, applyFileLimits)
    )
    let checkpoint = context.checkpoint ?? ''
    let cursor = 0
    while (cursor < fragments.length) {
      unchanged()
      const messages: MessageParam[] = checkpoint ? [{ role: 'user', content: checkpoint }] : []
      const start = cursor
      while (cursor < fragments.length) {
        const batch = [...messages, ...fragments[cursor]]
        if (
          (applyFileLimits && requestFileLimit(batch, files)) ||
          estimateRequestTokens(batch, files) + reserve >= window * 0.8
        ) {
          break
        }
        messages.push(...fragments[cursor++])
      }
      if (cursor === start) {
        return failure(translate('contextSummaryNotSmaller'))
      }
      messages.push({ role: 'user', content: instruction })
      let summary = ''
      let completed = false
      let stopReason: string | undefined
      for await (const event of streamMessage(
        access,
        summaryRequest(messages),
        controller.signal
      )) {
        controller.signal.throwIfAborted()
        if (event.type === 'content_block_start' && event.content_block.type === 'text') {
          summary += event.content_block.text
        }
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          summary += event.delta.text
        }
        if (event.type === 'message_delta') {
          stopReason = event.delta.stop_reason
        }
        if (event.type === 'message_stop') {
          completed = true
        }
      }
      if (!completed || stopReason !== 'end_turn' || !summary.trim()) {
        return failure(translate('contextSummaryIncomplete'))
      }
      checkpoint = buildCheckpointText(summary)
      if (estimateTokens(checkpoint) > window * 0.2) {
        return failure(translate('contextSummaryNotSmaller'))
      }
    }
    unchanged()
    const previousIds = context.checkpoint
      ? (session.checkpoint?.coveredMessageIds ??
        history.slice(0, context.boundary + 1).map((message) => message.id))
      : []
    const coveredMessageIds = [
      ...new Set([...previousIds, ...oldRounds.flat().map((message) => message.id)]),
    ]
    const before =
      estimateTokens(context.checkpoint ?? '') +
      oldRounds.reduce((sum, round) => sum + roundCost(round), 0)
    if (estimateTokens(checkpoint) >= before) {
      return failure(translate('contextSummaryNotSmaller'))
    }
    const lastCovered = oldRounds.at(-1)?.[1]
    if (!lastCovered) {
      return failure(translate('contextNothingToSummarize'))
    }
    const createdAt = Date.now()
    applyCompaction(sessionId, lastCovered.id, {
      text: checkpoint,
      createdAt,
      coveredMessages: coveredMessageIds.length,
      coveredMessageIds,
    })
    recordCompaction({
      sessionId,
      title: session.title || 'Untitled',
      createdAt,
      coveredMessages: coveredMessageIds.length,
    })
    return { ok: true, covered: oldRounds.length, kept: rounds.length - oldRounds.length }
  } catch (error) {
    return controller.signal.aborted
      ? { ok: false, cancelled: true, message: translate('contextSummaryCancelled') }
      : failure(error instanceof Error ? error.message : String(error))
  } finally {
    options.signal?.removeEventListener('abort', cancel)
    useChatStore.setState((current) => ({
      compacting: Object.fromEntries(
        Object.entries(current.compacting).filter(([id]) => id !== sessionId)
      ),
    }))
  }
}
