import { claudeReasoningSupport, isAnthropicOrigin } from './anthropicOfficial.js'
import { extraReasoningWire, extraReasoningFields, type ExtraReasoningWire } from './providerReasoningCatalog.js'
import { hasOpenAiThinkingToggle, isOpenAiOrigin } from './openAiModels.js'
import type { ApiRuntimeConfig } from './origin.js'

/** Scope discovered capability to the saved endpoint, protocol and exact model. */
export type ReasoningSupport = 'toggle' | 'fixed' | 'none'
type ReasoningWire = ExtraReasoningWire | 'openai' | 'anthropic' | 'thinking' | 'enabled' | 'openrouter' | 'ollama' | undefined

export const isDeepSeekApiOrigin = (origin: string) =>
  ['https://api.deepseek.com', 'https://api.deepseek.com/v1'].includes(origin.replace(/\/+$/, ''))

const officialModels = [
  'deepseek-flash',
  'deepseek-v4-flash',
  'deepseek-v4-flash-vision-exp',
  'deepseek-v4-pro',
]
const zenModels = [
  'deepseek-v4-pro',
  'deepseek-v4-flash',
  'deepseek-v4.1-flash',
  'deepseek-v4.1-flash-free',
]
const routerModels = [
  'deepseek/deepseek-v4-pro',
  'deepseek/deepseek-v4-flash',
  'deepseek/deepseek-v4-pro-0813',
  'deepseek/deepseek-v4-flash-0731',
  'deepseek/deepseek-v4.1-flash',
  'deepseek/deepseek-v4.1-flash-1017',
]
const siliconModels = ['deepseek-ai/DeepSeek-V4-Pro', 'deepseek-ai/DeepSeek-V4-Flash']
const dashscopeModels = [
  'deepseek-v4.1-flash',
  'deepseek-v4-pro',
  'deepseek-v4-flash-0731',
  'deepseek-v4-pro-0813',
]

/** Select a documented *request* switch. A model ID or a vendor label alone cannot specify a gateway's protocol. */
export function reasoningWire(config: ApiRuntimeConfig): ReasoningWire {
  const endpoint = config.origin.replace(/\/+$/, '')
  const { model, reasoningSupport: support } = config
  const extra = extraReasoningWire(config)
  if (extra) { return extra }
  if (support === 'none' || support === 'fixed') {
    return undefined
  }
  if (config.protocol === 'openai' && isOpenAiOrigin(endpoint)) {
    return hasOpenAiThinkingToggle(model) ? 'openai' : undefined
  }
  if (config.protocol !== 'deepseek' && isAnthropicOrigin(endpoint)) {
    return claudeReasoningSupport(model) === 'toggle' ? 'anthropic' : undefined
  }
  if (config.protocol === 'deepseek') {
    return isDeepSeekApiOrigin(endpoint) && officialModels.includes(model) ? 'thinking' : undefined
  }
  // https://api-docs.deepseek.com/guides/thinking_mode/
  if (isDeepSeekApiOrigin(endpoint)) {
    return support === 'toggle' || officialModels.includes(model) ? 'thinking' : undefined
  }
  // https://openrouter.ai/docs/guides/best-practices/reasoning-tokens
  if (endpoint === 'https://openrouter.ai/api/v1') {
    return support === 'toggle' || routerModels.includes(model) ? 'openrouter' : undefined
  }
  // https://github.com/anomalyco/models.dev/tree/dev/providers/opencode/models
  if (
    ['https://opencode.ai/inference/openai/v1', 'https://opencode.ai/zen/v1'].includes(endpoint)
  ) {
    return zenModels.includes(model) ? 'thinking' : undefined
  }
  // https://docs.siliconflow.cn/docs/api/chat-completions-post
  if (['https://api.siliconflow.cn/v1', 'https://api.siliconflow.com/v1'].includes(endpoint)) {
    return siliconModels.includes(model) ? 'enabled' : undefined
  }
  // https://help.aliyun.com/en/model-studio/deepseek-api
  if (
    [
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
      'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    ].includes(endpoint)
  ) {
    return dashscopeModels.includes(model) ? 'enabled' : undefined
  }
  // Ollama's OpenAI adapter maps high to on and none to off. /api/show can veto a static model or confirm a private alias.
  // https://github.com/ollama/ollama/blob/main/openai/openai.go#L550
  if (
    config.providerId === 'ollama' ||
    ['https://ollama.com/v1', 'http://localhost:11434/v1', 'http://127.0.0.1:11434/v1'].includes(
      endpoint
    )
  ) {
    return support === 'toggle' || /^deepseek-v4-(?:pro|flash)(?::cloud)?$/.test(model)
      ? 'ollama'
      : undefined
  }
  return undefined
}

export function reasoningFields(wire: ReasoningWire, enabled: boolean | undefined) {
  if (enabled === undefined) {
    return {}
  }
  switch (wire) {
    case 'thinking':
      return { thinking: { type: enabled ? 'enabled' : 'disabled' } }
    case 'enabled':
      return { enable_thinking: enabled }
    case 'openrouter':
      return { reasoning: { enabled } }
    case 'openai':
      return { reasoning_effort: enabled ? 'medium' : 'none' }
    case 'ollama':
      return { reasoning_effort: enabled ? 'high' : 'none' }
    default:
      return extraReasoningFields(wire, enabled)
  }
}
