import { create } from 'zustand'
import { hasAccountBridge } from '../shell/account.js'
import {
  defaultApiOrigin,
  defaultApiModel,
  normalizeOrigin,
  setApiConfig,
  type ApiProtocol,
} from './api/origin.js'
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
  /** 仅 openai 协议使用 */
  model: string
  /** 上下文窗口（token）；不填按协议默认（DeepSeek 1M / 其他 128k） */
  contextWindow?: number
  apiKey: string
}

/** 本机设置，存 localStorage：API 配置、语言、主题、位置、朗读音色、深度思考与智能搜索开关、侧边栏收起状态 */
type Settings = {
  /** 当前启用配置的 Key；没有配置时为 null */
  apiKey: string | null
  /** Native host reports only sign-in status. */
  accountSignedIn: boolean
  chatSource: ChatSource
  /** 当前启用配置的接口地址 */
  apiOrigin: string
  apiProfiles: ApiProfile[]
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
  displayName: string
  avatar: string | null
  fontScale: number
  /** 思考内容结束后自动折叠（官方「个性化」里的开关） */
  autoCollapseThinking: boolean
}

export type ChatSource = 'account' | 'api'

const KEYS = {
  chatSource: 'chat-demo:chat-source',
  apiKey: 'chat-demo:api-key',
  apiProfiles: 'chat-demo:api-profiles',
  activeProfileId: 'chat-demo:active-profile',
  locale: 'chat-demo:locale',
  location: 'chat-demo:location',
  themePreference: 'chat-demo:theme-preference',
  ttsVoice: 'chat-demo:tts-voice',
  thinking: 'chat-demo:thinking',
  search: 'chat-demo:search',
  autoRead: 'chat-demo:auto-read',
  siderCollapsed: 'chat-demo:sider-collapsed',
  displayName: 'chat-demo:display-name',
  avatar: 'chat-demo:avatar',
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

/** 读取已保存的多条配置；没有时把旧版的单 Key 迁移成一条 */
const initialApiProfiles = (): ApiProfile[] => {
  try {
    const saved: unknown = JSON.parse(read(KEYS.apiProfiles) ?? 'null')
    if (Array.isArray(saved)) {
      return saved.flatMap((item) => {
        if (typeof item !== 'object' || item === null) {
          return []
        }
        const raw = item as Partial<Record<keyof ApiProfile, unknown>>
        const apiKey = typeof raw.apiKey === 'string' ? raw.apiKey : ''
        if (!apiKey) {
          return []
        }
        return [
          {
            id: typeof raw.id === 'string' && raw.id ? raw.id : newProfileId(),
            name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : 'DeepSeek',
            protocol: raw.protocol === 'openai' ? 'openai' : 'deepseek',
            origin: normalizeOrigin(typeof raw.origin === 'string' ? raw.origin : ''),
            model: typeof raw.model === 'string' ? raw.model.trim() : '',
            contextWindow:
              typeof raw.contextWindow === 'number' && raw.contextWindow > 0
                ? raw.contextWindow
                : undefined,
            apiKey,
          },
        ]
      })
    }
  } catch {
    // 解析失败按未保存处理
  }
  const legacy = read(KEYS.apiKey)
  return legacy
    ? [
        {
          id: 'default',
          name: 'DeepSeek',
          protocol: 'deepseek',
          origin: defaultApiOrigin,
          model: '',
          apiKey: legacy,
        },
      ]
    : []
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

const savedSource = read(KEYS.chatSource)
const initialSource: ChatSource = hasAccountBridge &&
  (savedSource === 'account' || (!initialActive && savedSource !== 'api')) ? 'account' : 'api'

export const useSettings = create<Settings>(() => ({
  accountSignedIn: false,
  chatSource: initialSource,
  apiKey: initialActive?.apiKey ?? null,
  apiOrigin: initialActive?.origin ?? defaultApiOrigin,
  apiProfiles: initialProfiles,
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
  displayName: read(KEYS.displayName) ?? 'DeepSeek 用户',
  avatar: read(KEYS.avatar),
  fontScale: Number(read(KEYS.fontScale)) || 1,
  autoCollapseThinking: read(KEYS.autoCollapseThinking) !== 'false',
}))

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

/** 把配置列表与当前启用项一起落盘，并同步给接口层 */
const applyProfiles = (apiProfiles: ApiProfile[], activeProfileId: string | null) => {
  const active = apiProfiles.find((profile) => profile.id === activeProfileId) ?? null
  setApiConfig({
    origin: active?.origin,
    protocol: active?.protocol,
    model: active?.model,
  })
  write(KEYS.apiProfiles, JSON.stringify(apiProfiles))
  write(KEYS.activeProfileId, active?.id ?? null)
  // 兼容旧字段，回退到单 Key 版本时不丢配置
  write(KEYS.apiKey, active?.apiKey ?? null)
  useSettings.setState({
    apiProfiles,
    activeProfileId: active?.id ?? null,
    apiKey: active?.apiKey ?? null,
    apiOrigin: active?.origin ?? defaultApiOrigin,
  })
}

/** 新增或更新一条配置；新配置自动启用 */
export const saveApiProfile = (profile: ApiProfile) => {
  const { apiProfiles } = useSettings.getState()
  const normalized: ApiProfile = {
    ...profile,
    name: profile.name.trim() || 'DeepSeek',
    origin: normalizeOrigin(profile.origin),
    model: profile.model.trim(),
    contextWindow:
      profile.contextWindow && profile.contextWindow > 0 ? profile.contextWindow : undefined,
    apiKey: profile.apiKey.trim(),
  }
  const exists = apiProfiles.some((item) => item.id === normalized.id)
  const next = exists
    ? apiProfiles.map((item) => (item.id === normalized.id ? normalized : item))
    : [...apiProfiles, normalized]
  // 「保存并启用」：无论新增还是编辑，保存后都切到这条配置
  applyProfiles(next, normalized.id)
  if (hasAccountBridge) setChatSource('api')
}

/** 删除一条配置；删掉当前启用的那条时自动切到第一条 */
export const removeApiProfile = (id: string) => {
  const { apiProfiles, activeProfileId } = useSettings.getState()
  const next = apiProfiles.filter((profile) => profile.id !== id)
  applyProfiles(next, activeProfileId === id ? (next[0]?.id ?? null) : activeProfileId)
}

/** 切换当前启用的配置 */
export const selectApiProfile = (id: string) => {
  applyProfiles(useSettings.getState().apiProfiles, id)
  if (hasAccountBridge) setChatSource('api')
}

/** 退出登录：清空全部 API 配置（对话记录保留） */
export const clearApiProfiles = () => {
  applyProfiles([], null)
}

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
export const setApiKey = (apiKey: string | null) => {
  const { apiProfiles, activeProfileId } = useSettings.getState()
  if (!apiKey) {
    if (activeProfileId) {
      removeApiProfile(activeProfileId)
    }
    return
  }
  const active = apiProfiles.find((profile) => profile.id === activeProfileId)
  saveApiProfile(active ? { ...active, apiKey } : { ...createApiProfile(), apiKey })
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

export const setDisplayName = (displayName: string) => {
  write(KEYS.displayName, displayName.trim() || 'DeepSeek 用户')
  useSettings.setState({ displayName: displayName.trim() || 'DeepSeek 用户' })
}

export const setAvatar = (avatar: string | null) => {
  write(KEYS.avatar, avatar)
  useSettings.setState({ avatar })
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
