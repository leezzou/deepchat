import type { MessageStreamEvent } from '../api/types.js'
import type { SearchHit } from './search.js'

/** Turn only markers for evidence actually supplied to the model into native citation events. */
export class AnswerBlocks {
  private kind?: 'text' | 'thinking'
  private fragment = ''
  private citedText = ''
  private afterCitation = false
  emitted = false

  constructor(
    private index: number,
    private hits: SearchHit[],
    private ids: Set<string>,
    private searched = false
  ) {}

  private *stop(): Generator<MessageStreamEvent> {
    if (this.kind) {
      yield { type: 'content_block_stop', index: this.index }
    }
    this.kind = undefined
    this.citedText = ''
  }

  private *append(kind: 'text' | 'thinking', text: string): Generator<MessageStreamEvent> {
    if (!text || (kind === 'thinking' && this.kind !== kind && !text.trim())) {
      return
    }
    if (this.kind !== kind || this.afterCitation) {
      yield* this.stop()
      this.afterCitation = false
      this.kind = kind
      this.index++
      yield {
        type: 'content_block_start',
        index: this.index,
        content_block:
          kind === 'text'
            ? { type: 'text', text: '' }
            : { type: 'thinking', thinking: '', signature: '' },
      }
    }
    this.emitted = true
    if (kind === 'text' && this.ids.size) {
      this.citedText = (this.citedText + text).slice(-512)
    }
    yield {
      type: 'content_block_delta',
      index: this.index,
      delta:
        kind === 'text' ? { type: 'text_delta', text } : { type: 'thinking_delta', thinking: text },
    }
  }

  *push(kind: 'text' | 'thinking', text: string): Generator<MessageStreamEvent> {
    if (kind !== 'text' || !this.searched) {
      if (this.fragment) {
        yield* this.append('text', this.fragment)
        this.fragment = ''
      }
      yield* this.append(kind, text)
      return
    }
    const value = this.fragment + text
    const suffix = value.match(/\[(?:S\d{0,6})?$/)?.[0] || ''
    this.fragment = suffix
    const chunk = value.slice(0, value.length - suffix.length)
    let offset = 0
    for (const marker of chunk.matchAll(/\[(S\d{1,6})\]/g)) {
      yield* this.append('text', chunk.slice(offset, marker.index))
      offset = marker.index + marker[0].length
      const source = this.hits[Number(marker[1].slice(1)) - 1]?.source
      if (source && this.ids.has(marker[1]) && this.kind === 'text') {
        yield {
          type: 'content_block_delta',
          index: this.index,
          delta: {
            type: 'citations_delta',
            citation: {
              type: 'web_search_result_location',
              url: source.url,
              title: source.title,
              cited_text: this.citedText.trim(),
              encrypted_index: '',
            },
          },
        }
        // Attach consecutive citations to this text block; following prose starts a new one.
        this.afterCitation = true
      }
    }
    yield* this.append('text', chunk.slice(offset))
  }

  *finish(): Generator<MessageStreamEvent> {
    if (this.fragment) {
      yield* this.append('text', this.fragment)
    }
    yield* this.stop()
  }
}
