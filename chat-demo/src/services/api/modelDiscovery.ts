import { claudeHeaders, isAnthropicOrigin, observeClaudeModel } from './anthropicOfficial.js'
import { isOpenAiOrigin, isOpenAiChatModel } from './openAiModels.js'
import { androidShell, nativeModelRequest } from '../security/bridge.js'

type Json = Record<string, unknown>
export type DiscoveryProfile = { providerId: string; endpoint: string; apiKey: string }
export type DiscoveredModel = {
  id: string
  name: string
  reasoning?: import('./providerParity.js').ReasoningSupport
  inspected?: boolean
  contextWindow?: number
  source: 'endpoint' | 'instance' | 'model' | 'input'
}
type Auth = 'bearer' | 'anthropic' | 'gemini'
type ListKind =
  | 'compatible'
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'cohere'
  | 'openrouter'
  | 'deepseek'
  | 'ollama'
  | 'lmstudio'
  | 'sensenova'
  | 'opencode'
  | 'tokenhub'
const asRecord = (value: unknown): Json =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {}
const str = (value: unknown): string =>
  typeof value === 'string' &&
  value.length <= 4096 &&
  !Array.from(value).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
    ? value.trim()
    : ''
const tokens = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
const responseLimit = 8 * 1024 * 1024

/** Endpoint and cursor are kept separate. Never follow server-provided URLs or send cookies. */
export function modelEndpoint(raw: string) {
  const url = new URL(raw)
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    /[\\\s]/u.test(raw)
  ) {
    throw new Error('endpoint')
  }
  if (
    url.protocol === 'http:' &&
    !/^(?:localhost|127\.\d+\.\d+\.\d+|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)$/u.test(
      url.hostname
    )
  ) {
    throw new Error('https')
  }
  return url
}

function kindFor(profile: DiscoveryProfile, base: URL): ListKind {
  const path = base.pathname.replace(/\/+$/u, '')
  if (profile.providerId === 'ollama' || profile.providerId === 'lmstudio') {
    return profile.providerId
  }
  // Native cloud APIs are only substituted for the exact official configuration.
  // A modified address always stays on the user's own compatible endpoint.
  if (base.origin === 'https://api.deepseek.com' && (path === '' || path === '/v1')) {
    return 'deepseek'
  }
  if (base.origin === 'https://api.sensenova.cn' && /^\/compatible-mode\/v[12]$/u.test(path)) {
    return 'sensenova'
  }
  if (base.origin === 'https://opencode.ai' && /^\/inference(\/go)?\/openai\/v1$/u.test(path)) {
    return 'opencode'
  }
  if (base.origin === 'https://tokenhub.tencentmaas.com' && path === '/v1') {
    return 'tokenhub'
  }
  if (isOpenAiOrigin(base.href)) return 'openai'
  if (isAnthropicOrigin(base.href)) {
    return 'anthropic'
  }
  if (base.origin === 'https://generativelanguage.googleapis.com' && path === '/v1beta/openai') {
    return 'gemini'
  }
  if (base.origin === 'https://api.cohere.ai' && path === '/compatibility/v1') {
    return 'cohere'
  }
  if (base.origin === 'https://openrouter.ai' && path === '/api/v1') {
    return 'openrouter'
  }
  return 'compatible'
}

class DiscoveryHttpError extends Error {
  readonly status: number
  constructor(status: number) {
    super(`HTTP ${status}`)
    this.status = status
  }
}
const checkAbort = (signal: AbortSignal) => {
  if (signal.aborted) {
    throw new Error('aborted')
  }
}

async function readBounded(response: Response) {
  if (Number(response.headers.get('Content-Length')) > responseLimit) {
    throw new Error('size')
  }
  if (!response.body) {
    throw new Error('body')
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let size = 0,
    text = ''
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) {
        break
      }
      size += part.value.byteLength
      if (size > responseLimit) {
        await reader.cancel()
        throw new Error('size')
      }
      text += decoder.decode(part.value, { stream: true })
    }
    return JSON.parse(text + decoder.decode()) as unknown
  } finally {
    reader.releaseLock()
  }
}

