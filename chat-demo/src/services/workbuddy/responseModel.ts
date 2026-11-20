import { type ServerSentEvent } from '../api/sse.js'
import { workBuddyCatalogIds } from './models.js'

// Product spellings are deliberately indexed by the full request ID. Hy3-x and
// Hy4-preview-x have separately priced catalog rows with the same display names.
// The versioned Hy3 snapshot is listed in Tencent's Hy Token Plan model table.
const hunyuanNames = new Map<string, readonly string[]>([
  ['hy3', ['Hy3', 'hy3-202608']],
  ['hy3-preview', ['Hy3 preview']],
  ['hy4', ['Hy4']],
  ['hy4-flash', ['Hy4 flash']],
  ['hy4-preview', ['Hy4 preview']],
  ['hunyuan-chat', ['Hunyuan-Turbos', 'hunyuan-turbos']],
  ['hunyuan-2.0-thinking', ['Hunyuan-2.0-Thinking']],
  ['hunyuan-2.0-instruct', ['Hunyuan-2.0-Instruct']],
])

// Untrusted SSE can echo arbitrary user text, URLs or a credential in `model`.
// Only show short identifier-like strings, including a small number of label words.
export function publicModelLabel(value: unknown) {
  return typeof value === 'string' &&
    value.length <= 80 &&
    /^[a-z0-9][a-z0-9._-]*(?: [a-z0-9][a-z0-9._-]*){0,2}$/i.test(value) &&
    !/(?:bearer|(?:^|[-_.])(?:token|secret|key)(?:$|[-_.])|^sk-|^eyJ|[a-z\d]{25})/i.test(value)
    ? value
    : '[redacted]'
}

export class WorkBuddyModelMismatch extends Error {
  constructor(requested: string, returned: unknown) {
    super(
      `WorkBuddy · 腾讯返回的模型与所选路由不符 / Model mismatch (${publicModelLabel(requested)} → ${publicModelLabel(returned)})`
    )
  }
}

// Capture known sibling IDs before network I/O. Names and prices from a later
// status/catalog update must never retroactively change an in-flight decision.
export function workBuddyResponseModel(requested: string) {
  const otherIds = new Set(workBuddyCatalogIds().filter((id) => id !== requested))
  const names = hunyuanNames.get(requested) ?? []
  return (returned: unknown, origin: string | null): string | undefined => {
    // The SDK initializes the response-model metadata to "". Gateway preambles
    // and usage-only tails may carry that sentinel or omit the field altogether.
    if (returned == null || returned === '' || returned === requested) {
      return
    }
    if (
      typeof returned === 'string' &&
      !otherIds.has(returned) &&
      (names.includes(returned) || (returned === origin && publicModelLabel(returned) === returned))
    ) {
      return returned
    }
    throw new WorkBuddyModelMismatch(requested, returned)
  }
}

export class WorkBuddyServiceError extends Error {}

export function serviceError(data: unknown, status?: number) {
  const body = data && typeof data === 'object' ? (data as Record<string, unknown>) : {}
  const details =
    body.error && typeof body.error === 'object' ? (body.error as Record<string, unknown>) : body
  const safe = (v: unknown) =>
    typeof v === 'string' || typeof v === 'number'
      ? String(v)
          .replace(/Bearer\s+\S+|\beyJ[\w-]+\.[\w-]+\.[\w-]+/gi, '[redacted]')
          .slice(0, 300)
      : ''
  return new WorkBuddyServiceError(
    [
      'WorkBuddy',
      status && `HTTP ${status}`,
      safe(details.code ?? details.type),
      safe(details.message ?? details.msg ?? details.error_msg ?? body.error),
    ]
      .filter(Boolean)
      .join(' · ')
  )
}

/** Only a successful completion frame can attribute output/usage to a model. */
export function workBuddyChunk(frame: ServerSentEvent) {
  const chunk = JSON.parse(frame.data)
  if (!chunk || typeof chunk !== 'object' || Array.isArray(chunk)) {
    throw new Error('WorkBuddy · Invalid response')
  }
  if (frame.event === 'error' || chunk.error || (chunk.code != null && chunk.code !== 0)) {
    throw serviceError(chunk)
  }
  return chunk
}
