import assert from 'node:assert/strict'
import test from 'node:test'
import { summarizeUsage, usageMetrics } from './totals.ts'

test('each rate uses a matched denominator, including explicit zero and incomplete responses', () => {
  const rows = [
    { input: 1000, output: 200, inputHit: 100, outputHit: 20 },
    { input: 100, output: 20, inputHit: 0 },
    { input: 2000, output: 2000 },
    { outputHit: 5 },
    {},
  ]
  const report = summarizeUsage(rows)
  assert.equal(report.requests, 5)
  assert.deepEqual(report.output, { reported: 3, value: 2220n })
  assert.deepEqual(report.inputHit, {
    value: 100n,
    reported: 2,
    base: 1100n,
    paired: 2,
    pairedHits: 100n,
  })
  assert.deepEqual(report.outputHit, {
    value: 25n,
    reported: 2,
    base: 200n,
    paired: 1,
    pairedHits: 20n,
  })
  assert.equal(report.cacheWrite.reported, 0)
  assert.equal(summarizeUsage([{ input: 0, inputHit: 0 }]).inputHit.reported, 1)
})

test('cumulative usage from multiple frames counts each input, output and reported cache bucket once', () => {
  const first = usageMetrics({
    input_tokens: 12,
    cache_read_input_tokens: 5,
    cache_creation_input_tokens: 7,
    output_tokens: 1,
  })
  assert.equal(first.metrics.input, 24)
  assert.equal(first.metrics.outputHit, undefined)
  const last = usageMetrics({ output_tokens: 5, cache_read_output_tokens: 2 }, first.counts)
  assert.deepEqual(last.metrics, { input: 24, output: 7, inputHit: 5, outputHit: 2, cacheWrite: 7 })
  assert.equal(usageMetrics({ output_tokens_total: 7 }, last.counts).metrics.output, 7)
  assert.deepEqual(usageMetrics({ total_tokens: 999 }).metrics, {
    input: undefined,
    output: undefined,
    inputHit: undefined,
    outputHit: undefined,
    cacheWrite: undefined,
  })
  assert.equal(
    usageMetrics({ input_tokens_total: 7, cache_read_input_tokens: 10 }).metrics.inputHit,
    undefined
  )
})
