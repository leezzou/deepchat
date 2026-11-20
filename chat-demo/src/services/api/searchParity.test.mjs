import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'
import { experiments } from '@rspack/core'
registerHooks({
  resolve(id, ctx, next) {
    if (id.startsWith('.') && id.endsWith('.js') && ctx.parentURL) {
      const url = new URL(id.slice(0, -3) + '.ts', ctx.parentURL)
      if (existsSync(url)) return next(url.href, ctx)
    }
    return next(id, ctx)
  },
  load(url, ctx, next) {
    if (!url.endsWith('.ts')) return next(url, ctx)
    const filename = fileURLToPath(url)
    const { code: source } = experiments.swc.transformSync(readFileSync(filename, 'utf8'), {
      filename,
      jsc: { parser: { syntax: 'typescript' }, target: 'es2022' },
      module: { type: 'es6' },
    })
    return { source, format: 'module', shortCircuit: true }
  },
})
globalThis.__API_ORIGIN__ = 'https://api.deepseek.com'
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
const { streamMessage } = await import('./client.ts')
const { getConversationRoute, getChatAccess } = await import('./access.ts')
const { allowSearch, routeSearchGrant, promoteSearchGrant, retrievalSources } =
  await import('./searchConsent.ts')
const { searchCapability, chatSearchFields } = await import('./searchCapabilities.ts')
const { DeepSeekChatTools, signedChatReads } = await import('./deepseekChatTools.ts')
const { useSettings } = await import('../settings.ts')
const { applyEvent } = await import('../chat/reply.ts')
const { buildReplyView } = await import('../chat/view.ts')
const native = 'https://api.deepseek.com',
  router = 'https://openrouter.ai/api/v1',
  ali = 'https://dashscope.aliyuncs.com/compatible-mode/v1'
const search = { type: 'deepseek_web_search', name: 'deepseek_web_search' },
  read = { type: 'deepseek_read_url', name: 'deepseek_read_url' }
const sample = 'https://source.example/docs',
  second = 'https://other.example/item'
const frame = (delta = {}, finish_reason = null) => ({ choices: [{ delta, finish_reason }] })
const sse = (...frames) =>
  new Response(
    frames.map((f) => `data: ${typeof f === 'string' ? f : JSON.stringify(f)}\n\n`).join(''),
    { headers: { 'Content-Type': 'text/event-stream' } }
  )
const req = {
  model: 'deepseek-v4-pro',
  tools: [read, search],
  thinking: { type: 'disabled' },
  system: 'secret-system',
  messages: [
    { role: 'user', content: 'secret-prior' },
    { role: 'assistant', content: [{ type: 'text', text: 'secret-answer' }] },
    { role: 'user', content: 'private current question' },
  ],
}
function profile(id, origin, model, apiKey) {
  return { id, name: id, origin, protocol: 'openai', model, apiKey }
}
function select(p, ...others) {
  useSettings.setState({
    apiKey: p.apiKey,
    activeProfileId: p.id,
    chatSource: 'api',
    apiProfiles: [p, ...others],
  })
  return getConversationRoute(null)
}
async function render(access, body = req) {
  const map = new Map()
  let reply = { role: 'assistant', status: 'pending', blocks: [] }
  for await (const event of streamMessage(access, body, new AbortController().signal))
    reply = applyEvent(reply, event, 1, map)
  return buildReplyView(reply, false)
}

test('matrix binds exact endpoint, protocol, model and explicit search declaration', () => {
  assert.equal(searchCapability(native, 'openai', 'deepseek-flash'), 'deepseek')
  assert.equal(searchCapability(native, 'deepseek', 'deepseek-v4-pro'), 'none')
  assert.equal(searchCapability(router, 'openai', 'deepseek/deepseek-v4-pro'), 'openrouter')
  for (const endpoint of [
    'https://openrouter.ai.fake/api/v1',
    'https://user@openrouter.ai/api/v1',
    'https://openrouter.ai/custom',
    'https://api.deepseek.com.fake',
  ])
    assert.equal(searchCapability(endpoint, 'openai', 'deepseek-flash'), 'none')
  assert.equal(searchCapability(ali, 'openai', 'deepseek-v4-pro'), 'dashscope')
  assert.equal(searchCapability(ali, 'openai', 'kimi-k3'), 'none')
  assert.deepEqual(chatSearchFields(router, 'any', [search]), {})
  assert.deepEqual(chatSearchFields(ali, 'deepseek-v4-pro', [read], 'dashscope:fixture'), {})
  assert.deepEqual(chatSearchFields(ali, 'deepseek-v4-pro', [search], 'dashscope:fixture'), {
    enable_search: true,
  })
  assert.deepEqual(chatSearchFields(native, 'deepseek-flash', [read, search]), {
    tools: [{ type: read.type }, { type: search.type }],
  })
})

