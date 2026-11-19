// Read only the usage and refusal envelopes on a real, selected Flash chat. The account
// resource summary and request history report credits. Neither supplies a token allowance.
export const FLASH_QUOTA_MODEL = 'deepseek-v4.1-flash'
const DAY = 86_400_000
const CN_OFFSET = 8 * 3_600_000
export const nextUsageDay = (now: number) =>
  Math.floor((now + CN_OFFSET) / DAY + 1) * DAY - CN_OFFSET

type Route = { revision: string; model: string }
type Limit = { at: number; resetAt: number | null; localTime: string | null; daily: boolean }
type Meter = { dayEnd: number; tokens: number | null; limit: Limit | null }
const change = new EventTarget()
export function onQuotaChange(listener: () => void) {
  change.addEventListener('change', listener)
  return () => change.removeEventListener('change', listener)
}
const key = (r: Route) => `chat-demo:workbuddy-flash-meter:v1:${r.revision}`
const count = (n: unknown): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= 0
const stamp = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/
export function readFlashMeter(route: Route, now = Date.now()): Meter {
  const meter: Meter = { dayEnd: nextUsageDay(now), tokens: null, limit: null }
  if (route.model !== FLASH_QUOTA_MODEL || !route.revision) return meter
  try {
    const data = JSON.parse(localStorage.getItem(key(route)) ?? 'null')
    if (data?.dayEnd === meter.dayEnd && count(data.tokens)) meter.tokens = data.tokens
    const limit = data?.limit
    if (
      count(limit?.at) &&
      limit.at <= now &&
      typeof limit.daily === 'boolean' &&
      (count(limit.resetAt)
        ? limit.resetAt > now
        : limit.resetAt === null && nextUsageDay(limit.at) === meter.dayEnd) &&
      (limit.localTime === null ||
        (typeof limit.localTime === 'string' && stamp.test(limit.localTime)))
    ) {
      meter.limit = limit
    }
  } catch {
    /* Storage can be disabled or contain an older format. */
  }
  return meter
}
function save(route: Route, meter: Meter) {
  try {
    localStorage.setItem(key(route), JSON.stringify(meter))
    change.dispatchEvent(new Event('change'))
  } catch {
    /* Accounting is advisory and must never interrupt a chat. */
  }
}
export function observeFlashReply(
  route: Route,
  total: unknown,
  startedAt: number,
  now = Date.now()
) {
  if (route.model !== FLASH_QUOTA_MODEL || !route.revision) return
  const meter = readFlashMeter(route, now)
  // A successful older request can complete after a newer refusal.
  if (meter.limit && startedAt > meter.limit.at) meter.limit = null
  if (count(total)) {
    const sum = (meter.tokens ?? 0) + total
    if (count(sum)) meter.tokens = sum
  }
  save(route, meter)
}
const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
export function observeFlashLimit(route: Route, body: unknown, status: number, now = Date.now()) {
  if (route.model !== FLASH_QUOTA_MODEL || !route.revision || ![200, 400, 429].includes(status))
    return
  const envelope = record(body)
  const details =
    envelope.error && typeof envelope.error === 'object' ? record(envelope.error) : envelope
  const msg = details.msg ?? details.message ?? details.error_msg
  if (
    (envelope.model != null && envelope.model !== route.model) ||
    !['6000', '6004', '6008'].includes(String(details.code)) ||
    typeof msg !== 'string' ||
    !/(?:用量|使用量|额度|配额|usage|quota).{0,15}(?:超|耗尽|已用完|exceed|exhaust|limit)|(?:超出|超过).{0,8}(?:限额|频率限制)/i.test(
      msg
    )
  )
    return
  const limit: Limit = {
    at: now,
    resetAt: null,
    localTime: null,
    daily: /(?:每日|单日|今日|daily).{0,12}(?:用量|使用量|额度|配额|quota|allowance)/i.test(msg),
  }
  const time =
    /(?:将在|可在|reset at)\s*(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)(?:\s*UTC([+-])(\d{1,2})(?::(\d\d))?)?(?=\s*(?:重置|[,，.。]|$))/i.exec(
      msg
    )
  if (time) {
    const [, date, clock, sign, hours, minutes] = time
    const local = `${date} ${clock}`
    const base = Date.parse(`${date}T${clock}Z`)
    if (Number.isFinite(base) && new Date(base).toISOString().slice(0, 19) === `${date}T${clock}`) {
      if (!sign) limit.localTime = local
      else if (Number(hours) <= 14 && Number(minutes ?? 0) < 60) {
        const instant =
          base - (sign === '+' ? 1 : -1) * (Number(hours) * 60 + Number(minutes ?? 0)) * 60_000
        if (instant <= now) return
        limit.resetAt = instant
      }
    }
  }
  const meter = readFlashMeter(route, now)
  meter.limit = limit
  save(route, meter)
}
