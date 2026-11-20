import type { MessageStreamEvent } from './types.js'

/** Delay an empty native thinking block until a visible token arrives. Never persist unsolicited traces. */
export class ThinkingEvents {
  private pending = new Map<number, Extract<MessageStreamEvent, { type: 'content_block_start' }>>()
  private hidden = new Set<number>()
  constructor(private enabled: boolean) {}

  *read(event: MessageStreamEvent): Generator<MessageStreamEvent> {
    if (event.type === 'content_block_start') {
      this.hidden.delete(event.index)
      this.pending.delete(event.index)
      if (event.content_block.type === 'thinking') {
        if (!this.enabled) {
          this.hidden.add(event.index)
          return
        }
        if (!event.content_block.thinking.trim()) {
          this.pending.set(event.index, event)
          return
        }
      }
    } else if (event.type === 'content_block_stop') {
      if (this.hidden.delete(event.index) || this.pending.delete(event.index)) {
        return
      }
    } else if (event.type === 'content_block_delta') {
      if (this.hidden.has(event.index)) {
        return
      }
      const start = this.pending.get(event.index)
      if (start) {
        if (event.delta.type !== 'thinking_delta' || !event.delta.thinking.trim()) {
          return
        }
        this.pending.delete(event.index)
        yield start
      }
    }
    yield event
  }
}
