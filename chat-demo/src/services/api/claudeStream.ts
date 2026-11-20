import { readMessageEvent } from './parseEvent.js'
import { asRecord, publicSourceUrl } from './searchCitations.js'
import type { MessageStreamEvent, WebSearchResult } from './types.js'

/** Adapt Claude's server tool events to the shared source renderer. Treat opaque material as opaque. */
export class ClaudeStream {
  private queries = new Map<number, { id: string; input: unknown; json: string }>()
  private terminal = false;

  *read(raw: unknown): Generator<MessageStreamEvent> {
    const event = asRecord(raw)
    if (event.type === 'message_delta') {
      const delta = asRecord(event.delta),
        reason = delta.stop_reason
      if (reason === 'pause_turn') {
        throw new Error('Claude paused its server tool turn. / Claude 暂停了本轮工具调用。')
      }
      const mapped =
        reason === 'stop_sequence'
          ? 'end_turn'
          : reason === 'model_context_window_exceeded'
            ? 'max_tokens'
            : reason
      const result = readMessageEvent({ ...event, delta: { ...delta, stop_reason: mapped } })
      if (result?.type === 'message_usage' && reason == null) {
        yield result
        return
      }
      if (result?.type !== 'message_delta') {
        throw new Error(`Claude stop_reason: ${String(reason)}`)
      }
      this.terminal = true
      yield result
      return
    }
    if (event.type === 'message_stop' && !this.terminal) {
      throw new Error('Claude stream ended without a stop reason. / Claude 响应缺少结束原因。')
    }
    const index = event.index
    if (typeof index === 'number' && Number.isSafeInteger(index) && index >= 0) {
      const block = asRecord(event.content_block),
        delta = asRecord(event.delta)
      if (
        event.type === 'content_block_start' &&
        block.type === 'server_tool_use' &&
        block.name === 'web_search' &&
        typeof block.id === 'string'
      ) {
        this.queries.set(index, { id: block.id, input: block.input, json: '' })
        return
      }
      const call = this.queries.get(index)
      if (
        call &&
        event.type === 'content_block_delta' &&
        delta.type === 'input_json_delta' &&
        typeof delta.partial_json === 'string'
      ) {
        if (call.json.length + delta.partial_json.length > 65536) {
          throw new Error('Claude web search input exceeds 64 KiB')
        }
        call.json += delta.partial_json
        return
      }
      if (call && event.type === 'content_block_stop') {
        this.queries.delete(index)
        const { query } = asRecord(call.json ? JSON.parse(call.json) : call.input)
        if (typeof query === 'string') {
          yield {
            type: 'content_block_start',
            index,
            content_block: {
              type: 'server_tool_use',
              name: 'deepseek_web_search',
              id: call.id,
              kind: 'search',
              caller: { type: 'direct' },
              input: { action: 'search', queries: [query] },
            },
          }
        }
      }
      if (
        event.type === 'content_block_start' &&
        block.type === 'web_search_tool_result' &&
        typeof block.tool_use_id === 'string'
      ) {
        const items = block.content
        if (Array.isArray(items)) {
          const sources = items.flatMap((item): WebSearchResult[] => {
            const row = asRecord(item),
              url = publicSourceUrl(row.url)
            if (row.type !== 'web_search_result' || !url) {
              return []
            }
            return [
              {
                type: 'web_search_result',
                url,
                title: typeof row.title === 'string' ? row.title : url,
                page_age: typeof row.page_age === 'string' ? row.page_age : null,
                site_icon: null,
                site_name: null,
                snippet: '',
                encrypted_content: '',
              },
            ]
          })
          yield {
            type: 'content_block_start',
            index,
            content_block: {
              type: 'web_search_tool_result',
              kind: 'search',
              tool_use_id: block.tool_use_id,
              content: sources,
            },
          }
        } else if (asRecord(items).type === 'web_search_tool_result_error') {
          yield {
            type: 'content_block_start',
            index,
            content_block: {
              type: 'web_search_tool_result',
              kind: 'search',
              tool_use_id: block.tool_use_id,
              content: [{ type: 'web_search_tool_result_error', error_code: 'unavailable' }],
            },
          }
        }
        return
      }
      if (delta.type === 'signature_delta' || block.type === 'redacted_thinking') {
        return
      }
      if (block.type === 'thinking') {
        const start = readMessageEvent({
          ...event,
          content_block: { type: 'thinking', thinking: block.thinking, signature: '' },
        })
        if (start) {
          yield start
        }
        return
      }
      if (delta.type === 'citations_delta') {
        const source = asRecord(delta.citation),
          url = publicSourceUrl(source.url)
        if (source.type === 'web_search_result_location' && url) {
          yield {
            type: 'content_block_delta',
            index,
            delta: {
              type: 'citations_delta',
              citation: {
                type: source.type,
                url,
                title: typeof source.title === 'string' ? source.title : null,
                cited_text: typeof source.cited_text === 'string' ? source.cited_text : '',
                encrypted_index: '',
              },
            },
          }
        }
        return
      }
    }
    const value = readMessageEvent(event)
    if (value) {
      yield value
    }
  }
}
