import { create } from 'zustand'
import { selectedClaudeFacts, type ClaudeModelFacts } from './api/anthropicOfficial.js'
import { allowsKeylessLocal, validWindow } from './api/modelWindows.js'
import { profileWindowKey, withProfileWindow } from './api/contextOverrides.js'
import { hasAccountBridge, type AccountProfile } from '../shell/account.js'
import { androidShell, nativeProfileVault, securityState } from './security/bridge.js'
import {
  decodeLegacy,
  LEGACY_KEY,
  LEGACY_LIST,
  migrateProfiles,
  persistProfiles,
  type ProfileVault,
} from './security/profiles.js'
import {
  defaultApiOrigin,
  defaultApiModel,
  normalizeOrigin,
  setApiConfig,
  type ApiProtocol,
} from './api/origin.js'
import type { DiscoveredModel } from './api/modelDiscovery.js'
import type { TtsVoice } from './api/speech.js'
import { normalizeLocation, type UserLocation } from './location.js'

export type Locale = 'zh-CN' | 'en-US'
/** 语言偏好：跟随系统 / 中文 / English（与官方一致） */
export type LocalePreference = 'system' | Locale

/** 主题偏好；默认跟随系统 */
export type ThemePreference = 'light' | 'dark' | 'system'

/**
 * 一条 API 配置：名称、接口地址、Key。
 * 支持多条配置来回切换（官方 Key / 中转地址 / 别的兼容网关各存一条）。
 */
export type ApiProfile = {
  id: string
  name: string
  /** deepseek = DeepSeek 的 Anthropic 兼容协议；openai = OpenAI 兼容 /chat/completions */
  protocol: ApiProtocol
  /** 接口地址，留空时用构建期默认值 */
  origin: string
  providerId?: string
  /** 仅 openai 协议使用 */
  model: string
  /** Older profile-wide custom value; per-model preferences take precedence. */
  contextWindow?: number
  contextWindows?: Record<string, number | null>
  discoveredReasoning?: Record<string, import('./api/providerParity.js').ReasoningSupport>
  discoveredWindows?: Record<string, number>
  discoveredWindowDetails?: Record<string, import('./api/windowTiers.js').WindowDetails>
  claudeModelFacts?: ClaudeModelFacts
  discoveredWindowKinds?: Record<string, 'input' | 'endpoint' | 'instance' | 'model'>
  apiKey: string
}

/** 本机设置，存 localStorage：API 配置、语言、主题、位置、朗读音色、深度思考与智能搜索开关、侧边栏收起状态 */
type Settings = {
  /** 当前启用配置的 Key；没有配置时为 null */
  apiKey: string | null
  /** Native host reports sign-in status; profile fields are memory-only. */
  accountSignedIn: boolean
  accountRevision: string | null
  accountDisplayRevision: string | null
  accountName: string
  accountAvatar: string | null
  chatSource: ChatSource
  /** 当前启用配置的接口地址 */
  apiOrigin: string
  apiProfiles: ApiProfile[]
  credentialStatus: 'loading' | 'ready' | 'unavailable'
  activeProfileId: string | null
  locale: LocalePreference
  themePreference: ThemePreference
  location: UserLocation | null
  ttsVoice: TtsVoice
  thinking: boolean
  search: boolean
  /** 回复生成后自动朗读（官方 header 的「自动朗读」开关） */
  autoRead: boolean
  siderCollapsed: boolean
  identityPreference: IdentitySource
  fontScale: number
  /** 思考内容结束后自动折叠（官方「个性化」里的开关） */
  autoCollapseThinking: boolean
}

export type IdentitySource = 'dsh' | 'workbuddy'
export type ChatSource = 'account' | 'api' | 'workbuddy'

const KEYS = {
  chatSource: 'chat-demo:chat-source',
  activeProfileId: 'chat-demo:active-profile',
  locale: 'chat-demo:locale',
  location: 'chat-demo:location',
  themePreference: 'chat-demo:theme-preference',
  ttsVoice: 'chat-demo:tts-voice',
  thinking: 'chat-demo:thinking',
  search: 'chat-demo:search',
  autoRead: 'chat-demo:auto-read',
  siderCollapsed: 'chat-demo:sider-collapsed',
  identityPreference: 'chat-demo:identity-source',
  fontScale: 'chat-demo:font-scale',
  autoCollapseThinking: 'chat-demo:auto-collapse-thinking',
} as const

const read = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const write = (key: string, value: string | null) => {
  try {
    if (value === null) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, value)
    }
  } catch {
    // 存储不可用时只在内存中生效
  }
}

/** 位置选择模式跟随浏览器语言，与应用内选择的界面语言无关。 */
export const isChineseBrowser = (): boolean =>
  (typeof navigator === 'undefined' ? 'zh' : navigator.language).toLowerCase().startsWith('zh')

