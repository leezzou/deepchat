import type { CreateMessageRequest, MessageStreamEvent, OutputBlockStart } from '../api/types.js'
import { assessHits, enoughEvidence, pagePassage, readOrder, supplemental } from './quality.js'
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
  // Multiple independently necessary angles plus a request for primary verification warrant broader reading.
  const thorough = plan.signals.thorough || (plan.read && plan.multi)
  const deadline = Date.now() + (thorough ? 45000 : 30000)
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
    queries.push(supplemental(queries[0], plan.signals))
  }
  const { dateHint } = plan.signals
  const dated = (query: string) =>
    dateHint && !/(?:19|20)\d\d/.test(query) ? `${clip(query, 218)} ${dateHint}` : query
  let ranked: ReturnType<typeof assessHits> = []
  let nextQuery = 0
  async function* searchNext(): AsyncGenerator<MessageStreamEvent, boolean> {
    signal.throwIfAborted()
    const round = nextQuery++
    const query = dated(queries[round])
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
      ranked = assessHits(hits, plan)
      return true
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
      nextQuery = queries.length
      return false
    }
  }
  while (nextQuery < queries.length && Date.now() < deadline) {
    if (!(yield* searchNext()) || (!plan.multi && enoughEvidence(ranked, plan))) {
      break
    }
  }
  const verify =
    plan.signals.compare || plan.signals.price || plan.signals.measured || plan.signals.fresh
  const needPage =
    thorough || plan.read || verify || (hits.length > 0 && !enoughEvidence(ranked, plan))
  if (needPage) {
    let budget = thorough ? 8400 : plan.read || verify ? 4000 : 1500
    let failures = 0,
      opened = 0
    for (const hit of readOrder(ranked, plan.subjects, thorough)) {
      signal.throwIfAborted()
      if (
        budget < 256 ||
        Date.now() >= deadline ||
        failures >= 2 ||
        (!thorough && opened >= (plan.read || verify ? 3 : 2))
      ) {
        break
      }
      if (!hit.readKey) {
        continue
      }
      opened++
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
        hit.page = pagePassage(data.text, plan, Math.min(budget, thorough ? 800 : 1500))
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
    // A promising listing can still be unreadable. Use the next planned angle once within the same deadline.
    if (
      opened > 0 &&
      !hits.some((hit) => hit.page) &&
      nextQuery < queries.length &&
      Date.now() < deadline
    ) {
      yield* searchNext()
    }
  }
  return {
    ...withSearchEvidence(
      rows,
      plan.index,
      hits,
      plan.signals.today,
      ranked.map((row) => row.hit)
    ),
    hits,
    nextIndex,
  }
}
