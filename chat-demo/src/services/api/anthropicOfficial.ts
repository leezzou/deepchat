import type { ReasoningSupport } from './providerParity.js'
import type { CreateMessageRequest } from './types.js'

export const CLAUDE_BASE = 'https://api.anthropic.com/v1'
export const isAnthropicOrigin = (origin: string) =>
  ['https://api.anthropic.com', CLAUDE_BASE].includes(origin.trim().replace(/\/+$/u, ''))

/** Only attach these headers after verifying the exact official endpoint. */
export function claudeHeaders(key: string): Record<string, string> {
  return {
    'x-api-key': key,
    'anthropic-version': '2026-10-21',
    'anthropic-dangerous-direct-browser-access': 'true',
  }
}

type Mode = 'adaptive' | 'manual' | 'none'
type Off = 'disabled' | 'between_tools' | 'fixed'
type Capabilities = { mode?: Mode; off?: Off; files?: boolean; search?: boolean; output?: number }
const groups: [Mode, Off, string[]][] = [
  [
    'manual',
    'disabled',
    [
      'claude-haiku-4-5',
      'claude-haiku-4-5-20251001',
      'claude-sonnet-4-5',
      'claude-sonnet-4-5-20250929',
      'claude-opus-4-5',
      'claude-opus-4-5-20251101',
    ],
  ],
  [
    'adaptive',
    'disabled',
    [
      'claude-opus-4-6',
      'claude-opus-4-7',
      'claude-opus-4-8',
      'claude-sonnet-4-6',
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-haiku-5-5',
    ],
  ],
  ['adaptive', 'between_tools', ['claude-sonnet-5-5']],
  [
    'adaptive',
    'fixed',
    [
      'claude-opus-5-5',
      'claude-fable-5',
      'claude-fable-5-1',
      'claude-fable-5-2',
      'claude-mythos-preview',
      'claude-mythos-5',
      'claude-mythos-5-1',
      'claude-mythos-5-2',
    ],
  ],
]
// Exact documented snapshots and aliases. A different endpoint never inherits these settings.
const bundled = new Map<string, Capabilities>()
for (const [mode, off, ids] of groups) {
  for (const id of ids) {
    bundled.set(id, { mode, off, files: true, search: true })
  }
}
// Model protocol metadata from the official Models API. It contains no credentials or grants.
const discovered = new Map<string, Capabilities>()
const capabilities = (id: string) => ({ ...bundled.get(id), ...discovered.get(id) })
const object = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
// Persist only selected models' public protocol fields alongside the profile in its existing vault.
export type ClaudeModelFacts = Record<string, Capabilities>
export function selectedClaudeFacts(origin: string, id: string, saved?: ClaudeModelFacts) {
  const facts = discovered.get(id)
  if (!isAnthropicOrigin(origin) || !facts) {
    return saved
  }
  return { ...saved, [id]: facts }
}
export function restoreClaudeFacts(origin: unknown, raw: unknown): ClaudeModelFacts | undefined {
  if (typeof origin !== 'string' || !isAnthropicOrigin(origin)) {
    return undefined
  }
  const result: [string, Capabilities][] = []
  for (const [id, entry] of Object.entries(object(raw))) {
    const { mode, off, files, search, output } = object(entry)
    const info: Capabilities = {}
    if (mode === 'adaptive' || mode === 'manual' || mode === 'none') {
      info.mode = mode
    }
    if (off === 'fixed' || off === 'disabled' || off === 'between_tools') {
      info.off = off
    }
    if (typeof files === 'boolean') {
      info.files = files
    }
    if (typeof search === 'boolean') {
      info.search = search
    }
    if (typeof output === 'number' && Number.isSafeInteger(output) && output > 0) {
      info.output = output
    }
    if (!id || !Object.keys(info).length) {
      continue
    }
    result.push([id, info])
    if (!discovered.has(id)) {
      discovered.set(id, info)
    }
  }
  return result.length ? Object.fromEntries(result) : undefined
}
const supported = (value: unknown) =>
  typeof object(value).supported === 'boolean' ? (object(value).supported as boolean) : undefined
