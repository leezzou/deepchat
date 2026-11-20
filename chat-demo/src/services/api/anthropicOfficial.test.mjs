import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'
import { experiments } from '@rspack/core'

registerHooks({
  resolve(id, ctx, next) {
    const ts =
      id.startsWith('.') &&
      id.endsWith('.js') &&
      ctx.parentURL &&
      new URL(id.slice(0, -3) + '.ts', ctx.parentURL)
    return next(ts && existsSync(ts) ? ts.href : id, ctx)
  },
  load(url, ctx, next) {
    if (!url.endsWith('.ts')) {
      return next(url, ctx)
    }
    const filename = fileURLToPath(url)
    const { code } = experiments.swc.transformSync(readFileSync(filename, 'utf8'), {
      filename,
      jsc: { parser: { syntax: 'typescript' }, target: 'es2022' },
      module: { type: 'es6' },
    })
    return { source: code, format: 'module', shortCircuit: true }
  },
})
globalThis.__API_ORIGIN__ = 'https://api.deepseek.com'
globalThis.localStorage = { getItem: () => null }
const { streamMessage, uploadFile, deleteFile, verifyApiKey } = await import('./client.ts')
const { useSettings } = await import('../settings.ts')
const { getChatAccess, getConversationRoute } = await import('./access.ts')
const { applyEvent } = await import('../chat/reply.ts')
const { refineTopic } = await import('../chat/titles.ts')
const { usageMetrics } = await import('../usage/totals.ts')
const { providerPresets } = await import('./providerPresets.ts')
const { allowSearch } = await import('./searchConsent.ts')
const { discoverModels } = await import('./modelDiscovery.ts')
const { decodeLegacy } = await import('../security/profiles.ts')
const { claudeRequest } = await import('./anthropicOfficial.ts')
const base = 'https://api.anthropic.com/v1'
const preset = providerPresets.find((p) => p.value === 'anthropic')
const profile = { ...preset, id: 'p-claude', providerId: 'anthropic', apiKey: 'fixture-key' }
const signal = () => new AbortController().signal
const request = (on = true) => ({
  model: 'ignored-override',
  system: 'Use the selected language.',
  messages: [{ role: 'user', content: 'Hello' }],
  tools: [],
  thinking: { type: on ? 'enabled' : 'disabled' },
  safety_check: { level: 'high' },
  title: { enabled: true },
})
const start = (index, content_block) => ({ type: 'content_block_start', index, content_block })
const delta = (index, delta) => ({ type: 'content_block_delta', index, delta })
const stop = (index) => ({ type: 'content_block_stop', index })
const end = (reason = 'end_turn', usage = { output_tokens: 12 }) => [
  { type: 'message_delta', delta: { stop_reason: reason, stop_sequence: null }, usage },
  { type: 'message_stop' },
]
const frames = (...items) =>
  new Response(
    items.map((e) => `event: ${e.type}\r\ndata: ${JSON.stringify(e)}\r\n\r\n`).join(''),
    { headers: { 'Content-Type': 'text/event-stream' } }
  )
const select = (extra = {}) => {
  const p = { ...profile, ...extra }
  useSettings.setState({ chatSource: 'api', apiProfiles: [p], activeProfileId: p.id })
  return getChatAccess()
}
async function collect(body, ac = getChatAccess(), sig = signal()) {
  let answer = { status: 'streaming', blocks: [] }
  const index = new Map()
  for await (const e of streamMessage(ac, body, sig)) {
    answer = applyEvent(answer, e, 0, index)
  }
  return answer
}
function auth(url, init) {
  assert.ok(url.startsWith(base + '/'))
  assert.equal(init.credentials, 'omit')
  assert.equal(init.redirect, 'error')
  assert.equal(init.headers['x-api-key'], profile.apiKey)
  assert.equal(init.headers['anthropic-version'], '2026-10-21')
  assert.equal(init.headers['anthropic-dangerous-direct-browser-access'], 'true')
  assert.equal(init.headers.Authorization, undefined)
}

