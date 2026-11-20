export const positiveTokens = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0

/** Choices must belong to one model on one deployment and fit its reported ceiling. */
export function windowTiers(raw: unknown, ceiling?: number): number[] | undefined {
  if (!Array.isArray(raw) || raw.length > 128) {
    return undefined
  }
  const tiers = [
    ...new Set(raw.filter(positiveTokens).filter((n) => !ceiling || n <= ceiling)),
  ].sort((a, b) => a - b)
  return tiers.length ? tiers : undefined
}

export type WindowDetails = { tiers?: number[]; input?: number }
export function windowDetails(raw: unknown, ceiling?: number): WindowDetails | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined
  }
  const record = raw as Record<string, unknown>
  const input = positiveTokens(record.input) ? record.input : undefined
  const tiers = windowTiers(record.tiers, ceiling)
  return tiers || input ? { ...(tiers && { tiers }), ...(input && { input }) } : undefined
}
