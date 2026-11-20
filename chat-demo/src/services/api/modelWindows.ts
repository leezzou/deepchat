import { loadCatalogModels, resolveCatalogModel, type CatalogModel } from './modelCatalog.js'
import { providerPresets } from './providerPresets.js'
import { getWorkBuddyModel } from '../workbuddy/models.js'

export const nativeModels = ['deepseek-flash', 'deepseek-v4-pro'] as const
export const fallbackWindow = 128_000
export const validWindow = (n: unknown): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n > 0
export function parseWindow(text: string) {
  const n = Number(text)
  return /^\d+$/.test(text) && validWindow(n) ? n : undefined
}
export type WindowSpec = {
  window: number
  output?: number
  input?: number
  modelWindow?: number
  tiers?: number[]
  basis:
    | 'provider'
    | 'model'
    | 'variable'
    | 'historical'
    | 'input'
    | 'discovered'
    | 'bundled'
    | 'catalog'
    | 'fallback'
  urls: string[]
  name?: string
}
const spec = (
  window: number,
  url: string,
  basis: WindowSpec['basis'] = 'provider',
  output?: number
): WindowSpec => ({ window, urls: [url], basis, output })
const unknown: WindowSpec = { window: fallbackWindow, basis: 'fallback', urls: [] }
const officialDocs = 'https://api-docs.deepseek.com/zh-cn/api/list-models/'
const pricing = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/'
const officialModels: Record<string, string> = {
  'deepseek-flash': 'DeepSeek-V4.1-Flash-1017',
  'deepseek-v4-flash': 'DeepSeek-V4.1-Flash-1017',
  'deepseek-v4-flash-vision-exp': 'DeepSeek-V4.1-Flash-1017',
  'deepseek-v4-pro': 'DeepSeek-V4-Pro-0813',
}
const wbDocs =
  'https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Model'
