export const WORKBUDDY_PROFILE = '@workbuddy'
export const WORKBUDDY_ORIGIN = 'https://copilot.tencent.com'
// Explicit CN API model identifiers. The service decides each account's entitlement at send time.
export const WORKBUDDY_MODELS = [
  'deepseek-v4.1-flash',
  'deepseek-v4-pro',
  'deepseek-v4-flash',
] as const
export type WorkBuddyModel = (typeof WORKBUDDY_MODELS)[number]
export const isWorkBuddyModel = (id: unknown): id is WorkBuddyModel =>
  WORKBUDDY_MODELS.some((allowed) => id === allowed)
