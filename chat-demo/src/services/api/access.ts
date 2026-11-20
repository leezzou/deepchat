import { claudeReasoningSupport, isAnthropicOrigin } from './anthropicOfficial.js'
import { allowsKeylessLocal, endpointProvider } from './modelWindows.js'
import { resolveWindow } from './contextOverrides.js'
import { endpointFileInput } from './fileCapabilities.js'
import { knownReasoningSupport } from './providerReasoningCatalog.js'
import { isOpenAiOrigin, usesOpenAiResponses } from './openAiModels.js'
import { isDeepSeekApiOrigin, reasoningWire } from './providerParity.js'
import { routeSearchEnabled, routeSearchGrant } from './searchConsent.js'
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
import { getWorkBuddyModel, isWorkBuddyModel, WORKBUDDY_MODELS, WORKBUDDY_PROFILE, WORKBUDDY_ORIGIN, type WorkBuddyModel } from '../workbuddy/models.js'
import { useWorkBuddyState } from '../workbuddy/provider.js'

export type ChatAccess =
  | { source: 'account'; model?: ChatModel; searchGrant?: string }
  | { source: 'workbuddy'; model: WorkBuddyModel; revision: string }
  | { source: 'api'; key: string; config: ApiRuntimeConfig; searchGrant?: string; profileId?: string; sessionId?: string | null }

export const accountOrigin = 'https://api.deepseek.com'
export const accessOrigin = (access: ChatAccess) =>
  access.source === 'workbuddy' ? WORKBUDDY_ORIGIN : access.source === 'account' ? accountOrigin : access.config.origin

/** Resolve the complete route without changing the global profile or exposing keys to the UI. */
export function getConversationRoute(sessionId?: string | null, override?: ConversationMode) {
  const state = useSettings.getState()
  const selected = override ?? (sessionId === undefined ? {} : getConversationMode(sessionId))
  const globalAccount = hasAccountBridge && state.chatSource === 'account'
  const defaultId = state.chatSource === 'workbuddy' ? WORKBUDDY_PROFILE : globalAccount ? ACCOUNT_PROFILE : state.activeProfileId
  const profileId = selected.profileId ?? defaultId
  if (profileId === WORKBUDDY_PROFILE) {
    const metadata = useWorkBuddyState.getState().metadata
    const model = selected.model ?? metadata?.model ?? ''
    const destination = JSON.stringify([profileId, WORKBUDDY_ORIGIN, metadata?.revision ?? 'missing'])
    const prior = sessionId !== undefined && useConversationModes.getState().destinations.get(sessionId)
    const limits = resolveWindow({ provider: 'workbuddy', channel: 'workbuddy', grant: metadata?.revision, model })
    return {
      profileId, account: false, workbuddy: true, profile: undefined, name: 'WorkBuddy', fileInput: 'text' as const,
      protocol: 'openai' as const, origin: WORKBUDDY_ORIGIN, model, nativeModel: 'deepseek-flash' as ChatModel,
      destination, missing: !metadata || !isWorkBuddyModel(model),
      needsApproval: sessionId !== undefined && !override && (prior ? prior !== destination : Boolean(selected.profileId)),
      windowBasis: limits.manual != null ? 'custom' : limits.spec.basis,
      context: limits.spec,
      reasoningDisplayOnly: false,
      contextWindow: limits.window, thinking: !!metadata && isWorkBuddyModel(model) && (getWorkBuddyModel(model)?.reasoning ?? WORKBUDDY_MODELS.some(id => id === model)), search: !!metadata && isWorkBuddyModel(model), speech: false, files: false,
    }
  }
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
    (selected.model ?? profile?.model) === 'deepseek-v4-pro' ? 'deepseek-v4-pro' : 'deepseek-flash'
  const claude = protocol !== 'deepseek' && isAnthropicOrigin(origin)
  const model =
    protocol === 'deepseek'
      ? nativeModel
      : selected.model || (profile?.model ?? fallback.model) || (claude ? '' : defaultApiModel)
  const missing = Boolean((selected.profileId && !account && !profile) || (claude && !model) || (protocol === 'anthropic' && !claude))
  const destination = JSON.stringify([profileId, origin, protocol])
  const previous =
    sessionId !== undefined && useConversationModes.getState().destinations.get(sessionId)
  // An imported profile reference has no local approval. Its ID alone cannot vouch for an endpoint.
  const needsApproval =
    sessionId !== undefined &&
    !override &&
    (previous ? previous !== destination : Boolean(selected.profileId))
  const fileInput = endpointFileInput(origin, model, profile?.providerId, protocol)
  const limits = resolveWindow({ profile, model, origin, protocol, provider: endpointProvider(origin, profile?.providerId), ...(account && { channel: 'account' as const, grant: state.accountRevision ?? undefined }) })
  const reasoningSupport = (claude && claudeReasoningSupport(model)) || profile?.discoveredReasoning?.[limits.key] || knownReasoningSupport({ origin, protocol, model })
  const summaryOnly = (claude && reasoningSupport === 'fixed') || (protocol === 'openai' && isOpenAiOrigin(origin) && usesOpenAiResponses(model))
  const wire = reasoningWire({ origin, protocol, model, providerId: profile?.providerId, reasoningSupport })
  const reasoningDisplayOnly = summaryOnly || (!missing && protocol === 'openai' && !isOpenAiOrigin(origin) && !claude && reasoningSupport !== 'none' && (!wire || reasoningSupport === 'fixed'))
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
    contextWindow: limits.window,
    context: limits.spec,
    windowBasis: limits.manual != null || limits.inheritedWindow ? 'custom' : limits.spec.basis,
    thinking: !missing && (reasoningDisplayOnly || Boolean(wire)),
    reasoningSupport, summaryOnly, reasoningDisplayOnly,
    search: !missing && !needsApproval && routeSearchEnabled({ profileId, origin, protocol, model }, sessionId),
    speech: !missing && !needsApproval && (account || isDeepSeekApiOrigin(origin)),
    fileInput,
    files: !missing && fileInput !== 'text',
  }
}
export function getChatAccess(sessionId?: string | null): ChatAccess | null {
  const state = useSettings.getState()
  const route = getConversationRoute(sessionId)
  if (route.missing || route.needsApproval) {
    return null
  }
  if (route.profileId === WORKBUDDY_PROFILE) {
    const metadata = useWorkBuddyState.getState().metadata
    return metadata && isWorkBuddyModel(route.model) ? { source: 'workbuddy', model: route.model, revision: metadata.revision } : null
  }
  const grant = routeSearchGrant(route, sessionId)
  const searchAccess = grant ? { searchGrant: grant } : {}
  if (route.account) {
    if (!hasAccountBridge || !state.accountSignedIn) return null
    return { source: 'account', ...(route.nativeModel !== 'deepseek-flash' && { model: route.nativeModel }), ...searchAccess }
  }
  // A pinned non-active profile must never inherit the active profile's key.
  const key =
    route.profile?.apiKey ?? (route.profileId === state.activeProfileId ? state.apiKey : null)
  return key || (route.profile && allowsKeylessLocal(route.origin, route.protocol))
    ? {
        source: 'api',
        ...(route.profile && { profileId: route.profile.id, sessionId }),
        ...searchAccess,
        key: key || '',
        config: { origin: route.origin, protocol: route.protocol, model: route.model,
          ...(route.profile?.providerId && { providerId: route.profile.providerId }),
          ...(route.reasoningSupport && { reasoningSupport: route.reasoningSupport }),
        },
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