async function getJson(
  profile: DiscoveryProfile,
  url: URL,
  auth: Auth,
  signal: AbortSignal,
  model?: string
): Promise<Json> {
  checkAbort(signal)
  if (url.origin !== modelEndpoint(profile.endpoint).origin) {
    throw new Error('origin')
  }
  let data: unknown
  if (androidShell) {
    const reply = await nativeModelRequest(
      { endpoint: profile.endpoint, url: url.toString(), auth, key: profile.apiKey.trim(), model },
      signal
    )
    checkAbort(signal)
    if (reply.status < 200 || reply.status >= 300) {
      throw new DiscoveryHttpError(reply.status)
    }
    data = JSON.parse(reply.body)
  } else {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (auth === 'anthropic') {
      Object.assign(headers, claudeHeaders(profile.apiKey))
    } else if (auth === 'gemini') {
      headers['x-goog-api-key'] = profile.apiKey
    } else if (profile.apiKey) {
      headers.Authorization = `Bearer ${profile.apiKey}`
    }
    if (model) {
      headers['Content-Type'] = 'application/json'
    }
    const response = await fetch(url.toString(), {
      method: model ? 'POST' : 'GET',
      headers,
      signal,
      body: model ? JSON.stringify({ model }) : undefined,
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new DiscoveryHttpError(response.status)
    }
    data = await readBounded(response)
  }
  if (Array.isArray(data)) {
    return { data }
  } // Together AI lists models as a top-level array.
  if (!data || typeof data !== 'object') {
    throw new Error('format')
  }
  return asRecord(data)
}

function withPath(base: URL, path: string) {
  const url = new URL(base.href)
  url.pathname = path
  return url
}
const localRoot = (base: URL) => base.pathname.replace(/\/+$/u, '').replace(/\/v1$/u, '')
function array(body: Json, field: string) {
  if (!Array.isArray(body[field])) {
    throw new Error('format')
  }
  return body[field].map(asRecord)
}

/** Only fields with documented context / input semantics. max_tokens is an OUTPUT setting. */
function row(raw: Json, kind: ListKind): DiscoveredModel | undefined {
  const id =
    kind === 'gemini'
      ? str(raw.name).replace(/^models\//u, '')
      : kind === 'cohere'
        ? str(raw.name)
        : str(raw.id)
  if (!id || (kind === 'openai' && !isOpenAiChatModel(id)) || (kind === 'tokenhub' && raw.status === 'offline')) {
    return
  }
  if (
    kind === 'sensenova' &&
    Array.isArray(raw.permission) &&
    raw.permission.length &&
    raw.permission.every((p) => asRecord(p).allow_chat === false)
  ) {
    return
  }
  const contextWindow = [
    raw.context_window,
    raw.context_length,
    raw.max_context_length,
    raw.max_model_len,
    raw.max_context_window,
    raw.context_size,
    raw.max_context_window_tokens,
    asRecord(raw.limit).context,
    asRecord(raw.metadata).context_length,
    asRecord(raw.groq).context_window,
    asRecord(raw.top_provider).context_length,
    asRecord(raw.meta).context_length,
  ]
    .map(tokens)
    .find(Boolean)
  const input = kind === 'gemini' ? tokens(raw.inputTokenLimit) : tokens(raw.max_input_tokens)
  let reasoning: DiscoveredModel['reasoning'] = kind === 'anthropic' ? observeClaudeModel(id, raw) : undefined
  if (kind === 'openrouter') {
    const metadata = asRecord(raw.reasoning)
    if (metadata.mandatory === true) {
      reasoning = 'fixed'
    } else if (metadata.mandatory === false) {
      reasoning = 'toggle'
    } else if (
      Array.isArray(raw.supported_parameters) &&
      !raw.supported_parameters.includes('reasoning')
    ) {
      reasoning = 'none'
    }
  } else if (kind === 'opencode') {
    const metadata = asRecord(asRecord(raw.capabilities).reasoning)
    if (metadata.supported === false) {
      reasoning = 'none'
    } else if (metadata.toggle === true) {
      reasoning = 'toggle'
    } else if (metadata.toggle === false) {
      reasoning = 'fixed'
    }
  } else if (kind === 'deepseek') {
    const levels = asRecord(raw.effort).supported_levels
    if (Array.isArray(levels)) {
      reasoning = levels.length ? 'toggle' : 'none'
    }
  }
  return {
    id,
    name: str(raw.display_name) || str(raw.displayName) || str(raw.name) || id,
    contextWindow: contextWindow ?? input,
    source: !contextWindow && input ? 'input' : 'endpoint',
    ...(reasoning && { reasoning }),
  }
}

async function listCloud(
  profile: DiscoveryProfile,
  base: URL,
  kind: ListKind,
  signal: AbortSignal
) {
  const path = base.pathname.replace(/\/+$/u, '')
  const routes: Partial<Record<ListKind, string>> = {
    anthropic: '/v1/models',
    gemini: '/v1beta/models',
    cohere: '/v1/models',
    sensenova: '/v1/llm/models',
    opencode: path.replace('/openai/v1', '/v1/models'),
    openrouter: `${path}/models${profile.apiKey ? '/user' : ''}`,
  }
  const url = withPath(base, routes[kind] ?? `${path}/models`)
  if (kind === 'gemini') {
    url.searchParams.set('pageSize', '1000')
  }
  if (kind === 'cohere') {
    url.searchParams.set('page_size', '1000')
  }
  if (kind === 'anthropic') {
    url.searchParams.set('limit', '1000')
  }
  if (kind === 'openrouter') {
    url.searchParams.set('output_modalities', 'all')
  }
  const cursorParam =
    kind === 'gemini' ? 'pageToken' : kind === 'cohere' ? 'page_token' : 'after_id'
  const rows = new Map<string, DiscoveredModel>(),
    seen = new Set<string>()
  for (let page = 0; page < 100; page++) {
    const body = await getJson(
      profile,
      url,
      kind === 'gemini' || kind === 'anthropic' ? kind : 'bearer',
      signal
    )
    for (const item of array(body, kind === 'gemini' || kind === 'cohere' ? 'models' : 'data')) {
      const model = row(item, kind)
      if (model) {
        rows.set(model.id, model)
      }
    }
    const next =
      kind === 'gemini'
        ? body.nextPageToken
        : kind === 'cohere'
          ? body.next_page_token
          : kind === 'anthropic' && body.has_more
            ? body.last_id
            : undefined
    if (!next) {
      if (kind === 'anthropic' && body.has_more === true) throw new Error('pagination')
      return [...rows.values()]
    }
    const cursor = str(next)
    if (!cursor || seen.has(cursor)) {
      throw new Error('pagination')
    }
    seen.add(cursor)
    url.searchParams.set(cursorParam, cursor)
  }
  throw new Error('pagination')
}

async function localModels(
  profile: DiscoveryProfile,
  base: URL,
  kind: 'lmstudio' | 'ollama',
  signal: AbortSignal
) {
  const req = (path: string) =>
    getJson(profile, withPath(base, localRoot(base) + path), 'bearer', signal)
  const rows = new Map<string, DiscoveredModel>()
  if (kind === 'lmstudio') {
    let models: Json[]
    try {
      models = array(await req('/api/v1/models'), 'models')
    } catch (e) {
      if (!(e instanceof DiscoveryHttpError) || ![404, 405].includes(e.status)) {
        throw e
      }
      models = array(await req('/api/v0/models'), 'data')
    }
    for (const m of models) {
      const id = str(m.key) || str(m.id),
        name = str(m.display_name) || id
      const loaded = tokens(m.loaded_context_length)
      if (id) {
        rows.set(id, {
          id,
          name,
          contextWindow: loaded ?? tokens(m.max_context_length),
          source: loaded ? 'instance' : 'model',
        })
      }
      for (const item of Array.isArray(m.loaded_instances) ? m.loaded_instances : []) {
        const instance = asRecord(item),
          identifier = str(instance.id)
        if (identifier) {
          rows.set(identifier, {
            id: identifier,
            name,
            contextWindow: tokens(asRecord(instance.config).context_length),
            source: 'instance',
          })
        }
      }
    }
  } else {
    const tags = await req('/api/tags')
    for (const m of array(tags, 'models')) {
      const id = str(m.model) || str(m.name)
      if (id) {
        rows.set(id, { id, name: id, source: 'model' })
      }
    }
    // ps may be unavailable on older/read-only installations. tags are still selectable.
    const active = await req('/api/ps').catch(() => null)
    checkAbort(signal)
    if (active) {
      for (const m of array(active, 'models')) {
        const id = str(m.model) || str(m.name)
        if (id) {
          rows.set(id, {
            id,
            name: id,
            source: 'instance',
            contextWindow: tokens(m.context_length),
          })
        }
      }
    }
  }
  return [...rows.values()]
}

export async function discoverModels(
  profile: DiscoveryProfile,
  signal: AbortSignal
): Promise<DiscoveredModel[]> {
  const base = modelEndpoint(profile.endpoint),
    kind = kindFor(profile, base)
  if (kind === 'lmstudio' || kind === 'ollama') {
    try {
      return await localModels(profile, base, kind, signal)
    } catch (e) {
      if (!(e instanceof DiscoveryHttpError) || ![404, 405].includes(e.status)) {
        throw e
      }
    }
  }
  return listCloud(profile, base, kind, signal)
}

/** Only inspect an Ollama model explicitly selected from the connected instance. Never load it. */
export async function inspectOllama(
  profile: DiscoveryProfile,
  model: DiscoveredModel,
  signal: AbortSignal
) {
  if (profile.providerId !== 'ollama' || model.inspected || !str(model.id)) {
    return model
  }
  const base = modelEndpoint(profile.endpoint)
  const body = await getJson(
    profile,
    withPath(base, localRoot(base) + '/api/show'),
    'bearer',
    signal,
    model.id
  )
  const info = asRecord(body.model_info),
    arch = str(info['general.architecture'])
  const configured =
    typeof body.parameters === 'string' && /^\s*num_ctx\s+(\d+)\s*$/mu.exec(body.parameters)
  const configuration = tokens(configured ? Number(configured[1]) : undefined)
  const contextWindow = configuration ?? tokens(info[`${arch}.context_length`])
  const source = configuration ? ('endpoint' as const) : ('model' as const)
  const values = asRecord(body.thinking).values
  let reasoning: DiscoveredModel['reasoning']
  if (Array.isArray(values) && values.length) {
    const off = values.includes(false) || values.includes('none')
    // The OpenAI adapter accepts a small fixed vocabulary (high/none here). A named-only
    // model with a minimum effort is not a toggle, even when it advertises thinking.
    const on = values.includes(true) || values.includes('high')
    reasoning =
      off && on ? 'toggle' : values.every((v) => v === false || v === 'none') ? 'none' : 'fixed'
  } else if (Array.isArray(body.capabilities) && !body.capabilities.includes('thinking')) {
    reasoning = 'none'
  }
  return {
    ...model,
    ...(model.contextWindow ? {} : { contextWindow, source }),
    inspected: true,
    ...(reasoning && { reasoning }),
  }
}
