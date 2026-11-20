import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

registerHooks({
  resolve(id, ctx, next) {
    if (id === './totals.js' && ctx.parentURL?.endsWith('/usage/chartData.ts')) {
      return next(new URL('./totals.ts', ctx.parentURL).href, ctx)
    }
    return next(id, ctx)
  },
})
const { usageTimeline, usageRanking } = await import('./chartData.ts')

const ms = (day, hour = 0) => +new Date(2026, 10, day, hour)
const now = ms(20, 15)

test('hour and day buckets are ordered, local, and distinguish absent counters from reported zero', () => {
  const rows = [
    { at: ms(20, 9), output: 0 },
    { at: ms(20, 9) + 10, input: 81 },
    { at: ms(20, 11) },
    { at: ms(21), output: 128 },
    { at: ms(17), input: 33 },
  ]
  const today = usageTimeline(rows, 1, now)
  const nine = today.find((slot) => slot.start === ms(20, 9))
  assert.deepEqual(nine, {
    start: ms(20, 9),
    end: ms(20, 10),
    requests: 2,
    input: 81n,
    inputReported: 1,
    output: 0n,
    outputReported: 1,
  })
  assert.equal(today.find((slot) => slot.start === ms(20, 11)).input, undefined)
  assert.equal(today.find((slot) => slot.start === ms(20, 11)).requests, 1)
  assert.equal(today.find((slot) => slot.start === ms(20, 10)).requests, 0)
  assert.equal(
    today.reduce((a, b) => a + b.requests, 0),
    3
  )
  const week = usageTimeline(rows, 7, now)
  assert.equal(week.length, 7)
  assert.equal(week.at(-1).start, ms(20))
  assert.equal(week[3].input, 33n)
  assert.equal(week.at(-1).input, 81n)
  assert.equal(usageTimeline(rows, 30, now).length, 30)
})

test('long histories use at most 32 calendar buckets and include both boundaries', () => {
  const first = +new Date(2001, 1, 27, 17)
  const timeline = usageTimeline(
    [
      { at: first, output: 15 },
      { at: now, output: 20 },
      { at: NaN, output: 999 },
    ],
    'all',
    now
  )
  assert.ok(timeline.length <= 32)
  assert.equal(timeline[0].start, +new Date(2001, 1, 1))
  assert.equal(timeline.at(-1).end, ms(21))
  assert.equal(timeline[0].output, 15n)
  assert.equal(timeline.at(-1).output, 20n)
  for (let i = 1; i < timeline.length; ++i) {
    assert.equal(timeline[i - 1].end, timeline[i].start)
  }
})

test('rankings preserve opaque IDs, exact totals, partially reported groups and unreported groups', () => {
  const max = Number.MAX_SAFE_INTEGER
  const rows = [
    { provider: '__proto__', model: 'A', input: max, output: 2 },
    { provider: '__proto__', model: 'A', input: max },
    { provider: 'local', model: 'A', output: 15 },
    { provider: 'unknown', model: '' },
    { provider: 'zero', model: 'a', output: 0 },
  ]
  const ranks = usageRanking(rows, 'provider')
  assert.deepEqual(
    ranks.map((r) => r.id),
    ['__proto__', 'local', 'zero', 'unknown']
  )
  assert.equal(ranks[0].input, 2n * BigInt(max))
  assert.equal(ranks[0].outputReported, 1)
  const models = usageRanking(rows, 'model')
  assert.deepEqual(
    models.map((r) => r.id),
    ['A', 'a', '']
  )
  assert.equal(models[0].requests, 3)
  assert.equal(models[0].output, 17n)
  assert.equal(models[1].output, 0n)
  assert.equal(models[2].output, undefined)
})

test('daylight-saving transitions retain every real hour including the repeated hour', () => {
  const before = process.env.TZ
  try {
    process.env.TZ = 'America/New_York'
    for (const [month, day, hours] of [
      [2, 8, 23],
      [10, 1, 25],
    ]) {
      const buckets = usageTimeline([], 1, +new Date(2026, month, day, 23, 55))
      assert.equal(buckets.length, hours)
      assert.equal(buckets.at(-1).end, +new Date(2026, month, day + 1))
    }
  } finally {
    if (before === undefined) {
      delete process.env.TZ
    } else {
      process.env.TZ = before
    }
  }
})
