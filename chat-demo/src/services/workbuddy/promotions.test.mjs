import assert from 'node:assert/strict'
import test from 'node:test'
import { promotionRate } from './promotions.ts'

test('damaged and legacy promotion caches keep the base rate and skip invalid windows', () => {
  const now = Date.parse('2026-11-20T23:00:00+08:00')
  for (const daily of [{}, '23:00', [null], [{ start: '23:00', end: '08:00' }], [[24, 1440]], [[-1, -1]], [['23:00', '08:00']], [[0]], [44]]) {
    assert.deepEqual(promotionRate(0.29, [{ daily, factor: 0 }], now).rate, { multiplier: 0.29 })
  }
  assert.deepEqual(promotionRate(0.29, [{ schedule: { daily: [] }, price: 0 }], now).rate, { multiplier: 0.29 })
  assert.deepEqual(promotionRate(0.29, [{ timezone: 'Asia/Shanghai', daily: [null, [1380, 480]], price: 0 }], now).rate, { multiplier: 0, free: true })
})

test('recomputes night discounts from China local time, date validity and active priority', () => {
  const start = Date.parse('2026-11-01T00:00:00+08:00'),
    end = Date.parse('2026-11-30T08:00:00+08:00')
  const schedule = {
    timezone: 'Asia/Shanghai',
    validFrom: new Date(start).toISOString(),
    validUntil: new Date(end).toISOString(),
    daily: [[1380, 480]],
    priority: 3,
    price: 0,
  }
  const day = Date.parse('2026-11-20T22:59:59.999+08:00')
  const night = day + 1,
    morning = Date.parse('2026-11-21T08:00:00+08:00')
  assert.deepEqual(promotionRate(0.29, [schedule], day), {
    rate: { multiplier: 0.29 },
    nextChange: night,
  })
  assert.deepEqual(promotionRate(0.29, [schedule], night), {
    rate: { multiplier: 0, free: true },
    nextChange: morning,
  })
  assert.equal(promotionRate(0.29, [schedule], morning).rate.multiplier, 0.29)
  assert.equal(promotionRate(0.29, [schedule], end).rate.multiplier, 0.29)
  assert.equal(promotionRate(0.29, [schedule], start - 1).rate.multiplier, 0.29)
  assert.equal(
    promotionRate(0.79, [{ priority: 1, factor: 0.5 }, schedule], day).rate.multiplier,
    0.395
  )
  assert.equal(promotionRate(0.79, [schedule, { priority: 4 }], night).rate.multiplier, 0.79)
  assert.equal(promotionRate(undefined, [{ factor: 0.5 }], night).rate, undefined)
  assert.deepEqual(promotionRate(undefined, [{ price: 0 }], night).rate, {
    multiplier: 0,
    free: true,
  })
})
