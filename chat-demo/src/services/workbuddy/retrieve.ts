import type { CreateMessageRequest, MessageStreamEvent, OutputBlockStart } from '../api/types.js'
import { workBuddyFetch } from './bridge.js'
import { searchPlan, throwIfGrantChanged, type Grant } from './plan.js'
import {
  byteLength,
  clip,
  searchSources,
  withSearchEvidence,
  type Row,
  type SearchHit,
} from './search.js'

async function toolData(response: Response) {
  const data = await response.json()
  if (!response.ok || data?.error || (data?.code != null && data.code !== 0)) {
    const error = data?.error || data
    const detail = String(error?.message || error?.msg || '')
      .replace(/Bearer\s+\S+|\beyJ[\w-]+\.[\w-]+\.[\w-]+/gi, '[redacted]')
      .slice(0, 300)
    throw new Error(`WorkBuddy · HTTP ${response.status} · ${String(error?.code ?? '')} ${detail}`)
  }
  return data
}

export async function* retrieve(
  access: Grant,
  body: CreateMessageRequest,
  rows: Row[],
  requestId: string,
  signal: AbortSignal
): AsyncGenerator<
  MessageStreamEvent,
  { messages: Row[]; nextIndex: number; hits: SearchHit[]; ids: Set<string> }
> {
  const plan = await searchPlan(access, body, rows, signal)
  const deadline = Date.now() + 45000
  const request = async (
    operation: { op: 'read'; readKey: string } | { op: 'search'; query: string }
  ) => {
    signal.throwIfAborted()
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(
      abort,
      Math.max(0, Math.min(operation.op === 'read' ? 10000 : 20000, deadline - Date.now()))
    )
    try {
      return await toolData(
        await workBuddyFetch(access.model, access.revision, operation, controller.signal)
      )
    } finally {
      signal.removeEventListener('abort', abort)
      clearTimeout(timer)
    }
  }
  const hits: SearchHit[] = []
  const seen = new Set<string>()
  let nextIndex = 0
  function* block(content_block: OutputBlockStart): Generator<MessageStreamEvent> {
    yield { type: 'content_block_start', index: nextIndex, content_block }
    yield { type: 'content_block_stop', index: nextIndex++ }
  }
  const queries = [...plan.queries]
  if (queries.length === 1) {
    const angle = /[\u3400-\u9fff]/u.test(queries[0]) ? '官方资料' : 'primary source documentation'
    const alternative = `${clip(queries[0], 200)} ${angle}`
    if (!queries[0].toLowerCase().includes(angle)) {
      queries.push(alternative)
    }
  }
  for (const [round, query] of queries.entries()) {
    signal.throwIfAborted()
    if (round > 0 && Date.now() >= deadline) {
      break
    }
    const id = `${requestId}-s${round}`
    yield* block({
      type: 'server_tool_use',
      id,
      name: 'deepseek_web_search',
      kind: 'search',
      caller: { type: 'direct' },
      input: { action: 'search', queries: [query] },
    })
    try {
      const data = await request({ op: 'search', query })
      signal.throwIfAborted()
      const batch = searchSources(data, seen, round)
      hits.push(...batch)
      yield* block({
        type: 'web_search_tool_result',
        tool_use_id: id,
        kind: 'search',
        content: batch.map((hit) => hit.source),
      })
      // An independent facet deserves its own query. Otherwise only use the next query for weak evidence.
      if (
        (!plan.multi && hits.filter((hit) => hit.source.snippet.length >= 24).length >= 2) ||
        (round > 0 && !batch.length)
      ) {
        break
      }
    } catch (error) {
      throwIfGrantChanged(error, signal)
      yield* block({
        type: 'web_search_tool_result',
        tool_use_id: id,
        kind: 'search',
        content: [{ type: 'web_search_tool_result_error', error_code: 'unavailable' }],
      })
      if (!hits.length) {
        throw new Error(
          `WorkBuddy 搜索 / Search · ${error instanceof Error ? error.message : String(error)}`
        )
      }
      break
    }
  }
  const needPage =
    plan.read || (hits.length > 0 && hits.every(({ source }) => source.snippet.length < 48))
  if (needPage) {
    const candidates = hits.filter((hit) => hit.readKey)
    // Prefer independent sites, retaining provider rank within each group.
    const sites = new Set<string | null>()
    const firstPerSite = candidates.filter(({ source }) => {
      if (sites.has(source.site_name)) {
        return false
      }
      sites.add(source.site_name)
      return true
    })
    const thorough =
      /逐[一篇条个项]|每[篇个一项]|全面|全部|所有|\b(?:each|every|all sources|comprehensive)\b/i.test(
        rows[plan.index].content
      )
    let budget = thorough ? 8400 : plan.read ? 3200 : 1500
    let failures = 0
    const preferred = new Set(firstPerSite)
    for (const hit of [...firstPerSite, ...candidates.filter((item) => !preferred.has(item))]) {
      signal.throwIfAborted()
      if (budget < 256 || Date.now() >= deadline || failures >= 2) {
        break
      }
      if (!hit.readKey) {
        continue
      }
      const id = `${requestId}-r${nextIndex}`
      yield* block({
        type: 'server_tool_use',
        id,
        name: 'deepseek_web_search',
        kind: 'deep_search',
        caller: { type: 'direct' },
        input: { action: 'open_page', url: hit.source.url },
      })
      try {
        const data = await request({ op: 'read', readKey: hit.readKey })
        signal.throwIfAborted()
        if (typeof data.text !== 'string' || !data.text.trim()) {
          throw new Error('Empty page')
        }
        hit.page = clip(data.text.trim(), Math.min(budget, thorough ? 800 : 2200))
        budget -= Math.max(320, byteLength(hit.page))
        failures = 0
        yield* block({
          type: 'web_fetch_tool_result',
          tool_use_id: id,
          kind: 'deep_search',
          content: {
            type: 'web_fetch_result',
            url: hit.source.url,
            published_at: hit.source.page_age,
            content: {
              type: 'document',
              title: hit.source.title,
              source: { type: 'text', media_type: 'text/plain', data: '' },
            },
          },
        })
      } catch (error) {
        throwIfGrantChanged(error, signal)
        failures++
        budget -= 320
        yield* block({
          type: 'web_fetch_tool_result',
          tool_use_id: id,
          kind: 'deep_search',
          content: { type: 'web_fetch_tool_result_error', error_code: 'unavailable' },
        })
      }
    }
  }
  return { ...withSearchEvidence(rows, plan.index, hits), hits, nextIndex }
}
