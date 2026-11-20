import type { MessageUsage, StopReason } from './types.js'

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const visible = (value: unknown) =>
  typeof value === 'string' && value.trim() !== '[REDACTED]' ? value : ''

/** OpenRouter can send the same delta in a plaintext alias and in normalized details. */
export function reasoningText(value: unknown): string {
  const delta = record(value)
  const aliases = [delta.reasoning_content, delta.reasoning, delta.thinking].map(visible)
  const plain = aliases.find((text) => text.trim())
  if (plain) {
    return plain
  }
  if (!Array.isArray(delta.reasoning_details)) {
    return aliases.find(Boolean) ?? ''
  }
  return delta.reasoning_details
    .map((item) => {
      const detail = record(item)
      if (detail.type === 'reasoning.text') {
        return visible(detail.text)
      }
      if (detail.type === 'reasoning.summary') {
        return visible(detail.summary)
      }
      return '' // Encrypted data and signatures aren't display text.
    })
    .join('')
}

export function completionStop(reason: unknown): StopReason | 'interrupted' | undefined {
  switch (reason) {
    case null:
    case undefined:
    case '':
      return undefined
    case 'stop':
    case 'eos':
    case 'end_turn':
      return 'end_turn'
    case 'length':
    case 'max_tokens':
      return 'max_tokens'
    case 'refusal':
    case 'content_filter':
      return 'refusal'
    case 'tool_calls':
    case 'function_call':
      return 'tool_use'
    default:
      return 'interrupted' // includes aborted, insufficient_system_resource and error
  }
}

const tokens = (n: unknown) =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : undefined

/** Merge partial compatible snapshots. Cache details may arrive after their inclusive totals. */
export function mergeCompletionUsage(
  previous: MessageUsage | undefined,
  next: MessageUsage
): MessageUsage {
  const usage = { ...previous, ...next }
  if (previous?.server_tool_use && next.server_tool_use) {
    usage.server_tool_use = { ...previous.server_tool_use, ...next.server_tool_use }
  }
  const {
    input_tokens_total: prompt,
    cache_read_input_tokens: read,
    cache_creation_input_tokens: written,
    output_tokens_total: output,
    cache_read_output_tokens: outputRead,
    cache_creation_output_tokens: outputWritten,
  } = usage
  if (
    prompt !== undefined &&
    (read !== undefined || written !== undefined) &&
    (read ?? 0) + (written ?? 0) <= prompt
  ) {
    usage.input_tokens = prompt - (read ?? 0) - (written ?? 0)
  }
  if (
    output !== undefined &&
    (outputRead !== undefined || outputWritten !== undefined) &&
    (outputRead ?? 0) + (outputWritten ?? 0) <= output
  ) {
    usage.output_tokens = output - (outputRead ?? 0) - (outputWritten ?? 0)
  }
  return usage
}

/** Chat Completions' prompt total includes cache reads/writes; MessageUsage counts them separately. */
export function completionUsage(value: unknown): MessageUsage | undefined {
  const u = record(value)
  const prompt = tokens(u.prompt_tokens) ?? tokens(u.input_tokens)
  const output = tokens(u.completion_tokens) ?? tokens(u.output_tokens)
  const inputDetails = record(u.prompt_tokens_details ?? u.input_tokens_details)
  const outputDetails = record(u.completion_tokens_details ?? u.output_tokens_details)
  const hit = tokens(u.prompt_cache_hit_tokens) ?? tokens(inputDetails.cached_tokens)
  const miss = tokens(u.prompt_cache_miss_tokens)
  const write = tokens(inputDetails.cache_write_tokens)
  const outputRead = tokens(u.cache_read_output_tokens) ?? tokens(outputDetails.cached_tokens)
  const outputWrite =
    tokens(u.cache_creation_output_tokens) ?? tokens(outputDetails.cache_write_tokens)
  const usage: MessageUsage = {}
  // DeepSeek defines its input split as hits/misses. OpenAI-family totals include all billed cache categories.
  if (prompt !== undefined) {
    usage.input_tokens_total = prompt
  }
  if (output !== undefined) {
    usage.output_tokens_total = output
  }
  if (prompt === undefined || (hit ?? 0) + (write ?? 0) <= prompt) {
    if (hit !== undefined) {
      usage.cache_read_input_tokens = hit
    }
    if (write !== undefined) {
      usage.cache_creation_input_tokens = write
    }
    if (
      miss !== undefined &&
      miss >= (write ?? 0) &&
      (prompt === undefined || miss + (hit ?? 0) <= prompt)
    ) {
      usage.input_tokens = miss - (write ?? 0)
    } else if (prompt !== undefined && (hit !== undefined || write !== undefined || prompt === 0)) {
      usage.input_tokens = prompt - (hit ?? 0) - (write ?? 0)
    }
  }
  if (output === undefined || (outputRead ?? 0) + (outputWrite ?? 0) <= output) {
    if (outputRead !== undefined) {
      usage.cache_read_output_tokens = outputRead
    }
    if (outputWrite !== undefined) {
      usage.cache_creation_output_tokens = outputWrite
    }
    // Standard completion_tokens includes all generated/reasoning tokens. Only explicit output-cache metrics partition it.
    if (output !== undefined) {
      usage.output_tokens = output - (outputRead ?? 0) - (outputWrite ?? 0)
    }
  }
  const tools = record(u.server_tool_use)
  const searches = tokens(tools.web_search_requests)
  const work = tokens(tools.tool_search)
  if (searches !== undefined || work !== undefined) {
    usage.server_tool_use = {
      ...(searches !== undefined && { web_search_requests: searches }),
      ...(work !== undefined && { tool_search: work }),
    }
  }
  return Object.keys(usage).length ? usage : undefined
}
