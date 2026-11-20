type Promotion = {
  priority?: number
  price?: number
  factor?: number
  validFrom?: string
  validUntil?: string
  daily?: number[][]
  timezone?: string
}
const isMinute = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 1440
const formatters = new Map<string, Intl.DateTimeFormat>()
function minuteOfDay(now: Date, zone?: string) {
  if (!zone) {
    return now.getHours() * 60 + now.getMinutes()
  }
  let formatter = formatters.get(zone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
    if (formatters.size > 32) {
      formatters.clear()
    }
    formatters.set(zone, formatter)
  }
  const parts = formatter.formatToParts(now)
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value)
  return (part('hour') % 24) * 60 + part('minute')
}

/** Evaluate the cached schedule even offline. Boundaries are inclusive at the start, exclusive at the end. */
export function promotionRate(base: number | undefined, rules: unknown, timestamp: number) {
  let winner: Promotion | undefined,
    nextChange = Infinity
  if (Array.isArray(rules)) {
    const now = new Date(timestamp)
    for (const rule of rules as Promotion[]) {
      if (!rule || typeof rule !== 'object' || 'schedule' in rule) {
        continue
      }
      if (
        (rule.validFrom !== undefined && typeof rule.validFrom !== 'string') ||
        (rule.validUntil !== undefined && typeof rule.validUntil !== 'string') ||
        (rule.timezone !== undefined && typeof rule.timezone !== 'string') ||
        (rule.priority !== undefined && !Number.isFinite(rule.priority)) ||
        (rule.daily !== undefined && (!Array.isArray(rule.daily) || rule.daily.length > 32))
      ) {
        continue
      }
      const start = rule.validFrom ? Date.parse(rule.validFrom) : -Infinity
      const end = rule.validUntil ? Date.parse(rule.validUntil) : Infinity
      if (Number.isNaN(start) || Number.isNaN(end) || timestamp >= end || start >= end) {
        continue
      }
      if (timestamp < start) {
        nextChange = Math.min(nextChange, start)
        continue
      }
      nextChange = Math.min(nextChange, end)
      if (rule.daily) {
        let minute: number
        try {
          minute = minuteOfDay(now, rule.timezone)
        } catch {
          continue
        }
        let active = false
        for (const window of rule.daily) {
          if (!Array.isArray(window) || window.length !== 2 || !window.every(isMinute)) {
            continue
          }
          const [from, to] = window
          if (from === to) {
            active = true
            continue
          }
          active ||= from < to ? minute >= from && minute < to : minute >= from || minute < to
          for (const boundary of [from, to]) {
            const delta = (boundary - minute + 1440) % 1440 || 1440
            nextChange = Math.min(nextChange, timestamp - (timestamp % 60_000) + delta * 60_000)
          }
        }
        if (!active) {
          continue
        }
      }
      if (!winner || (rule.priority ?? 0) > (winner.priority ?? 0)) {
        winner = rule
      }
    }
  }
  let multiplier = base
  if (winner?.price !== undefined && Number.isFinite(winner.price) && winner.price >= 0) {
    multiplier = winner.price
  } else if (base !== undefined && typeof winner?.factor === 'number' && winner.factor > 0 && winner.factor < 1) {
    multiplier = Number((base * winner.factor).toPrecision(12))
  }
  const rate =
    multiplier === undefined
      ? undefined
      : multiplier === 0
        ? { multiplier, free: true as const }
        : { multiplier }
  return { rate, nextChange }
}
