import assert from 'node:assert/strict'
import test from 'node:test'
import { readMessageEvent } from '../api/parseEvent.ts'
import { applyEvent } from './reply.ts'

const request = (start, delta, previous) => {
  const indexes = new Map()
  const reply = applyEvent({ status: 'pending', usage: previous }, readMessageEvent({ type: 'message_start', message: { usage: start } }), 0, indexes)
  return applyEvent(reply, readMessageEvent({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: delta }), 1, indexes).usage
}

test('final cumulative output preserves input and cache counts from the same request', () => {
  const start = { input_tokens: 24, cache_read_input_tokens: 16, cache_creation_input_tokens: 8, output_tokens: 1 }
  assert.deepEqual(request(start, { output_tokens: 29 }), { ...start, output_tokens: 29 })
  assert.deepEqual(request({ input_tokens: 11, output_tokens: 0 }, { output_tokens: 5 }), {
    input_tokens: 11, output_tokens: 5,
  })
  assert.deepEqual(request(undefined, start), start)
  assert.deepEqual(request(undefined, { output_tokens: 5 }, start), { output_tokens: 5 })
  assert.deepEqual(request(start, { output_tokens: -1 }), start)
})