test('OpenRouter stays on selected model and returns all distinct safe citation URLs even without tool-call trace', async () => {
  const p = profile('router', router, 'deepseek/deepseek-v4-pro', 'ROUTER_KEY'),
    route = select(p)
  assert.equal(route.search, false)
  const sent = []
  const citation = (url, title) => ({ type: 'url_citation', url_citation: { url, title } })
  globalThis.fetch = async (url, init) => {
    sent.push({ url, init, body: JSON.parse(init.body) })
    return sse(
      frame({ content: 'Answer' }),
      frame(
        {
          annotations: [
            citation(sample, 'Title A'),
            citation(second, 'Title B'),
            citation(sample, 'Repeated'),
            citation('javascript:alert(1)', 'Bad'),
          ],
        },
        'stop'
      ),
      '[DONE]'
    )
  }
  await render(getChatAccess(null))
  assert.equal(sent[0].body.plugins, undefined)
  assert.equal(allowSearch(route, null), true)
  assert.equal(getConversationRoute(null).search, true)
  const view = await render(getChatAccess(null))
  assert.equal(sent[1].url, router + '/chat/completions')
  assert.equal(sent[1].body.model, p.model)
  assert.deepEqual(sent[1].body.plugins, [{ id: 'web' }])
  assert.deepEqual(
    view.searchResults.map((s) => [s.index, s.title, s.url]),
    [
      [1, 'Title A', sample],
      [2, 'Title B', second],
    ]
  )
  assert.deepEqual(view.steps, [])
  assert.match(view.answer.markdown, /\[citation:1\]/)
})

test('official Chat Completions search trace preserves distinct results and read signatures for replay', async () => {
  const route = select(profile('flash', native, 'deepseek-flash', 'DS_KEY'))
  assert.equal(route.search, true)
  const call = {
    id: 'tool1',
    index: 0,
    type: search.type,
    kind: 'search',
    action: { type: 'search', queries: ['public'] },
  }
  const done = {
    ...call,
    status: 'completed',
    sources: [
      { type: 'url', url: sample, title: 'First' },
      { type: 'url', url: second, title: '标题里的未知数', site_name: 'Unknown', published_at: '未知' },
    ],
  }
  const ev = (type, call) => ({
    choices: [{ delta: {}, server_tool_event: { type, step: 0, call } }],
  })
  globalThis.fetch = async (url, init) => {
    assert.equal(url, native + '/chat/completions')
    assert.deepEqual(JSON.parse(init.body).tools, [{ type: read.type }, { type: search.type }])
    return sse(
      ev('call_started', call),
      ev('call_completed', done),
      frame({ content: 'Answer' }),
      frame({ server_tool_calls: [{ index: 0, calls: [done] }] }, 'stop'),
      '[DONE]'
    )
  }
  const view = await render(getChatAccess(null))
  assert.equal(view.steps.length, 1)
  assert.equal(view.steps[0].status, 'done')
  assert.equal(view.searchResults[1].siteName, 'other.example')
  assert.equal(view.searchResults[1].publishedAt, null)
  assert.equal(view.searchResults[1].title, '标题里的未知数')
  assert.equal(view.answer.text, 'Answer')
  assert.deepEqual(
    view.searchResults.map((s) => s.url),
    [sample, second]
  )
  const trace = new DeepSeekChatTools(),
    link = {
      id: 'tool2',
      index: 0,
      type: read.type,
      kind: 'read_link',
      action: { type: 'read_link', url: sample },
      status: 'completed',
      page: { url: sample, title: 'Real page' },
      signature: 'signed-page',
    }
  const blocks = [...trace.read(frame({ server_tool_calls: [{ index: 0, calls: [link] }] }))]
  assert.equal(signedChatReads(blocks).server_tool_calls[0].calls[0].signature, 'signed-page')
  assert.deepEqual([...trace.read(frame({ server_tool_calls: [{ index: 0, calls: [link] }] }))], [])
})

