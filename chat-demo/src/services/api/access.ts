import { hasAccountBridge } from '../../shell/account.js'
import {
  ACCOUNT_PROFILE,
  getConversationMode,
  useConversationModes,
  type ConversationMode,
} from '../conversationMode/storage.js'
import { useSettings } from '../settings.js'
import { defaultApiModel, defaultApiOrigin, getApiConfig, type ApiRuntimeConfig } from './origin.js'
import type { ChatModel } from './types.js'

export type ChatAccess =
  | { source: 'account'; model?: ChatModel }
  | { source: 'api'; key: string; config: ApiRuntimeConfig }

export const accountOrigin = 'https://api.deepseek.com'
export const accessOrigin = (access: ChatAccess) =>
  access.source === 'account' ? accountOrigin : access.config.origin

/** Resolve the complete route without changing the global profile or exposing keys to the UI. */
export function getConversationRoute(sessionId?: string | null, override?: ConversationMode) {
  const state = useSettings.getState()
  const selected = override ?? (sessionId === undefined ? {} : getConversationMode(sessionId))
  const globalAccount = hasAccountBridge && state.chatSource === 'account'
  const profileId = selected.profileId ?? (globalAccount ? ACCOUNT_PROFILE : state.activeProfileId)
  const account = profileId === ACCOUNT_PROFILE
  const profile = account ? undefined : state.apiProfiles.find((item) => item.id === profileId)
  const global = getApiConfig()
  const fallback =
    profileId === state.activeProfileId
      ? global
      : { protocol: 'deepseek' as const, origin: defaultApiOrigin, model: defaultApiModel }
  const protocol = account ? 'deepseek' : (profile?.protocol ?? fallback.protocol)
  const origin = account ? accountOrigin : (profile?.origin ?? fallback.origin) || defaultApiOrigin
  const nativeModel: ChatModel =
    selected.model === 'deepseek-v4-pro' ? selected.model : 'deepseek-flash'
  const model =
    protocol === 'deepseek'
      ? nativeModel
      : selected.model || (profile?.model ?? fallback.model) || defaultApiModel
  const missing = Boolean(selected.profileId && !account && !profile)
  const destination = JSON.stringify([profileId, origin, protocol])
  const previous =
    sessionId !== undefined && useConversationModes.getState().destinations.get(sessionId)
  // An imported profile reference has no local approval. Its ID alone cannot vouch for an endpoint.
  const needsApproval =
    sessionId !== undefined &&
    !override &&
    (previous ? previous !== destination : Boolean(selected.profileId))
  let official = account
  try {
    official ||= new URL(origin).origin === accountOrigin
  } catch {
    /* relative development origin */
  }
  return {
    profileId,
    account,
    profile,
    name: missing ? '方案已移除' : account ? 'DeepSeek 账号' : (profile?.name ?? '默认 API'),
    protocol,
    origin,
    model,
    nativeModel,
    destination,
    needsApproval,
    missing,
    contextWindow: profile?.contextWindow || (protocol === 'deepseek' ? 1_000_000 : 128_000),
    thinking: !missing && protocol === 'deepseek',
    search: !missing && protocol === 'deepseek',
    speech: !missing && protocol === 'deepseek',
    files: !missing && !(official && model === 'deepseek-v4-pro'),
  }
}
export function getChatAccess(sessionId?: string | null): ChatAccess | null {
  const state = useSettings.getState()
  const route = getConversationRoute(sessionId)
  if (route.missing || route.needsApproval) {
    return null
  }
  if (route.account) {
    if (!hasAccountBridge || !state.accountSignedIn) {
      return null
    }
    return route.nativeModel === 'deepseek-flash'
      ? { source: 'account' }
      : { source: 'account', model: route.nativeModel }
  }
  // A pinned non-active profile must never inherit the active profile's key.
  const key =
    route.profile?.apiKey ?? (route.profileId === state.activeProfileId ? state.apiKey : null)
  return key
    ? {
        source: 'api',
        key,
        config: { origin: route.origin, protocol: route.protocol, model: route.model },
      }
    : null
}
export function requireChatAccess(sessionId?: string | null): ChatAccess {
  const access = getChatAccess(sessionId)
  if (!access) {
    throw new Error('请检查本会话的模型方案与登录状态。')
  }
  return access
}