export function observeClaudeModel(id: string, raw: Record<string, unknown>) {
  const data = object(raw.capabilities),
    thinking = object(data.thinking),
    types = object(thinking.types)
  const info: Capabilities = {}
  if (supported(thinking) === false) {
    info.mode = 'none'
  } else if (supported(types.adaptive)) {
    info.mode = 'adaptive'
  } else if (supported(types.enabled)) {
    info.mode = 'manual'
  }
  if (supported(types.disabled)) {
    info.off = 'disabled'
  } else if (supported(types.between_tools)) {
    info.off = 'between_tools'
  } else if (supported(types.disabled) === false) {
    info.off = 'fixed'
  }
  const search = supported(object(data.server_tools).web_search)
  if (search !== undefined) {
    info.search = search
  }
  const images = supported(data.image_input),
    pdf = supported(data.pdf_input)
  if (images !== undefined && pdf !== undefined) {
    info.files = images && pdf
  }
  if (
    typeof raw.max_tokens === 'number' &&
    Number.isSafeInteger(raw.max_tokens) &&
    raw.max_tokens > 0
  ) {
    info.output = raw.max_tokens
  }
  discovered.set(id, info)
  return claudeReasoningSupport(id)
}
export const supportsClaudeFiles = (model: string) => !!capabilities(model).files
export const supportsClaudeSearch = (model: string) => !!capabilities(model).search
export function claudeReasoningSupport(model: string): ReasoningSupport | undefined {
  const { mode, off } = capabilities(model)
  if (mode === 'none') {
    return 'none'
  }
  if (mode && off) {
    return off === 'fixed' ? 'fixed' : 'toggle'
  }
  return undefined
}

/** Build the Messages request explicitly. Text history is portable across model and account changes. */
export function claudeRequest(
  body: CreateMessageRequest,
  model: string,
  grant?: string,
  support?: ReasoningSupport
) {
  const caps = capabilities(model)
  const max_tokens = Math.min(body.max_tokens ?? 8192, caps.output ?? Infinity)
  const wantsSummary = body.thinking?.type === 'enabled'
  const canShowSummary = wantsSummary && caps.mode !== 'none' && support !== 'none'
  let thinking:
    | {
        type: 'adaptive' | 'disabled' | 'between_tools' | 'enabled'
        display?: 'summarized'
        budget_tokens?: number
      }
    | undefined
  if (canShowSummary && caps.mode === 'adaptive') {
    thinking = { type: 'adaptive', display: 'summarized' }
  } else if (canShowSummary && caps.mode === 'manual' && max_tokens > 1024) {
    thinking = {
      type: 'enabled',
      budget_tokens: Math.min(4096, max_tokens - 1),
      display: 'summarized',
    }
  } else if (
    caps.mode &&
    caps.mode !== 'none' &&
    caps.off &&
    caps.off !== 'fixed' &&
    support !== 'fixed'
  ) {
    thinking = { type: caps.off }
  }
  const messages = body.messages.flatMap(
    (m): { role: 'user' | 'assistant'; content: string | unknown[] }[] => {
      if (m.role === 'latest_reminder') {
        return []
      }
      if (m.role === 'user') {
        return [{ role: m.role, content: m.content }]
      }
      const content = m.content.filter((b) => b.type === 'text' && b.text.trim())
      return content.length ? [{ role: m.role, content }] : []
    }
  )
  const search =
    grant?.startsWith('anthropic:') &&
    caps.search &&
    body.tools?.some((t) => t.type === 'deepseek_web_search')
  return {
    model,
    max_tokens,
    messages,
    stream: true,
    ...(body.system && { system: body.system }),
    ...(thinking && { thinking }),
    ...(search && { tools: [{ type: 'web_search_20250305', name: 'web_search' }] }),
  }
}