const initialLocale = (): LocalePreference => {
  const saved = read(KEYS.locale)
  if (saved === 'zh-CN' || saved === 'en-US' || saved === 'system') {
    return saved
  }
  return 'system'
}

const initialLocation = (): UserLocation | null => {
  try {
    const location = normalizeLocation(JSON.parse(read(KEYS.location) ?? 'null'))
    if (!location) {
      return null
    }
    return isChineseBrowser()
      ? location.region === 'CN' && location.province
        ? location
        : null
      : { region: location.region }
  } catch {
    return null
  }
}

/** 配置 id：优先用 randomUUID，老 WebView 退化为时间戳 */
const newProfileId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `p${Date.now().toString(36)}`

/** Android decodes legacy credentials only after the native gate has opened. */
const initialApiProfiles = (): ApiProfile[] => {
  if (androidShell) {
    return []
  }
  try {
    return decodeLegacy(read(LEGACY_LIST), read(LEGACY_KEY))
  } catch {
    return []
  }
}

const initialActiveProfileId = (profiles: ApiProfile[]): string | null => {
  const saved = read(KEYS.activeProfileId)
  return profiles.some((profile) => profile.id === saved) ? saved : (profiles[0]?.id ?? null)
}

/** 未保存过时跟随系统 */
const initialThemePreference = (): ThemePreference => {
  const saved = read(KEYS.themePreference)
  return saved === 'light' || saved === 'dark' ? saved : 'system'
}

/** 未保存过时使用服务端默认音色 stella（海星） */
const initialTtsVoice = (): TtsVoice => (read(KEYS.ttsVoice) === 'tide' ? 'tide' : 'stella')

const initialProfiles = initialApiProfiles()
const initialActiveId = initialActiveProfileId(initialProfiles)
const initialActive = initialProfiles.find((profile) => profile.id === initialActiveId) ?? null
// 让接口层先拿到当前配置，之后的请求都走它
setApiConfig({
  origin: initialActive?.origin,
  protocol: initialActive?.protocol,
  model: initialActive?.model,
})

// Retire the old device-only editor, including its potentially large inline image.
write('chat-demo:display-name', null)
write('chat-demo:avatar', null)

const savedSource = read(KEYS.chatSource)
const initialSource: ChatSource =
  savedSource === 'workbuddy' ? 'workbuddy' : hasAccountBridge && (savedSource === 'account' || (!initialActive && savedSource !== 'api'))
    ? 'account'
    : 'api'

export const useSettings = create<Settings>(() => ({
  accountSignedIn: false,
  accountRevision: null,
  accountDisplayRevision: null,
  accountName: '',
  accountAvatar: null,
  chatSource: initialSource,
  apiKey: initialActive?.apiKey ?? null,
  apiOrigin: initialActive?.origin ?? defaultApiOrigin,
  apiProfiles: initialProfiles,
  credentialStatus: 'loading',
  activeProfileId: initialActive?.id ?? null,
  locale: initialLocale(),
  location: initialLocation(),
  themePreference: initialThemePreference(),
  ttsVoice: initialTtsVoice(),
  thinking: read(KEYS.thinking) === 'true',
  // 官方 App 首次进入时「智能搜索」为开、「深度思考」为关（UI-SPEC §4）
  search: read(KEYS.search) !== 'false',
  autoRead: read(KEYS.autoRead) === 'true',
  siderCollapsed: read(KEYS.siderCollapsed) === 'true',
  identityPreference: read(KEYS.identityPreference) === 'workbuddy' ? 'workbuddy' : 'dsh',
  fontScale: Number(read(KEYS.fontScale)) || 1,
  autoCollapseThinking: read(KEYS.autoCollapseThinking) !== 'false',
}))

let legacyAccountSession = 0
export function applyAccountProfile(profile: AccountProfile) {
  const current = useSettings.getState()
  // Older desktop hosts send a complete ordered snapshot without a grant ID. Give each
  // observed login a memory-only display lifetime, leaving the route's real revision intact.
  const displayRevision = profile.signedIn
    ? profile.revision ?? current.accountDisplayRevision ?? `display-${++legacyAccountSession}`
    : null
  useSettings.setState({
    accountSignedIn: profile.signedIn,
    accountRevision: profile.signedIn ? profile.revision ?? null : null,
    accountDisplayRevision: displayRevision,
    accountName: profile.signedIn ? profile.name : '',
    accountAvatar: profile.signedIn ? profile.avatar : null,
  })
}

export const setChatSource = (chatSource: ChatSource) => {
  write(KEYS.chatSource, chatSource)
  useSettings.setState({ chatSource })
}

