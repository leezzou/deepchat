import type { Message } from './types.js'

export type TokenCounts = {
  replies: number
  input: bigint
  cacheWrite: bigint
  cacheRead: bigint
  output: bigint
}

const emptyCounts = (): TokenCounts => ({
  replies: 0,
  input: 0n,
  cacheWrite: 0n,
  cacheRead: 0n,
  output: 0n,
})

export const totalTokens = (counts: TokenCounts) =>
  counts.input + counts.cacheWrite + counts.cacheRead + counts.output

/** Calendar midnights in the device's time zone. Days can be shorter or longer than 24 hours. */
export const makeUsageDays = (now: number) => {
  const today = new Date(now)
  const days = new Map<number, TokenCounts>()
  for (let offset = 29; offset >= 0; offset--) {
    // Construct each midnight independently. A skipped midnight must not shift later days to 01:00.
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset)
    days.set(day.getTime(), emptyCounts())
  }
  return days
}

export const countRecordedReplies = (
  days: Map<number, TokenCounts>,
  messages: readonly Message[],
  now: number
) => {
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.usage || message.createdAt > now) {
      continue
    }
    const counts = days.get(new Date(message.createdAt).setHours(0, 0, 0, 0))
    if (!counts) {
      continue
    }
    const { input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens } =
      message.usage
    // Missing, malformed or fractional counters cannot represent a recorded response total.
    if (
      ![input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens].every(
        (n) => Number.isSafeInteger(n) && n >= 0
      )
    ) {
      continue
    }
    counts.replies++
    counts.input += BigInt(input_tokens)
    counts.cacheWrite += BigInt(cache_creation_input_tokens)
    counts.cacheRead += BigInt(cache_read_input_tokens)
    counts.output += BigInt(output_tokens)
  }
}

export const sumUsageDays = (days: ReadonlyArray<readonly [number, TokenCounts]>) => {
  const sum = emptyCounts()
  for (const [, counts] of days) {
    sum.replies += counts.replies
    sum.input += counts.input
    sum.cacheWrite += counts.cacheWrite
    sum.cacheRead += counts.cacheRead
    sum.output += counts.output
  }
  return sum
}
