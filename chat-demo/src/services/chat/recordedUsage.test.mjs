import assert from 'node:assert/strict'
import test from 'node:test'
import { countRecordedReplies, makeUsageDays, sumUsageDays, totalTokens } from './recordedUsage.ts'

const usage = (input, write, read, output) => ({
  input_tokens: input, cache_creation_input_tokens: write, cache_read_input_tokens: read, output_tokens: output,
})
const reply = (createdAt, usage, extra = {}) => ({ role: 'assistant', createdAt, usage, ...extra })

// The test runner isolates this file's process. Havana advances its clock at midnight in March.
process.env.TZ = 'America/Havana'
const now = new Date(2026, 2, 16, 12).getTime()

test('groups original reply creation times into 30 local dates through the snapshot time', () => {
  const days = makeUsageDays(now)
  const dates = [...days.keys()]
  assert.equal(dates.length, 30)
  assert.equal(dates[0], +new Date(2026, 1, 15))
  assert.equal(dates.at(-7), +new Date(2026, 2, 10))
  assert.equal(dates.at(-1), +new Date(2026, 2, 16))
  assert.equal(new Date(2026, 2, 8).getHours(), 1)
  assert.ok(days.has(+new Date(2026, 2, 9)))
  const value = usage(1, 2, 3, 4)
  countRecordedReplies(days, [
    reply(dates[0] - 1, value), reply(dates[0], value), reply(+new Date(2026, 2, 8, 23), value),
    reply(dates.at(-7), value), reply(now, value), reply(now + 1, value), reply(NaN, value),
  ], now)
  assert.equal(totalTokens(sumUsageDays([...days])), 40n)
  assert.equal(totalTokens(sumUsageDays([...days].slice(-7))), 20n)
})

test('counts each stored reply version once, including reported zero and partial streams', () => {
  const days = makeUsageDays(now)
  const value = usage(2, 4, 8, 16)
  countRecordedReplies(days, [
    reply(now, value, { parentId: 'question', status: 'done' }),
    reply(now, usage(5, 0, 1, 0), { parentId: 'question', status: 'stopped' }),
    reply(now, usage(0, 0, 0, 0)), reply(now, undefined, { blocks: [{ text: 'no estimation' }] }),
    { role: 'user', createdAt: now, usage: value },
  ], now)
  assert.deepEqual(sumUsageDays([...days]), { replies: 3, input: 7n, cacheWrite: 4n, cacheRead: 9n, output: 16n })
})

test('skips malformed or incomplete counters and sums valid counts exactly', () => {
  const days = makeUsageDays(now)
  const max = Number.MAX_SAFE_INTEGER
  countRecordedReplies(days, [
    ...[-1, NaN, Infinity, max + 1, '1', 0.5, undefined].map(n => reply(now, usage(1, 0, 0, n))),
    reply(now, usage(max, max, max, max)), reply(now, usage(max, 1, 0, 0)),
  ], now)
  const counts = sumUsageDays([...days])
  assert.equal(counts.replies, 2)
  assert.equal(totalTokens(counts), BigInt(max) * 5n + 1n)
})
