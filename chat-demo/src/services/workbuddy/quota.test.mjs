import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { FLASH_QUOTA_MODEL, observeFlashLimit, observeFlashReply, readFlashMeter } from './quota.ts'

const store = new Map()
globalThis.localStorage = {
  getItem: (k) => store.get(k) ?? null,
  setItem: (k, v) => store.set(k, v),
}
const flash = { revision: 'grant-a', model: FLASH_QUOTA_MODEL }
const pro = { ...flash, model: 'deepseek-v4-pro' }
const b = { ...flash, revision: 'grant-b' }
const evening = Date.parse('2026-09-19T23:50:00+08:00')
const midnight = Date.parse('2026-09-20T00:00:00+08:00')
const reset = Date.parse('2026-09-20T17:22:50+08:00')
const msg =
  '您的使用量已超出频率限制，将在 2026-09-20 17:22:50 UTC+8 重置，您也可以切换其他模型继续使用。'
beforeEach(() => store.clear())

test('provider totals are calendar-day device observations scoped by grant and model', () => {
  observeFlashReply(flash, 13, evening - 10, evening)
  observeFlashReply(flash, 17, evening - 10, evening)
  observeFlashReply(pro, 90, evening - 10, evening)
  observeFlashReply(b, 2, evening - 10, evening)
  assert.equal(readFlashMeter(flash, evening).tokens, 30)
  assert.equal(readFlashMeter(b, evening).tokens, 2)
  assert.equal(readFlashMeter(pro, evening).tokens, null)
  assert.equal(readFlashMeter(flash, midnight).tokens, null)
  observeFlashReply(flash, undefined, midnight, midnight)
  assert.equal(readFlashMeter(flash, midnight).tokens, null)
  observeFlashReply(flash, 0, midnight, midnight)
  assert.equal(readFlashMeter(flash, midnight).tokens, 0)
})

test('a real model refusal survives midnight to the server deadline, which is exclusive', () => {
  for (const code of [6004, '6008', 6000]) {
    observeFlashLimit(flash, { error: { code, message: msg } }, 429, evening)
    assert.deepEqual(readFlashMeter(flash, midnight).limit, {
      daily: false,
      at: evening,
      resetAt: reset,
      localTime: null,
    })
    assert.equal(readFlashMeter(flash, reset).limit, null)
    assert.equal(readFlashMeter(pro, evening).limit, null)
    assert.equal(readFlashMeter(b, evening).limit, null)
    assert.equal(readFlashMeter(flash, evening).tokens, null)
  }
})

test('preserve an unzoned server timestamp verbatim, distinguish explicit daily quota', () => {
  observeFlashLimit(
    flash,
    { code: 6000, msg: '您的每日额度已用完，可在 2026-09-20 17:22:50 重置可用' },
    400,
    evening
  )
  assert.deepEqual(readFlashMeter(flash, evening).limit, {
    daily: true,
    at: evening,
    resetAt: null,
    localTime: '2026-09-20 17:22:50',
  })
  assert.equal(readFlashMeter(flash, midnight).limit, null)
})

test('ordinary errors, mismatched models and stale server resets never publish an allowance', () => {
  for (const data of [
    { code: 14003, msg },
    { code: 6004, msg: '请求繁忙' },
    { model: pro.model, code: 6008, msg },
    { code: 6004, msg: msg.replace('2026-09-20', '2026-09-18') },
  ]) {
    observeFlashLimit(flash, data, 429, evening)
    assert.equal(readFlashMeter(flash, evening).limit, null)
  }
  observeFlashLimit(flash, { code: 6004, msg }, 403, evening)
  assert.equal(readFlashMeter(flash, evening).limit, null)
})

test('an earlier concurrent completion cannot erase a later refusal; a new success can', () => {
  observeFlashLimit(flash, { code: 6004, msg }, 429, evening)
  observeFlashReply(flash, 5, evening - 10, evening + 1)
  assert.equal(readFlashMeter(flash, evening + 1).limit.resetAt, reset)
  observeFlashReply(flash, null, evening + 2, evening + 3)
  assert.equal(readFlashMeter(flash, evening + 3).limit, null)
  assert.equal(readFlashMeter(flash, evening + 3).tokens, 5)
})