test('official preset and equivalent saved profiles preserve exact model, native Messages and provider summaries', async (t) => {
  assert.equal(preset.protocol, 'anthropic')
  assert.equal(decodeLegacy(JSON.stringify([profile]), null)[0].protocol, 'anthropic')
  const model = 'claude-sonnet-4-5-20250929'
  const sent = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    auth(url, init)
    assert.equal(url, base + '/messages')
    sent.push(JSON.parse(init.body))
    return frames(
      {
        type: 'message_start',
        message: {
          id: 'msg_fixture',
          model,
          usage: {
            input_tokens: 11,
            cache_read_input_tokens: 7,
            cache_creation_input_tokens: 5,
            output_tokens: 1,
          },
        },
      },
      start(0, { type: 'redacted_thinking', data: 'secret-opaque' }),
      stop(0),
      start(1, { type: 'thinking', thinking: '' }),
      delta(1, { type: 'thinking_delta', thinking: 'Provider summary' }),
      delta(1, { type: 'signature_delta', signature: 'private-signature' }),
      stop(1),
      start(2, { type: 'text', text: '' }),
      delta(2, { type: 'text_delta', text: 'Answer' }),
      stop(2),
      ...end()
    )
  })
  for (const protocol of ['anthropic', 'openai']) {
    const ac = select({ protocol, model })
    assert.equal(getConversationRoute().thinking, true)
    let answer = await collect(request(true), ac)
    const body = sent.at(-1)
    assert.equal(body.model, model)
    assert.equal(body.max_tokens, 8192)
    assert.equal(body.system, request().system)
    assert.deepEqual(body.thinking, { type: 'enabled', budget_tokens: 4096, display: 'summarized' })
    for (const key of ['safety_check', 'title', 'tools', 'fallbacks', 'output_config']) {
      assert.equal(body[key], undefined)
    }
    assert.equal(answer.blocks[0].thinking, 'Provider summary')
    assert.equal(answer.blocks[1].text, 'Answer')
    assert.doesNotMatch(JSON.stringify(answer), /secret-opaque|private-signature/)
    assert.deepEqual(answer.usage, {
      input_tokens: 11,
      cache_read_input_tokens: 7,
      cache_creation_input_tokens: 5,
      output_tokens: 12,
    })
    assert.equal(usageMetrics(answer.usage).metrics.input, 23)
    answer = await collect(request(false), ac)
    assert.deepEqual(
      answer.blocks.map((b) => b.type),
      ['text']
    )
  }
})

test('every bundled Claude model is dispatchable through its documented thinking mode', async (t) => {
  const catalog = JSON.parse(readFileSync(new URL('./catalog-data/anthropic.json', import.meta.url), 'utf8'))
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, base + '/messages')
    calls.push(JSON.parse(init.body))
    return frames(...end())
  })
  for (const [model] of catalog.rows) {
    const access = select({ model })
    await collect(request(), access)
    assert.equal(calls.at(-1).model, model)
    assert.equal(calls.at(-1).thinking?.type, model.includes('-4-5') ? 'enabled' : 'adaptive', model)
    assert.equal(calls.at(-1).thinking?.display, 'summarized', model)
  }
})

test('reasoning modes follow official capabilities, optional display and title budget', async (t) => {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    auth(url, init)
    calls.push(JSON.parse(init.body))
    return frames(start(0, { type: 'text', text: 'Walking trails' }), stop(0), ...end())
  })
  for (const [model, off, summaryOnly] of [
    ['claude-sonnet-5-5', 'between_tools', false],
    ['claude-opus-5-5', undefined, true],
    ['claude-sonnet-4-6', 'disabled', false],
  ]) {
    const access = select({ model })
    const route = getConversationRoute()
    assert.equal(route.summaryOnly, summaryOnly)
    assert.equal(route.thinking, true)
    await collect(request(), access)
    assert.deepEqual(calls.at(-1).thinking, { type: 'adaptive', display: 'summarized' })
    assert.equal(
      await refineTopic(access, 'Walking trails around Hangzhou', new AbortController()),
      'Walking trails'
    )
    assert.equal(calls.at(-1).model, model)
    assert.equal(calls.at(-1).max_tokens, 48)
    assert.equal(calls.at(-1).thinking?.type, off)
  }
  const custom = select({ model: 'opaque-future-model' })
  await collect(request(), custom)
  assert.equal(calls.at(-1).model, 'opaque-future-model')
  assert.equal(calls.at(-1).thinking, undefined)
})

test('two pages at root or /v1, local capability metadata and exact future wire IDs', async (t) => {
  const urls = []
  const id = 'future-Sonnet:v2'
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    auth(url, init)
    const u = new URL(url)
    urls.push(u)
    assert.equal(u.pathname, '/v1/models')
    return u.searchParams.has('after_id')
      ? Response.json({
          data: [
            {
              id,
              display_name: 'Future Sonnet',
              max_input_tokens: 120000,
              max_tokens: 3500,
              capabilities: {
                thinking: {
                  supported: true,
                  types: {
                    adaptive: { supported: true },
                    disabled: { supported: false },
                    between_tools: { supported: true },
                  },
                },
                server_tools: { web_search: { supported: false } },
              },
            },
          ],
          has_more: false,
        })
      : Response.json({ data: [{ id: 'a' }], has_more: true, last_id: 'a' })
  })
  const rows = await discoverModels(
    { providerId: 'anthropic', endpoint: 'https://api.anthropic.com/', apiKey: profile.apiKey },
    signal()
  )
  assert.equal(urls[1].searchParams.get('after_id'), 'a')
  assert.deepEqual(
    rows.map((r) => r.id),
    ['a', id]
  )
  assert.equal(rows[1].contextWindow, 120000)
  assert.equal(rows[1].reasoning, 'toggle')
  const body = claudeRequest(request(false), id)
  assert.equal(body.model, id)
  assert.equal(body.max_tokens, 3500)
  assert.deepEqual(body.thinking, { type: 'between_tools' })
  await verifyApiKey(profile.apiKey, base)
  const { selectedClaudeFacts } = await import('./anthropicOfficial.ts')
  const facts = selectedClaudeFacts(base, id)
  const restoredId = 'restored-Sonnet:2'
  const [restored] = decodeLegacy(
    JSON.stringify([
      { ...profile, model: restoredId, claudeModelFacts: { [restoredId]: facts[id] } },
    ]),
    null
  )
  assert.deepEqual(restored.claudeModelFacts[restoredId], facts[id])
  assert.deepEqual(claudeRequest(request(false), restoredId).thinking, { type: 'between_tools' })
})