export const setLocale = (locale: LocalePreference) => {
  write(KEYS.locale, locale)
  useSettings.setState({ locale })
}

export const setLocation = (value: UserLocation | null) => {
  const location = normalizeLocation(value)
  write(KEYS.location, location ? JSON.stringify(location) : null)
  useSettings.setState({ location })
}

export const setThemePreference = (themePreference: ThemePreference) => {
  write(KEYS.themePreference, themePreference)
  useSettings.setState({ themePreference })
}

export const setTtsVoice = (ttsVoice: TtsVoice) => {
  write(KEYS.ttsVoice, ttsVoice)
  useSettings.setState({ ttsVoice })
}

const applyProfiles = (apiProfiles: ApiProfile[], activeProfileId: string | null) => {
  const active = apiProfiles.find((profile) => profile.id === activeProfileId) ?? null
  setApiConfig({
    origin: active?.origin ?? defaultApiOrigin,
    protocol: active?.protocol ?? 'deepseek',
    model: active?.model,
  })
  useSettings.setState({
    apiProfiles,
    activeProfileId: active?.id ?? null,
    apiKey: active?.apiKey ?? null,
    apiOrigin: active?.origin ?? defaultApiOrigin,
  })
}

let vault: ProfileVault | null = null
let queue: Promise<void> = Promise.resolve()
function serial<T>(work: () => Promise<T>) {
  const next = queue.then(work)
  queue = next.then(
    () => {},
    () => {}
  )
  return next
}

export const initializeCredentials = () =>
  serial(async () => {
    useSettings.setState({ credentialStatus: 'loading' })
    try {
      if (androidShell && (!securityState().vault || !securityState().unlocked)) {
        throw new Error('unavailable')
      }
      if (!androidShell && !globalThis.crypto?.subtle) {
        throw new Error('unavailable')
      }
      const store = androidShell
        ? nativeProfileVault
        : (await import('./security/browserVault.js')).browserProfileVault
      const profiles = await migrateProfiles(store, localStorage)
      applyProfiles(profiles, initialActiveProfileId(profiles))
      if (hasAccountBridge && !read(KEYS.chatSource)) {
        useSettings.setState({ chatSource: profiles.length ? 'api' : 'account' })
      }
      vault = store
      useSettings.setState({ credentialStatus: 'ready' })
    } catch {
      vault = null
      applyProfiles([], null)
      useSettings.setState({ credentialStatus: 'unavailable' })
      // Preserve the original data and allow access to history without exposing unverified profiles.
      throw new Error('无法读取安全存储。请解锁设备、检查剩余空间或更新 WebView 后重试。')
    }
  })

async function commitProfiles(profiles: ApiProfile[], activeId: string | null) {
  if (!vault || (androidShell && !securityState().unlocked)) {
    throw new Error('安全存储暂不可用，请在安全设置中重试。')
  }
  try {
    await persistProfiles(vault, profiles)
  } catch {
    vault = null
    useSettings.setState({ credentialStatus: 'unavailable' })
    throw new Error('未能确认安全存储中的新配置，请在安全设置中重试。')
  }
  write(KEYS.activeProfileId, activeId)
  applyProfiles(profiles, activeId)
}

export const saveApiProfile = (profile: ApiProfile) =>
  serial(async () => {
    const { apiProfiles } = useSettings.getState()
    const normalized: ApiProfile = {
      ...profile,
      name: profile.name.trim() || 'DeepSeek',
      origin: normalizeOrigin(profile.origin),
      model: profile.model.trim(),
      claudeModelFacts: selectedClaudeFacts(profile.origin, profile.model.trim(), profile.claudeModelFacts),
      contextWindow:
        validWindow(profile.contextWindow) ? profile.contextWindow : undefined,
      apiKey: profile.apiKey.trim(),
    }
    if (!normalized.apiKey && !allowsKeylessLocal(normalized.origin, normalized.protocol)) {
      throw new Error('请输入 API Key。')
    }
    const exists = apiProfiles.some((item) => item.id === normalized.id)
    await commitProfiles(
      exists
        ? apiProfiles.map((item) => (item.id === normalized.id ? normalized : item))
        : [...apiProfiles, normalized],
      normalized.id
    )
    if (hasAccountBridge) {
      setChatSource('api')
    }
  })

/** Context edits preserve the active profile, channel and credential. */
export const saveProfileWindow = (id: string, key: string, value?: number) => serial(async () => {
  const { apiProfiles, activeProfileId } = useSettings.getState()
  if (!apiProfiles.some(p => p.id === id)) {throw new Error('profile-missing')}
  await commitProfiles(apiProfiles.map(p => p.id === id ? withProfileWindow(p, key, value) : p), activeProfileId)
})

