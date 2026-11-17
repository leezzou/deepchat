import { streamMessage } from '../api/client.js'
import { getApiConfig } from '../api/origin.js'
import type { CreateMessageRequest, MessageParam } from '../api/types.js'
import { useSettings } from '../settings.js'
import { getContextRounds, getReplyText } from './reply.js'
import { applyCompaction, useChatStore } from './store.js'
import { recordCompaction } from './compactionIndex.js'
import type { Message, Session } from './types.js'

/**
 * 上下文压缩。算法与提示词照搬 DeepSeek Harness 的 compaction-basic：
 * 阈值 80%、保留最近约 16%，把更早的轮次压成一份结构化 checkpoint（不是逐字摘要），
 * 检查点用 <compacted-summary> 包住，并配一段「这是既定背景」的前言。
 */
const THRESHOLD_RATIO = 0.8
const RETAIN_RATIO = 0.16
/** 低于这个比例不允许压缩：没什么可省的，反而白白损失细节 */
export const MIN_COMPACT_RATIO = 0.3

/** 是否允许手动压缩（30% 以上） */
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

/**
 * 粗略 token 估算：中日韩字符约 1 字 0.7 token，其他 4 字符 1 token。
 * 只用来判断「接近上限」和切分保留区间，保守偏大一点。
 */
export const estimateTokens = (text: string): number => {
  let cjk = 0
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) > 0x2e80) {
      cjk += 1
    }
  }
  return Math.ceil(cjk * 0.7 + (text.length - cjk) / 4)
}

/** 上下文窗口：优先用配置里填的，否则 DeepSeek 官方 1M、OpenAI 兼容按 128k 保守估计 */
export const contextWindowTokens = (): number => {
  const state = useSettings.getState()
  const active = state.apiProfiles.find((profile) => profile.id === state.activeProfileId)
  if (active?.contextWindow && active.contextWindow > 0) {
    return active.contextWindow
  }
  return getApiConfig().protocol === 'deepseek' ? 1_000_000 : 128_000
}

const messageText = (message: Message): string =>
  message.role === 'user' ? message.content : getReplyText(message)

/** 当前会话占用（checkpoint + 全部轮次），单位 token */
export const sessionContextTokens = (session: Session): number => {
  const checkpoint = session.checkpoint?.text ?? ''
  // 压缩覆盖到的消息不再计入上下文
  const start = session.compactedThrough
    ? session.messages.findIndex((message) => message.id === session.compactedThrough) + 1
    : 0
  const rounds = getContextRounds(session.messages.slice(start))
  const fromRounds = rounds.reduce(
    (sum, [user, reply]) => sum + estimateTokens(messageText(user)) + estimateTokens(messageText(reply)),
    0
  )
  return estimateTokens(checkpoint) + fromRounds
}

/** 是否该提示用户压缩上下文 */
export const contextPressure = (session: Session): number =>
  sessionContextTokens(session) / contextWindowTokens()

export const shouldWarnContext = (session: Session): boolean =>
  contextPressure(session) >= THRESHOLD_RATIO

/** 摘要用的请求体：不带工具、不开深度思考，尽量便宜 */
const summaryRequest = (messages: MessageParam[]): CreateMessageRequest => ({
  model: 'deepseek-flash',
  system: '该助手为DeepSeek，由深度求索公司创造。',
  messages,
  thinking: { type: 'disabled' },
  tools: [],
  safety_check: { level: 'high' },
})

export type CompactResult = { ok: true; covered: number; kept: number } | { ok: false; message: string }

/**
 * 压缩会话：把较早的轮次交给模型压成结构化 checkpoint，最近若干轮原样保留。
 * 已经压缩过的会话会把上一份 checkpoint 一起参与再压缩（合并成一份）。
 */
export const compactSession = async (sessionId: string): Promise<CompactResult> => {
  const state = useSettings.getState()
  if (!state.apiKey) {
    return { ok: false, message: 'missing api key' }
  }
  const session = useChatStore.getState().sessionCache[sessionId]
  if (!session) {
    return { ok: false, message: 'session not found' }
  }
  // 30% 以下不准压缩
  if (contextPressure(session) < MIN_COMPACT_RATIO) {
    return { ok: false, message: 'context below 30%' }
  }
  const rounds = getContextRounds(session.messages)
  if (rounds.length === 0 && !session.checkpoint) {
    return { ok: false, message: 'nothing to compact' }
  }

  // 从最新往回保留约 16% 窗口的轮次；至少留一轮，只有一轮时可整段压缩
  const retainBudget = contextWindowTokens() * RETAIN_RATIO
  let keepFrom = rounds.length
  let keptTokens = 0
  while (keepFrom > 1) {
    const [user, reply] = rounds[keepFrom - 1]
    const cost = estimateTokens(messageText(user)) + estimateTokens(messageText(reply))
    if (keptTokens + cost > retainBudget) {
      break
    }
    keptTokens += cost
    keepFrom -= 1
  }

  // 只有一轮时整段压缩；否则至少保留最后一轮
  const oldRounds = rounds.length === 1 ? rounds : rounds.slice(0, keepFrom)
  const keptRounds = rounds.length === 1 ? [] : rounds.slice(keepFrom)
  if (oldRounds.length === 0) {
    return { ok: false, message: 'nothing to compact' }
  }

  const messages: MessageParam[] = []
  if (session.checkpoint?.text) {
    messages.push({ role: 'user', content: session.checkpoint.text })
  }
  for (const [user, reply] of oldRounds) {
    const userText = messageText(user)
    const replyText = messageText(reply)
    if (userText.trim()) {
      messages.push({ role: 'user', content: userText })
    }
    if (replyText.trim()) {
      messages.push({ role: 'assistant', content: [{ type: 'text', text: replyText }] })
    }
  }
  messages.push({ role: 'user', content: COMPACTION_INSTRUCTION })

  const controller = new AbortController()
  let summary = ''
  try {
    for await (const event of streamMessage(state.apiKey, summaryRequest(messages), controller.signal)) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        summary += event.delta.text
      }
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }

  const text = summary.trim()
  if (!text) {
    return { ok: false, message: 'empty summary' }
  }

  // 原始消息全部保留在会话里（用户可回看），只记录压缩覆盖到哪条
  const lastCovered = oldRounds[oldRounds.length - 1][1]

  const createdAt = Date.now()
  applyCompaction(sessionId, lastCovered.id, {
    text: buildCheckpointText(text),
    createdAt,
    coveredMessages: oldRounds.length * 2,
  })
  recordCompaction({
    sessionId,
    title: session.title || '未命名对话',
    createdAt,
    coveredMessages: oldRounds.length * 2,
  })
  return { ok: true, covered: oldRounds.length, kept: keptRounds.length }
}
