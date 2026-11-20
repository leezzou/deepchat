import { isDeepSeekApiOrigin } from './providerParity.js'
import { isOpenAiOrigin, supportsOpenAiSearch } from './openAiModels.js'
import { isAnthropicOrigin, supportsClaudeSearch } from './anthropicOfficial.js'
import type { CreateMessageRequest } from './types.js'

export type SearchCapability = 'deepseek' | 'openrouter' | 'dashscope' | 'anthropic' | 'openai' | 'none'
const dashscope = new Set([
  'https://dashscope.aliyuncs.com/compatible-mode/v1',
  'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
])
// https://www.alibabacloud.com/help/en/model-studio/web-search (Chat Completions, Beijing/Singapore).
const searchModels = new Set([
  'deepseek-v4-pro',
  'deepseek-v4-pro-0813',
  'deepseek-v4-flash-0731',
  'deepseek-v4.1-flash-1017',
  'qwen3.7-max',
  'qwen3.7-plus',
  'qwen3.7-flash',
  'qwen3.6-plus',
  'qwen3.6-flash',
])
const beijingModels = new Set(['qwen-plus', 'qwen-plus-latest', 'qwen-flash', 'qwen-max'])
export function searchCapability(
  origin: string,
  protocol: string,
  model: string
): SearchCapability {
  const endpoint = origin.replace(/\/+$/, '')
  // https://api-docs.deepseek.com/guides/web_tools.md explicitly specifies the Flash model.
  if (
    (protocol === 'anthropic' || protocol === 'openai') &&
    isAnthropicOrigin(endpoint) &&
    supportsClaudeSearch(model)
  )
    return 'anthropic'
  if (
    isDeepSeekApiOrigin(endpoint) &&
    (protocol === 'openai' ||
      (protocol === 'deepseek' && endpoint === 'https://api.deepseek.com')) &&
    ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'].includes(model)
  )
    return 'deepseek'
  if (protocol !== 'openai' || !model) return 'none'
  if (isOpenAiOrigin(endpoint) && supportsOpenAiSearch(model)) return 'openai'
  // https://openrouter.ai/docs/guides/features/plugins/web-search.md publishes model-agnostic support.
  if (endpoint === 'https://openrouter.ai/api/v1') return 'openrouter'
  if (
    dashscope.has(endpoint) &&
    (searchModels.has(model) ||
      (endpoint === 'https://dashscope.aliyuncs.com/compatible-mode/v1' &&
        beijingModels.has(model)))
  )
    return 'dashscope'
  return 'none'
}

/** These fields only belong on the selected supplier's own Chat Completions endpoint. */
export function chatSearchFields(
  origin: string,
  model: string,
  tools?: CreateMessageRequest['tools'],
  grant?: string
) {
  const kind = searchCapability(origin, 'openai', model)
  if (kind === 'deepseek' && tools?.length) return { tools: tools.map(({ type }) => ({ type })) }
  if (!tools?.some((tool) => tool.type === 'deepseek_web_search') || !grant) return {}
  if (kind === 'openrouter' && grant.startsWith('openrouter:')) return { plugins: [{ id: 'web' }] }
  if (kind === 'dashscope' && grant.startsWith('dashscope:')) return { enable_search: true }
  return {}
}
