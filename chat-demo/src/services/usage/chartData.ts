import type { UsageRow } from './ledger.js'
import { tokenCount } from './totals.js'

export type UsagePeriod = 1 | 7 | 30 | 'all'

type Amounts = {
  input?: bigint
  output?: bigint
  requests: number
  inputReported: number
  outputReported: number
}
export type UsageBucket = Amounts & { start: number; end: number }
export type UsageRank = Amounts & { id: string }

const amounts = (): Amounts => ({ requests: 0, inputReported: 0, outputReported: 0 })
const oneHour = 3_600_000

function addRow(group: Amounts, row: UsageRow) {
  group.requests++
  const input = tokenCount(row.input)
  const output = tokenCount(row.output)
  if (input !== undefined) {
    group.input = (group.input ?? 0n) + BigInt(input)
    group.inputReported++
  }
  if (output !== undefined) {
    group.output = (group.output ?? 0n) + BigInt(output)
    group.outputReported++
  }
}

function localDay(time: number, shift = 0) {
  const day = new Date(time)
  day.setHours(0, 0, 0, 0)
  day.setDate(day.getDate() + shift)
  return +day
}

function nextMonth(time: number, months: number) {
  const date = new Date(time)
  date.setDate(1)
  date.setMonth(date.getMonth() + months)
  return +date
}

/** Hourly today, daily for short ranges, and at most 32 calendar-month groups for a long history. */
export function usageTimeline(
  rows: readonly UsageRow[],
  period: UsagePeriod,
  now: number
): UsageBucket[] {
  if (!Number.isFinite(new Date(now).valueOf())) {
    return []
  }
  const tomorrow = localDay(now, 1)
  let start: number
  let monthStep = 0
  if (period === 'all') {
    let first = now
    for (const row of rows) {
      if (row.at < first && Number.isFinite(new Date(row.at).valueOf())) {
        first = row.at
      }
    }
    start = localDay(first)
    if (start < localDay(now, -30)) {
      const a = new Date(first)
      const b = new Date(now)
      const months = 1 + (b.getFullYear() - a.getFullYear()) * 12 + b.getMonth() - a.getMonth()
      monthStep = Math.ceil(months / 32)
      start = nextMonth(start, 0)
    }
  } else {
    start = localDay(now, 1 - period)
  }
  const buckets: UsageBucket[] = []
  const boundaries: number[] = []
  for (let cursor = start; cursor < tomorrow; ) {
    const next =
      period === 1
        ? cursor + oneHour
        : monthStep
          ? nextMonth(cursor, monthStep)
          : localDay(cursor, 1)
    const end = Math.min(next, tomorrow)
    buckets.push({ start: cursor, end, ...amounts() })
    boundaries.push(cursor)
    cursor = end
  }
  for (const row of rows) {
    if (!Number.isFinite(row.at) || row.at < start || row.at > now) {
      continue
    }
    let low = 0
    let high = boundaries.length
    while (low < high) {
      const mid = (low + high) >>> 1
      if (boundaries[mid] <= row.at) {
        low = mid + 1
      } else {
        high = mid
      }
    }
    if (low > 0) {
      addRow(buckets[low - 1], row)
    }
  }
  return buckets
}

/** Rank confirmed token subtotals. Groups without any reported counts remain available for filtering. */
export function usageRanking(
  rows: readonly UsageRow[],
  dimension: 'provider' | 'model'
): UsageRank[] {
  const groups = new Map<string, UsageRank>()
  for (const row of rows) {
    const id = row[dimension] ?? ''
    let group = groups.get(id)
    if (!group) {
      group = { id, ...amounts() }
      groups.set(id, group)
    }
    addRow(group, row)
  }
  return [...groups.values()].sort((a, b) => {
    const aKnown = a.inputReported + a.outputReported > 0
    const bKnown = b.inputReported + b.outputReported > 0
    if (aKnown !== bKnown) {
      return aKnown ? -1 : 1
    }
    const aTotal = (a.input ?? 0n) + (a.output ?? 0n)
    const bTotal = (b.input ?? 0n) + (b.output ?? 0n)
    if (aTotal !== bTotal) {
      return aTotal > bTotal ? -1 : 1
    }
    return b.requests - a.requests || a.id.localeCompare(b.id)
  })
}
