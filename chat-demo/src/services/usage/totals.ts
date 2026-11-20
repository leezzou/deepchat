import type { UsageRow } from './ledger.js'

export const tokenCount = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined

const metric = () => ({ value: 0n, reported: 0 })
const hits = () => ({ ...metric(), base: 0n, paired: 0, pairedHits: 0n })

export function summarizeUsage(rows: readonly UsageRow[]) {
  const result = {
    requests: rows.length,
    input: metric(),
    output: metric(),
    cacheWrite: metric(),
    inputHit: hits(),
    outputHit: hits(),
  }
  for (const row of rows) {
    for (const key of ['input', 'output', 'cacheWrite', 'inputHit', 'outputHit'] as const) {
      const value = tokenCount(row[key])
      if (value === undefined) {
        continue
      }
      result[key].value += BigInt(value)
      result[key].reported++
      if (key === 'inputHit' || key === 'outputHit') {
        const base = tokenCount(key === 'inputHit' ? row.input : row.output)
        if (base === undefined || value > base) {
          continue
        }
        result[key].base += BigInt(base)
        result[key].pairedHits += BigInt(value)
        result[key].paired++
      }
    }
  }
  return result
}

/** Providers send cumulative snapshots within one request. An absent field leaves a prior report intact. */
export function usageMetrics(raw: object, previous: Record<string, number> = {}) {
  const counts = { ...previous }
  for (const [key, value] of Object.entries(raw)) {
    const n = tokenCount(value)
    if (n !== undefined) {
      counts[key] = n
    }
  }
  const { input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens } =
    counts
  const input =
    counts.input_tokens_total ??
    (input_tokens === undefined
      ? undefined
      : tokenCount(
          input_tokens + (cache_creation_input_tokens ?? 0) + (cache_read_input_tokens ?? 0)
        ))
  const output =
    counts.output_tokens_total ??
    (output_tokens === undefined
      ? undefined
      : tokenCount(
          output_tokens +
            (counts.cache_read_output_tokens ?? 0) +
            (counts.cache_creation_output_tokens ?? 0)
        ))
  const inputHit = counts.cache_read_input_tokens
  const outputHit = counts.cache_read_output_tokens
  return {
    counts,
    metrics: {
      input,
      output,
      inputHit: input === undefined || inputHit <= input ? inputHit : undefined,
      outputHit: output === undefined || outputHit <= output ? outputHit : undefined,
      cacheWrite: cache_creation_input_tokens,
    },
  }
}