/** A conversation selection can update deployment facts without selecting or editing the profile. */
export const saveProfileDiscovery = (expected: ApiProfile, model: DiscoveredModel) => serial(async () => {
  const { apiProfiles, activeProfileId } = useSettings.getState()
  const profile = apiProfiles.find(p => p.id === expected.id)
  if (!profile || profile.origin !== expected.origin || profile.apiKey !== expected.apiKey ||
    profile.providerId !== expected.providerId || profile.protocol !== expected.protocol) { return }
  const key = profileWindowKey(profile.origin, model.id, profile.protocol)
  const context = validWindow(model.contextWindow) ? model.contextWindow : undefined
  const kind = context ? model.source : undefined
  const facts = selectedClaudeFacts(profile.origin, model.id, profile.claudeModelFacts)
  if (JSON.stringify(profile.discoveredWindowDetails?.[key]) === JSON.stringify(model.windowDetails) &&
      JSON.stringify(facts?.[model.id]) === JSON.stringify(profile.claudeModelFacts?.[model.id]) && profile.discoveredWindows?.[key] === context && profile.discoveredWindowKinds?.[key] === kind &&
      profile.discoveredReasoning?.[key] === model.reasoning) { return }
  const replace = <T,>(map: Record<string, T> | undefined, value: T | undefined) => value === undefined
    ? Object.fromEntries(Object.entries(map ?? {}).filter(([id]) => id !== key))
    : { ...map, [key]: value }
  const next: ApiProfile = { ...profile,
    claudeModelFacts: facts,
    discoveredWindows: replace(profile.discoveredWindows, context),
    discoveredWindowDetails: replace(profile.discoveredWindowDetails, model.windowDetails),
    discoveredWindowKinds: replace(profile.discoveredWindowKinds, kind),
    discoveredReasoning: replace(profile.discoveredReasoning, model.reasoning),
  }
  await commitProfiles(apiProfiles.map(item => item.id === profile.id ? next : item), activeProfileId)
})

export const removeApiProfile = (id: string) =>
  serial(async () => {
    const { apiProfiles, activeProfileId } = useSettings.getState()
    const next = apiProfiles.filter((profile) => profile.id !== id)
    await commitProfiles(next, activeProfileId === id ? (next[0]?.id ?? null) : activeProfileId)
  })

/** Selection writes an identifier only. Account and API credentials have independent lifetimes. */
export const selectApiProfile = async (id: string) => {
  const { apiProfiles } = useSettings.getState()
  if (!apiProfiles.some((profile) => profile.id === id)) {
    throw new Error('找不到此配置。')
  }
  write(KEYS.activeProfileId, id)
  applyProfiles(apiProfiles, id)
  if (hasAccountBridge) {
    setChatSource('api')
  }
}

export const clearApiProfiles = () => serial(() => commitProfiles([], null))

/** 生成一条空白配置 */
export const createApiProfile = (): ApiProfile => ({
  id: newProfileId(),
  name: 'DeepSeek',
  protocol: 'deepseek',
  origin: defaultApiOrigin,
  model: defaultApiModel,
  apiKey: '',
})

/** 兼容旧调用：写入当前配置的 Key，没有配置时新建一条 */
export const setApiKey = async (apiKey: string | null) => {
  const { apiProfiles, activeProfileId } = useSettings.getState()
  if (!apiKey) {
    if (activeProfileId) {
      await removeApiProfile(activeProfileId)
    }
    return
  }
  const active = apiProfiles.find((profile) => profile.id === activeProfileId)
  await saveApiProfile(active ? { ...active, apiKey } : { ...createApiProfile(), apiKey })
}

export const setThinking = (thinking: boolean) => {
  write(KEYS.thinking, String(thinking))
  useSettings.setState({ thinking })
}

export const setSearch = (search: boolean) => {
  write(KEYS.search, String(search))
  useSettings.setState({ search })
}

export const setAutoRead = (autoRead: boolean) => {
  write(KEYS.autoRead, String(autoRead))
  useSettings.setState({ autoRead })
}

export function saveIdentityPreference(identityPreference: IdentitySource) {
  write(KEYS.identityPreference, identityPreference)
  useSettings.setState({ identityPreference })
}

export const setFontScale = (fontScale: number) => {
  write(KEYS.fontScale, String(fontScale))
  useSettings.setState({ fontScale })
}

export const setAutoCollapseThinking = (autoCollapseThinking: boolean) => {
  write(KEYS.autoCollapseThinking, String(autoCollapseThinking))
  useSettings.setState({ autoCollapseThinking })
}

export const setSiderCollapsed = (siderCollapsed: boolean) => {
  write(KEYS.siderCollapsed, String(siderCollapsed))
  useSettings.setState({ siderCollapsed })
}