test('authorized server search translates only public citations and source data', async (t) => {
  select()
  const route = getConversationRoute()
  assert.equal(allowSearch(route, null), true)
  const body = {
    ...request(),
    tools: [{ type: 'deepseek_web_search', name: 'deepseek_web_search' }],
  }
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    auth(url, init)
    assert.deepEqual(JSON.parse(init.body).tools, [
      { type: 'web_search_20250305', name: 'web_search' },
    ])
    return frames(
      start(0, { type: 'server_tool_use', id: 'srvtoolu_fixture', name: 'web_search', input: {} }),
      delta(0, { type: 'input_json_delta', partial_json: '{"query":"search terms"}' }),
      stop(0),
      start(1, {
        type: 'web_search_tool_result',
        tool_use_id: 'srvtoolu_fixture',
        content: [
          {
            type: 'web_search_result',
            title: 'Primary reference',
            url: 'https://example.org/a',
            encrypted_content: 'opaque-provider-token',
          },
        ],
      }),
      stop(1),
      start(2, { type: 'text', text: 'Answer' }),
      delta(2, {
        type: 'citations_delta',
        citation: {
          type: 'web_search_result_location',
          url: 'https://example.org/a',
          title: 'Primary reference',
          cited_text: 'source',
        },
      }),
      stop(2),
      ...end()
    )
  })
  const r = await collect(body)
  assert.equal(r.blocks[0].input.queries[0], 'search terms')
  assert.equal(r.blocks[1].content[0].title, 'Primary reference')
  assert.equal(r.blocks[2].citations[0].url, 'https://example.org/a')
  assert.doesNotMatch(JSON.stringify(r), /opaque-provider-token/)
})

test('native file IDs use upload, Messages references and delete on the same configured API', async (t) => {
  const access = select({ origin: 'https://api.anthropic.com' })
  const id = 'file_abc'
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    auth(url, init)
    calls.push(url)
    assert.equal(init.headers['anthropic-beta'], undefined)
    if (url.endsWith('/files')) {
      assert.deepEqual([...init.body.keys()], ['file'])
      return Response.json({ id, type: 'file' })
    }
    if (init.method === 'DELETE') {
      return new Response(null, { status: 204 })
    }
    assert.deepEqual(JSON.parse(init.body).messages, [
      { role: 'user', content: [{ type: 'document', source: { type: 'file', file_id: id } }] },
    ])
    return frames(...end())
  })
  assert.deepEqual(
    await uploadFile(
      access,
      new File(['pdf'], 'file.pdf', { type: 'application/pdf' }),
      'text_recognition'
    ),
    { id }
  )
  await collect(
    {
      ...request(),
      messages: [
        { role: 'user', content: [{ type: 'document', source: { type: 'file', file_id: id } }] },
      ],
    },
    access
  )
  await deleteFile(access, id)
  assert.deepEqual(calls, [base + '/files', base + '/messages', base + '/files/' + id])
})

test('network, refusal, truncation, interrupted streams and cancellation never switch models', async (t) => {
  const access = select()
  const abort = new AbortController()
  const opened = Promise.withResolvers()
  let cancelled = false
  const responses = [
    Response.json(
      { type: 'error', error: { type: 'authentication_error', message: 'invalid key' } },
      { status: 401 }
    ),
    frames({ type: 'error', error: { message: 'overloaded' } }),
    frames(start(0, { type: 'text', text: 'partial' })),
    frames(...end('refusal')),
    frames(...end('model_context_window_exceeded')),
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } }
    ),
  ]
  const fn = t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, base + '/messages')
    assert.equal(JSON.parse(init.body).model, profile.model)
    if (responses.length === 1) {
      opened.resolve()
    }
    return responses.shift()
  })
  await assert.rejects(
    collect(request(), access),
    (e) => e.status === 401 && e.message === 'invalid key'
  )
  await assert.rejects(
    collect(request(), access),
    (e) => e.kind === 'stream' && e.message === 'overloaded'
  )
  await assert.rejects(collect(request(), access), (e) => e.kind === 'interrupted')
  for (const reason of ['refusal', 'max_tokens']) {
    assert.equal((await collect(request(), access)).stopReason, reason)
  }
  const active = collect(request(), access, abort.signal)
  await opened.promise
  abort.abort()
  await assert.rejects(active, (e) => e.name === 'AbortError')
  assert.equal(cancelled, true)
  assert.equal(fn.mock.callCount(), 6)
})