// Exceptions are bound to immutable wire IDs, never a mutable preset model.
// Regular published provider-specific limits come from the lazy catalog.
const legacyKimi = spec(262_144, 'https://platform.kimi.com/docs/pricing/chat', 'historical')
legacyKimi.urls.push('https://platform.kimi.com/docs/models')
const exceptions: Record<string, WindowSpec> = {
  'kimi:kimi-k2-0905-preview': legacyKimi,
  'kimi-intl:kimi-k2-0905-preview': legacyKimi,
  'volcengine:doubao-seed-1-6': spec(
    256_000,
    'https://console.volcengine.com/ark/region:cn-beijing/model/detail?Id=doubao-seed-1-6',
    'model'
  ),
  'stepfun:step-2-16k': spec(
    16_000,
    'https://platform.stepfun.com/docs/zh/guides/model-migration',
    'historical'
  ),
  'gemini:gemini-2.5-pro': {
    ...spec(
      1_048_576,
      'https://ai.google.dev/gemini-api/docs/models/gemini-2.5-pro',
      'input',
      65_536
    ),
    input: 1_048_576,
  },
  'xai:grok-4': spec(
    fallbackWindow,
    'https://docs.x.ai/developers/migration/may-15-retirement',
    'fallback'
  ),
  'fireworks:accounts/fireworks/models/llama-v3p3-70b-instruct': spec(
    131_000,
    'https://fireworks.ai/models/fireworks/llama-v3p3-70b-instruct',
    'variable'
  ),
  'cerebras:llama-3.3-70b': spec(
    fallbackWindow,
    'https://inference-docs.cerebras.ai/models/overview',
    'fallback'
  ),
  'sambanova:Meta-Llama-3.3-70B-Instruct': spec(
    128_000,
    'https://docs.sambanova.ai/docs/en/models/sambacloud-models'
  ),
  'novita:deepseek/deepseek-v3': spec(
    128_000,
    'https://huggingface.co/deepseek-ai/DeepSeek-V3',
    'model'
  ),
  'openrouter:z-ai/glm-4.6': spec(
    198_000,
    'https://openrouter.ai/api/v1/models/z-ai/glm-4.6/endpoints',
    'variable'
  ),
  'cohere:command-r-plus': spec(
    128_000,
    'https://docs.cohere.com/docs/command-r-plus',
    'historical',
    4096
  ),
}
const localDefaults: Record<string, WindowSpec> = {
  ollama: spec(4096, 'https://docs.ollama.com/context-length', 'variable'),
  lmstudio: spec(fallbackWindow, 'https://lmstudio.ai/docs/developer/rest/list', 'fallback'),
}
export function allowsKeylessLocal(origin: string, protocol: string) {
  if (protocol !== 'openai') {
    return false
  }
  try {
    const url = new URL(origin)
    return (
      /^(?:localhost|127\.\d+\.\d+\.\d+|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(
        url.hostname
      ) &&
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password
    )
  } catch {
    return false
  }
}
export function endpointProvider(origin: string, configured?: string) {
  if (configured === 'ollama' || configured === 'lmstudio') {
    return configured
  }
  const endpoint = origin.trim().replace(/\/+$/, '')
  if (endpoint === 'https://api.anthropic.com') return 'anthropic'
  if (endpoint === 'https://api.deepseek.com/v1') {
    return 'deepseek'
  }
  return providerPresets.find((p) => p.origin && p.origin === endpoint)?.value
}
const loaded = new Set<string>()
export function warmModelWindows(provider: string | undefined) {
  if (!provider || provider === 'workbuddy' || loaded.has(provider)) {
    return
  }
  return loadCatalogModels(provider).then(
    () => {
      loaded.add(provider)
    },
    () => {}
  )
}
export function getModelWindow(provider: string | undefined, model: string): WindowSpec {
  if (provider === 'workbuddy') {
    const row = getWorkBuddyModel(model)
    return row && validWindow(row.contextWindow)
      ? {
          name: row.name,
          window: row.contextWindow,
          tiers: row.contextTiers,
          basis: row.source === 'account' ? 'discovered' : 'bundled',
          urls: [wbDocs],
        }
      : { ...unknown, name: row?.name, urls: [wbDocs] }
  }
  if (provider === 'deepseek' && Object.hasOwn(officialModels, model)) {
    return {
      name: officialModels[model],
      window: 1_048_576,
      output: 393_216,
      basis: 'provider',
      urls: [officialDocs, pricing],
    }
  }
  const key = `${provider}:${model}`
  const base = exceptions[key] ?? localDefaults[provider ?? ''] ?? unknown
  const row = provider ? resolveCatalogModel(provider, model) : undefined
  if (!row) {
    return base
  }
  if (row.scope === 'local-reference') {
    return validWindow(row.contextWindow)
      ? {
          ...base,
          modelWindow: row.contextWindow,
          name: row.name,
          urls: [...base.urls, row.sourceUrl],
        }
      : base
  }
  // These two sources distinguish model input and the smallest active route, respectively.
  if (key === 'gemini:gemini-2.5-pro' || key === 'openrouter:z-ai/glm-4.6') {
    return {
      ...base,
      name: row.name,
      output: base.output ?? row.outputLimit,
      urls: [...base.urls, row.sourceUrl],
    }
  }
  return catalogWindow(row, base)
}

export function catalogWindow(row: CatalogModel, base: WindowSpec = unknown): WindowSpec {
  const input = validWindow(row.inputLimit) ? row.inputLimit : undefined
  const output = validWindow(row.outputLimit) ? row.outputLimit : undefined
  const context = validWindow(row.contextWindow) ? row.contextWindow : undefined
  if (!context && !input && !output) {
    return base
  }
  const urls = context || input ? [row.sourceUrl] : [...base.urls, row.sourceUrl]
  return {
    window: context ?? input ?? base.window,
    input,
    output: output ?? base.output,
    urls,
    name: row.name,
    basis: context ? 'catalog' : input ? 'input' : base.basis,
  }
}