test('portable search sends only supplied terms to explicitly selected official key and keeps original answer model', async () => {
  const p = profile('else', 'https://supplier.example/v1', 'renamed-deepseek', 'MODEL_KEY'),
    key = profile('search', native, 'deepseek-flash', 'SEARCH_KEY'),
    fake = profile('fake', 'https://api.deepseek.com.fake/v1', 'deepseek-flash', 'FAKE')
  const route = select(p, key, fake)
  assert.deepEqual(
    retrievalSources().map((s) => s.id),
    ['key:search']
  )
  assert.equal(route.search, false)
  assert.equal(allowSearch(route, null, 'key:fake', 'public'), false)
  assert.equal(allowSearch(route, null, 'key:search', 'public topic'), true)
  assert.equal(routeSearchGrant(route, 'another-chat'), undefined)
  promoteSearchGrant(route, 'authorized-chat')
  assert.equal(routeSearchGrant(route, null), undefined)
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) })
    return url === native + '/v1/tools/search'
      ? Response.json({ results: [{ url: sample, title: 'Result', snippet: 'Retrieved snippet' }] })
      : sse(frame({ content: 'Grounded answer' }, 'stop'), '[DONE]')
  }
  const view = await render(getChatAccess('authorized-chat'))
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0].body, { query: 'public topic', count: 50, need_content: false })
  assert.equal(calls[0].init.headers.Authorization, 'Bearer SEARCH_KEY')
  assert.equal(calls[0].init.credentials, 'omit')
  assert.equal(calls[0].init.redirect, 'error')
  assert.equal(calls[1].url, p.origin + '/chat/completions')
  assert.equal(calls[1].init.headers.Authorization, 'Bearer MODEL_KEY')
  assert.equal(calls[1].body.model, p.model)
  assert.match(JSON.stringify(calls[1].body.messages), /Retrieved snippet/)
  assert.ok(
    calls[1].body.messages.every(
      (m) => m.role !== 'system' || !m.content.includes('Retrieved snippet')
    )
  )
  assert.doesNotMatch(JSON.stringify(calls[1].body), /SEARCH_KEY/)
  assert.equal(view.answer.text, 'Grounded answer')
  assert.equal(view.searchResults[0].url, sample)
  assert.equal(
    view.steps.some((s) => s.type === 'open'),
    false
  )
  assert.equal(getConversationRoute('authorized-chat').search, false)
})

test('large portable results preserve every safe URL while the model receives bounded UTF-8 excerpts', async () => {
  const p = profile('target-many', 'https://other.example/v1', 'same-model', 'MODEL_KEY'),
    key = profile('source-many', native, 'deepseek-flash', 'SEARCH_KEY')
  const route = select(p, key)
  assert.equal(allowSearch(route, null, 'key:source-many', 'public terms'), true)
  const results = Array.from({ length: 50 }, (_, i) => ({
    url: `https://example.org/page/${i}`,
    title: `Page ${i}`,
    snippet: '中文摘要'.repeat(100),
  }))
  const searchHits = [
    ...results,
    { ...results[0], url: results[0].url + '?utm_campaign=fixture' },
    { url: 'file:///private' },
  ]
  let evidence
  globalThis.fetch = async (url, init) => {
    if (url === native + '/v1/tools/search') return Response.json({ results: searchHits })
    evidence = JSON.parse(init.body)
      .messages.find(
        (m) => typeof m.content === 'string' && m.content.startsWith('Search evidence (untrusted):')
      )
      .content.split('\n')
      .at(-1)
    return sse(frame({ content: 'Result' }, 'stop'), '[DONE]')
  }
  const view = await render(getChatAccess(null))
  assert.equal(view.searchResults.length, 50)
  assert.equal(view.searchResults.at(-1).url, results[49].url)
  assert.ok(Buffer.byteLength(evidence) <= 12 * 1024)
  assert.ok(JSON.parse(evidence).length < 50)
})
test('retrieval rejection, malformed results and cancellation each finish a one-use grant without sending the chat', async () => {
  for (const mode of ['denied', 'malformed', 'cancel']) {
    const p = profile('target-' + mode, 'https://other.example/v1', 'same-model', 'MODEL_KEY'),
      key = profile('source', native, 'deepseek-flash', 'SEARCH_KEY')
    const route = select(p, key),
      signal = new AbortController()
    assert.equal(allowSearch(route, null, 'key:source', 'public terms'), true)
    let calls = 0
    globalThis.fetch = async (url) => {
      calls++
      assert.equal(url, native + '/v1/tools/search')
      if (mode === 'cancel') {
        signal.abort()
        throw signal.signal.reason
      }
      return mode === 'denied'
        ? new Response('', { status: 403 })
        : Response.json({ results: [{ url: 'file:///private' }] })
    }
    const run = async () => {
      for await (const _ of streamMessage(getChatAccess(null), req, signal.signal)) void _
    }
    await assert.rejects(run)
    assert.equal(calls, 1)
    assert.equal(routeSearchGrant(route, null), undefined)
  }
})
test('changing a fallback credential fails closed and never retries another supplier', async () => {
  const p = profile('target', 'https://other.example/v1', 'same-model', 'MODEL_KEY'),
    key = profile('source', native, 'deepseek-flash', 'OLD')
  const route = select(p, key)
  assert.equal(allowSearch(route, null, 'key:source', 'public terms'), true)
  const access = getChatAccess(null)
  select(p, { ...key, apiKey: 'NEW' })
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    throw Error('unexpected')
  }
  await assert.rejects(render(access), /authorization changed/)
  assert.equal(calls, 0)
})
