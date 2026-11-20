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
  reasoning?: boolean
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
const positive = (n: unknown): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n > 0
export function setWorkBuddyCatalog(raw: unknown): WorkBuddyModelInfo[] {
  if (!Array.isArray(raw)) {
    return (current = bundled)
  }
  const models = new Map<string, WorkBuddyModelInfo>()
  for (const row of raw) {
    if (!row || !validWorkBuddyId(row.id) || typeof row.name !== 'string') {
      continue
    }
    models.set(row.id, {
      id: row.id,
      name: row.name || row.id,
      source: 'account',
      ...(positive(row.contextWindow) && { contextWindow: row.contextWindow }),
      ...(Array.isArray(row.contextTiers) && { contextTiers: row.contextTiers.filter(positive) }),
      ...(typeof row.reasoning === 'boolean' && { reasoning: row.reasoning }),
    })
  }
  return (current = [...models.values()])
}
export const getWorkBuddyModel = (id: unknown) => current.find((m) => m.id === id)
export const isWorkBuddyModel = (id: unknown): id is WorkBuddyModel =>
  Boolean(getWorkBuddyModel(id))
