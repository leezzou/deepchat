import type { ApiRuntimeConfig } from './origin.js'

/** Exact published model/endpoint pairs. See docs/provider-reasoning.md for the source contracts. */
export type ExtraReasoningWire =
  | 'thinking'
  | 'enabled'
  | 'reasoning-flag'
  | 'effort'
  | 'groq-qwen'
  | 'gemini-flash'
  | 'google-summary'
  | 'minimax-adaptive'
type Contract = ExtraReasoningWire | 'fixed'
const contracts = new Map<string, Map<string, Contract>>()
function add(origins: string[], setting: Contract, models: string[]) {
  for (const origin of origins) {
    const table = contracts.get(origin) ?? new Map<string, Contract>()
    for (const model of models) table.set(model, setting)
    contracts.set(origin, table)
  }
}
const dash = [
  'https://dashscope.aliyuncs.com/compatible-mode/v1',
  'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
]
add(dash, 'enabled', [
  'qwen4-max',
  'qwen4-max-preview',
  'qwen3.8-max',
  'qwen3.8-flash',
  'qwen3.8-27b',
  'qwen3.7-max',
  'qwen3.7-max-2026-05-20',
  'qwen3.7-max-2026-06-08',
  'qwen3.7-plus',
  'qwen3.7-plus-2026-05-26',
  'qwen3.7-flash',
  'qwen3.7-flash-2026-07-15',
  'qwen3.6-plus',
  'qwen3.6-plus-2026-04-02',
  'qwen3.6-flash',
  'qwen3.6-flash-2026-04-16',
  'qwen3.5-plus',
  'qwen3.5-plus-2026-02-15',
  'qwen3.5-flash',
  'qwen3.5-flash-2026-02-23',
  'qwen-plus',
  'qwen-plus-latest',
  'qwen-plus-2025-04-28',
  'qwen-flash',
  'qwen-flash-2025-07-28',
])
add(dash, 'fixed', [
  'qwen3.8-2.4t-a95b',
  'qwen3.7-max-preview',
  'qwen3.7-max-2026-05-17',
  'glm-5.3',
  'kimi-k2.7-code',
  'MiniMax-M2.5',
])
add(dash, 'enabled', [
  'glm-5.2',
  'glm-5.2-fast-preview',
  'glm-5.1',
  'glm-5',
  'kimi-k3.1-pro',
  'kimi-k3',
  'kimi-k2.6',
  'kimi-k2.5',
])
add(['https://ark.cn-beijing.volces.com/api/v3'], 'thinking', [
  'doubao-seed-1-6-251015',
  'doubao-seed-1-6-250615',
  'doubao-seed-1-6-vision-250815',
  'doubao-seed-1-6-flash-250828',
  'doubao-seed-2-1-pro-260915',
])
add(['https://qianfan.baidubce.com/v2'], 'fixed', ['ernie-5.5-flash-preview'])
add(['https://api.cohere.ai/compatibility/v1'], 'effort', [
  'command-a-reasoning-08-2025',
  'command-a-plus-05-2026',
])
add(['https://qianfan.baidubce.com/v2'], 'thinking', ['ernie-light-dt-1.0'])
add(['https://qianfan.baidubce.com/v2'], 'enabled', [
  'qwen3-32b',
  'qwen3-14b',
  'qwen3-8b',
  'ernie-4.5-turbo-vl-preview',
  'ernie-4.5-turbo-vl-32k-preview',
  'ernie-4.5-vl-28b-a3b',
  'ernie-5.0-thinking-preview',
])
const glm = ['https://open.bigmodel.cn/api/paas/v4', 'https://api.z.ai/api/paas/v4']
add(glm, 'thinking', ['glm-4.6', 'glm-4.7', 'glm-5', 'glm-5.1', 'glm-5.2'])
add(glm, 'fixed', ['glm-5.3', 'glm-5.3-flash'])
const moonshot = ['https://api.moonshot.cn/v1', 'https://api.moonshot.ai/v1']
add(moonshot, 'thinking', ['kimi-k2.6'])
add(moonshot, 'fixed', [
  'kimi-k2.7-code',
  'kimi-k2.7-code-highspeed',
  'kimi-k3',
  'kimi-k3.1-pro',
  'kimi-k3.1-pro-highspeed',
])
const silicon = ['https://api.siliconflow.cn/v1', 'https://api.siliconflow.com/v1']
add(silicon, 'enabled', [
  'Qwen/Qwen3-8B',
  'Qwen/Qwen3-14B',
  'Qwen/Qwen3-32B',
  'Qwen/Qwen3-235B-A22B',
  'tencent/Hunyuan-A13B-Instruct',
  'zai-org/GLM-5V-Turbo',
  'zai-org/GLM-4.6V',
])
add(['https://api.together.xyz/v1', 'https://api.together.ai/v1'], 'reasoning-flag', [
  'MiniMaxAI/MiniMax-M3.1-Flash',
  'deepseek-ai/DeepSeek-V4-Pro-0813',
  'zai-org/GLM-5.2',
  'moonshotai/Kimi-K3',
  'Qwen/Qwen3.6-Plus',
  'Qwen/Qwen3.5-9B',
])
add(['https://api.deepinfra.com/v1/openai'], 'effort', [
  'deepseek-ai/DeepSeek-V4-Flash-0731',
  'deepseek-ai/DeepSeek-V4-Pro-0813',
  'zai-org/GLM-5.2',
  'moonshotai/Kimi-K3',
  'inclusionAI/Ling-3.0-flash',
])
const fireworks = ['https://api.fireworks.ai/inference/v1']
add(
  fireworks,
  'effort',
  [
    'deepseek-v4p1-flash',
    'deepseek-v4p1-flash-1017',
    'deepseek-v3p1',
    'deepseek-v3p2',
    'qwen3p8-max',
    'kimi-k3',
  ].map((id) => `accounts/fireworks/models/${id}`)
)
add(fireworks, 'fixed', ['accounts/fireworks/models/minimax-m2'])
const groq = ['https://api.groq.com/openai/v1']
add(groq, 'groq-qwen', ['qwen/qwen3.8-27b'])
add(groq, 'fixed', ['openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'meta-models/muse-spark-open'])
const google = ['https://generativelanguage.googleapis.com/v1beta/openai']
add(google, 'gemini-flash', ['gemini-2.5-flash', 'gemini-2.5-flash-lite'])
add(google, 'google-summary', [
  'gemini-2.5-pro',
  'gemini-3-flash-preview',
  'gemini-3.1-flash-lite',
  'gemini-4-hydrogen',
])
add(['https://api.x.ai/v1'], 'fixed', ['grok-4.5', 'grok-4.6', 'grok-4.7'])
add(['https://api.stepfun.com/v1'], 'fixed', ['step-3.7-flash'])
const minimax = ['https://api.minimax.io/v1', 'https://api.minimaxi.com/v1']
add(minimax, 'fixed', ['MiniMax-M3.1-Flash'])
add(minimax, 'minimax-adaptive', ['MiniMax-M3'])

function contract(config: ApiRuntimeConfig) {
  if (config.protocol !== 'openai') return undefined
  return contracts.get(config.origin.replace(/\/+$/, ''))?.get(config.model)
}
export function knownReasoningSupport(config: ApiRuntimeConfig) {
  const setting = contract(config)
  if (setting === 'fixed' || setting === 'google-summary') return 'fixed'
  return setting ? 'toggle' : undefined
}
export function extraReasoningWire(config: ApiRuntimeConfig): ExtraReasoningWire | undefined {
  const setting = contract(config)
  // Fixed Google models expose a request flag for public summaries alone.
  if (setting === 'google-summary' && config.reasoningSupport !== 'none') return setting
  return config.reasoningSupport === 'none' ||
    config.reasoningSupport === 'fixed' ||
    setting === 'fixed'
    ? undefined
    : setting
}
export function extraReasoningFields(wire: string | undefined, enabled: boolean) {
  switch (wire) {
    case 'minimax-adaptive':
      return { thinking: { type: enabled ? 'adaptive' : 'disabled' }, reasoning_split: true }
    case 'reasoning-flag':
      return { reasoning: { enabled } }
    case 'effort':
      return { reasoning_effort: enabled ? 'high' : 'none' }
    case 'groq-qwen':
      return {
        reasoning_effort: enabled ? 'medium' : 'none',
        reasoning_format: enabled ? 'parsed' : 'hidden',
      }
    case 'gemini-flash':
      return {
        extra_body: {
          google: {
            thinking_config: { thinking_budget: enabled ? -1 : 0, include_thoughts: enabled },
          },
        },
      }
    case 'google-summary':
      return { extra_body: { google: { thinking_config: { include_thoughts: enabled } } } }
    default:
      return {}
  }
}
