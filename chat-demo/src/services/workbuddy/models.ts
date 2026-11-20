import { positiveTokens, windowTiers } from '../api/windowTiers.js'
import { promotionRate } from './promotions.js'

export const WORKBUDDY_PROFILE = '@workbuddy'
export const WORKBUDDY_ORIGIN = 'https://copilot.tencent.com'
// The three explicit models supported by previous releases and the vendor's offline product config.
export const WORKBUDDY_MODELS = [
  'deepseek-v4.1-flash',
  'deepseek-v4-pro',
  'deepseek-v4-flash',
] as const
export type WorkBuddyModel = string
export type WorkBuddyModelInfo = {
  id: string
  name: string
  contextWindow?: number
  contextTiers?: number[]
  maxInputTokens?: number
  reasoning?: boolean
  rate?: { multiplier: number; free?: true }
  source: 'bundled' | 'account'
}
const bundled: WorkBuddyModelInfo[] = WORKBUDDY_MODELS.map((id) => ({
  id,
  name: id.replace('deepseek', 'DeepSeek'),
  contextWindow: 1_000_000,
  reasoning: true,
  source: 'bundled',
}))
let current = bundled
export const validWorkBuddyId = (id: unknown): id is string =>
  typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)
function parseCreditRate(value: unknown): WorkBuddyModelInfo['rate'] {
  if (!value || typeof value !== 'object' || !('multiplier' in value)) {
    return
  }
  const multiplier = value.multiplier
  if (typeof multiplier !== 'number' || !Number.isFinite(multiplier) || multiplier < 0) {
    return
  }
  return multiplier === 0 ? { multiplier, free: true } : { multiplier }
}
let snapshot: unknown
let nextPriceChange = Infinity
export const getNextWorkBuddyPriceChange = () => nextPriceChange
export const repriceWorkBuddyCatalog = () => setWorkBuddyCatalog(snapshot)
export function setWorkBuddyCatalog(raw: unknown): WorkBuddyModelInfo[] {
  snapshot = raw
  nextPriceChange = Infinity
  const now = Date.now()
  if (!Array.isArray(raw)) {
    return (current = bundled)
  }
  const models = new Map<string, WorkBuddyModelInfo>()
  for (const row of raw) {
    if (!row || !validWorkBuddyId(row.id) || typeof row.name !== 'string') {
      continue
    }
    const limit = positiveTokens(row.maxInputTokens) ? row.maxInputTokens : undefined
    // Cached v1.0.54 catalogs stored a lower default alongside the complete tier list.
    const tiers = windowTiers(row.contextTiers, limit)
    const window = tiers?.at(-1) ?? limit ?? (positiveTokens(row.contextWindow) ? row.contextWindow : undefined)
    const { rate, nextChange } = promotionRate(parseCreditRate(row.rate)?.multiplier, row.promotions, now)
    nextPriceChange = Math.min(nextPriceChange, nextChange)
    models.set(row.id, {
      id: row.id,
      name: row.name || row.id,
      source: 'account',
      ...(rate && { rate }),
      ...(window && { contextWindow: window }),
      ...(tiers && { contextTiers: tiers }),
      ...(limit && { maxInputTokens: limit }),
      ...(typeof row.reasoning === 'boolean' && { reasoning: row.reasoning }),
    })
  }
  return (current = [...models.values()])
}
export const workBuddyCatalogIds = () => current.map(({ id }) => id)
export const getWorkBuddyModel = (id: unknown) => current.find((m) => m.id === id)
export const isWorkBuddyModel = (id: unknown): id is WorkBuddyModel =>
  Boolean(getWorkBuddyModel(id))
