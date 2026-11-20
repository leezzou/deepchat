import type {
  AssistantBlockParam,
  ServerToolBlock,
  ServerToolInput,
  ServerToolKind,
  WebSearchResult,
} from './types.js'
import { asRecord, firstChoice, publicSourceUrl } from './searchCitations.js'

const str = (value: unknown) => (typeof value === 'string' ? value : '')
const kinds = new Set<ServerToolKind>([
  'search',
  'deep_search',
  'image_search',
  'deep_image_search',
  'read_link',
])
function actionOf(row: Record<string, unknown>): ServerToolInput | undefined {
  if (
    row.type === 'search' &&
    Array.isArray(row.queries) &&
    row.queries.every((q) => typeof q === 'string')
  )
    return { action: 'search', queries: row.queries }
  const url = publicSourceUrl(row.url) || ''
  if (row.type === 'open_page' || row.type === 'read_link') return { action: row.type, url }
  if (row.type === 'find_in_page' && typeof row.pattern === 'string')
    return { action: 'find_in_page', pattern: row.pattern, url }
  return undefined
}
function sourceOf(value: unknown): WebSearchResult[] {
  const row = asRecord(value),
    url = publicSourceUrl(row.url)
  return url
    ? [
        {
          type: 'web_search_result',
          url,
          title: str(row.title) || url,
          snippet: str(row.snippet),
          site_icon: publicSourceUrl(row.site_icon) || null,
          site_name: str(row.site_name) || null,
          encrypted_content: '',
          page_age: str(row.published_at) || null,
        },
      ]
    : []
}

/** DeepSeek sends progress beside delta and a complete signed call list in the final delta. */
export class DeepSeekChatTools {
  private started = new Map<string, Extract<ServerToolBlock, { type: 'server_tool_use' }>>()
  private completed = new Set<string>();
  private *apply(value: unknown, finished: boolean, snapshot: boolean): Generator<ServerToolBlock> {
    const row = asRecord(value)
    const id = str(row.id),
      name = row.type,
      kind = row.kind as ServerToolKind,
      input = actionOf(asRecord(row.action))
    if (!id) return
    if (
      !this.started.has(id) &&
      input &&
      kinds.has(kind) &&
      (name === 'deepseek_web_search' || name === 'deepseek_read_url')
    ) {
      const block = {
        type: 'server_tool_use' as const,
        id,
        name,
        kind,
        input,
        caller: { type: 'direct' as const },
      } satisfies ServerToolBlock
      this.started.set(id, block)
      yield block
    }
    const call = this.started.get(id)
    if (!finished || this.completed.has(id) || !call) return
    const failed = row.status === 'failed'
    if (!failed && row.status !== 'completed') return
    // Only the final summary supplies the encrypted read_link signature needed by the next turn.
    if (call.kind === 'read_link' && !snapshot && !failed) return
    if (call.input.action === 'search' && call.kind !== 'read_link') {
      if (!failed && !Array.isArray(row.sources)) return
      this.completed.add(id)
      yield {
        type: 'web_search_tool_result',
        tool_use_id: id,
        kind: call.kind,
        content: failed
          ? [{ type: 'web_search_tool_result_error', error_code: 'unavailable' }]
          : (row.sources as unknown[]).flatMap(sourceOf),
      }
    } else if (call.kind === 'deep_search' || call.kind === 'read_link') {
      const page = asRecord(row.page),
        url = publicSourceUrl(page.url)
      if (!failed && !url) return
      this.completed.add(id)
      yield {
        type: 'web_fetch_tool_result',
        tool_use_id: id,
        kind: call.kind,
        ...(call.kind === 'read_link' &&
          url &&
          typeof row.signature === 'string' && { signature: row.signature }),
        content:
          failed || !url
            ? { type: 'web_fetch_tool_result_error', error_code: 'unavailable' }
            : {
                type: 'web_fetch_result',
                url,
                published_at: str(page.published_at) || null,
                content: {
                  type: 'document',
                  title: str(page.title) || null,
                  source: { type: 'text', media_type: 'text/plain', data: '' },
                },
              },
      }
    }
  }
  *read(payload: unknown): Generator<ServerToolBlock> {
    const choice = firstChoice(payload),
      event = asRecord(choice.server_tool_event)
    if (event.type === 'call_started' || event.type === 'call_completed')
      yield* this.apply(event.call, event.type === 'call_completed', false)
    for (const part of [asRecord(choice.delta), asRecord(choice.message)]) {
      if (!Array.isArray(part.server_tool_calls)) continue
      for (const step of part.server_tool_calls) {
        const calls = asRecord(step).calls
        if (Array.isArray(calls)) for (const call of calls) yield* this.apply(call, true, true)
      }
    }
  }
}

/** Replay only successful signed link reads that survived the app's native conversation-history filter. */
export function signedChatReads(blocks: AssistantBlockParam[]) {
  const calls = blocks.flatMap((call) => {
    if (
      call.type !== 'server_tool_use' ||
      call.kind !== 'read_link' ||
      call.input.action !== 'read_link'
    )
      return []
    const result = blocks.find(
      (b) => b.type === 'web_fetch_tool_result' && b.tool_use_id === call.id
    )
    if (
      result?.type !== 'web_fetch_tool_result' ||
      !result.signature ||
      result.content.type !== 'web_fetch_result'
    )
      return []
    const page = result.content
    return [
      {
        id: call.id,
        type: call.name,
        kind: call.kind,
        action: { type: 'read_link', url: call.input.url },
        status: 'completed',
        page: { url: page.url, title: page.content.title, published_at: page.published_at },
        signature: result.signature,
      },
    ]
  })
  return calls.length
    ? { server_tool_calls: [{ index: 0, calls: calls.map((call, index) => ({ index, ...call })) }] }
    : {}
}
