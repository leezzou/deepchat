/**
 * 当前生效的接口配置：地址、协议、模型。
 * 构建期注入默认值（DeepSeek 官方 + Anthropic 兼容协议），运行时由所选 API 配置覆盖。
 */

/** deepseek = DeepSeek 的 Anthropic 兼容协议；openai = OpenAI 兼容 /chat/completions */
export type ApiProtocol = 'deepseek' | 'openai'

export type ApiRuntimeConfig = {
  origin: string
  protocol: ApiProtocol
  /** 仅 openai 协议使用；deepseek 协议固定用内置模型 */
  model: string
}

const DEFAULT_ORIGIN = __API_ORIGIN__
const DEFAULT_MODEL = 'deepseek-flash'

let current: ApiRuntimeConfig = {
  origin: DEFAULT_ORIGIN,
  protocol: 'deepseek',
  model: DEFAULT_MODEL,
}

/** 去掉结尾斜杠；空值回退到默认地址 */
export const normalizeOrigin = (value: string | null | undefined): string => {
  const trimmed = (value ?? '').trim().replace(/\/+$/, '')
  return trimmed || DEFAULT_ORIGIN
}

export const getApiConfig = (): ApiRuntimeConfig => current

export const setApiConfig = (config: Partial<ApiRuntimeConfig>) => {
  current = {
    origin: normalizeOrigin(config.origin ?? current.origin),
    protocol: config.protocol ?? current.protocol,
    model: (config.model ?? '').trim() || DEFAULT_MODEL,
  }
}

export const getApiOrigin = (): string => current.origin

export const defaultApiOrigin = DEFAULT_ORIGIN
export const defaultApiModel = DEFAULT_MODEL
