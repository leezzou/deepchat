import { getVisibleMessages } from './branches.js'
import type { Message, Session, SessionSummary } from './types.js'

export type SearchSnippet = { text: string; before: boolean; after: boolean }
export type HistorySearchResult = {
  sessionId: string
  title: string
  messageId: string | null
  role: Message['role'] | 'title'
  createdAt: number
  alternateBranch: boolean
  snippet: SearchSnippet
}
export type HistorySearchBatch = {
  results: HistorySearchResult[]
  scanned: number
  total: number
  failed: number
}

/** Literal, case-insensitive matches; user input is never interpreted as a regular expression. */
export const findSearchMatches = (text: string, query: string, limit = 500): [number, number][] => {
  const needle = query.trim()
  if (!needle) {
    return []
  }
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const matches: [number, number][] = []
  for (const match of text.matchAll(new RegExp(escaped, 'giu'))) {
    matches.push([match.index, match.index + match[0].length])
    if (matches.length >= limit) {
      break
    }
  }
  return matches
}

export const createSearchSnippet = (text: string, query: string): SearchSnippet => {
  const normalized = text.replace(/\s+/g, ' ').trim()
  const match = findSearchMatches(normalized, query.replace(/\s+/g, ' '), 1)[0]
  const start = Math.max(0, (match?.[0] ?? 0) - 48)
  const end = Math.min(normalized.length, Math.max(start + 180, (match?.[1] ?? 0) + 48))
  return { text: normalized.slice(start, end), before: start > 0, after: end < normalized.length }
}

/** Search all stored versions, including thought text and attachment names; no file blobs are read. */
export const getSearchableMessageText = (message: Message): string =>
  message.role === 'user'
    ? [message.content, ...message.files.map((file) => file.name)].filter(Boolean).join('\n')
    : message.blocks
        .flatMap((block) =>
          block.type === 'text' ? [block.text] : block.type === 'thinking' ? [block.thinking] : []
        )
        .join('\n')

const throwIfAborted = (signal: AbortSignal) => {
  if (signal.aborted) {
    throw new DOMException('Search cancelled', 'AbortError')
  }
}
const yieldToInput = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/**
 * Only one session detail is retained while scanning. Yield at most 40 matches per batch,
 * and yield progress every 200 messages / 8 sessions so large histories remain cancellable.
 * The reader is injected: callers can prefer unsaved cached data without populating that cache.
 */
export async function* searchHistory({
  sessions,
  query,
  signal,
  readSession,
}: {
  sessions: readonly SessionSummary[]
  query: string
  signal: AbortSignal
  readSession: (id: string) => Promise<Session | undefined>
}): AsyncGenerator<HistorySearchBatch> {
  const keyword = query.trim().replace(/\s+/g, ' ')
  if (!keyword) {
    return
  }
  let results: HistorySearchResult[] = []
  let scanned = 0
  let failed = 0
  let examined = 0
  for (const summary of sessions) {
    throwIfAborted(signal)
    let session: Session | undefined
    try {
      session = await readSession(summary.id)
    } catch {
      throwIfAborted(signal)
      failed += 1
    }
    throwIfAborted(signal)
    if (session) {
      const visible = new Set(getVisibleMessages(session).map((message) => message.id))
      if (findSearchMatches(summary.title, keyword, 1).length) {
        results.push({
          sessionId: summary.id,
          title: summary.title,
          messageId: null,
          role: 'title',
          createdAt: summary.updatedAt,
          alternateBranch: false,
          snippet: createSearchSnippet(summary.title, keyword),
        })
        if (results.length >= 40) {
          yield { results, scanned, total: sessions.length, failed }
          results = []
          await yieldToInput()
        }
      }
      for (const message of session.messages) {
        throwIfAborted(signal)
        const text = getSearchableMessageText(message).replace(/\s+/g, ' ')
        if (findSearchMatches(text, keyword, 1).length) {
          results.push({
            sessionId: summary.id,
            title: summary.title,
            messageId: message.id,
            role: message.role,
            createdAt: message.createdAt,
            alternateBranch: !visible.has(message.id),
            snippet: createSearchSnippet(text, keyword),
          })
        }
        examined += 1
        if (results.length >= 40 || examined % 200 === 0) {
          yield { results, scanned, total: sessions.length, failed }
          results = []
          await yieldToInput()
        }
      }
    }
    scanned += 1
    if (scanned % 8 === 0 || scanned === sessions.length) {
      yield { results, scanned, total: sessions.length, failed }
      results = []
      await yieldToInput()
    }
  }
}
