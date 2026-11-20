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
      if (existsSync(url)) {
        return next(url.href, ctx)
      }
    }
    return next(id, ctx)
  },
  load(url, ctx, next) {
    if (!url.endsWith('.ts')) {
      return next(url, ctx)
    }
    const filename = fileURLToPath(url)
    const { code: source } = experiments.swc.transformSync(readFileSync(filename, 'utf8'), {
      filename,
      jsc: { parser: { syntax: 'typescript' }, target: 'es2022' },
      module: { type: 'es6' },
    })
    return { source, format: 'module', shortCircuit: true }
  },
})
globalThis.localStorage = { getItem: () => null }
globalThis.__API_ORIGIN__ = 'https://api.deepseek.com'
const { streamMessage } = await import('./client.ts')
const { getChatAccess, getConversationRoute } = await import('./access.ts')
const { useSettings } = await import('../settings.ts')
const { discoverModels } = await import('./modelDiscovery.ts')
const { profileWindowKey } = await import('./contextOverrides.ts')
const { decodeLegacy } = await import('../security/profiles.ts')
const { isDeepSeekApiOrigin } = await import('./providerParity.ts')
const { applyEvent } = await import('../chat/reply.ts')
const ds = 'https://api.deepseek.com/v1',
  router = 'https://openrouter.ai/api/v1',
  ollama = 'http://localhost:11434/v1'
const original = useSettings.getState()
function select(origin, model, extra = {}) {
  const profile = {
    id: 'parity',
    name: 'P',
    origin,
    model,
    apiKey: 'fixture',
    protocol: 'openai',
    ...extra,
  }
  useSettings.setState({ apiProfiles: [profile], activeProfileId: profile.id, chatSource: 'api' })
  return getChatAccess()
}
const req = (on) => ({
  messages: [{ role: 'user', content: 'Hi' }],
  tools: [],
  thinking: { type: on ? 'enabled' : 'disabled' },
  max_tokens: 80,
})
const sse = (frames) =>
  new Response(
    frames.map((f) => `data: ${typeof f === 'string' ? f : JSON.stringify(f)}\r\n\r\n`).join(''),
    { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } }
  )
const frame = (delta = {}, finish_reason = null) => ({ choices: [{ delta, finish_reason }] })
async function* events(access, on = true, signal = new AbortController().signal) {
  yield* streamMessage(access, req(on), signal)
}
async function reply(it) {
  let state = { status: 'streaming', blocks: [] }
  const indices = new Map()
  for await (const event of it) {
    state = applyEvent(state, event, 0, indices)
  }
  return state
}
test('every saved preset sends a real protocol request through the shared chat entry point', async (t) => {
  const { providerPresets } = await import('./providerPresets.ts')
  t.after(() => useSettings.setState(original))
  for (const p of providerPresets) {
    const origin = p.origin || 'https://example.test/v1'
    const model = p.model || (p.protocol === 'deepseek' ? 'deepseek-flash' : 'custom-model')
    const access = select(origin, model, { providerId: p.value, protocol: p.protocol })
    let calls = 0
    const fetch = t.mock.method(globalThis, 'fetch', async (url, init) => {
      calls++
      const body = JSON.parse(init.body),
        headers = new Headers(init.headers)
      assert.equal(body.model, model, p.value)
      assert.equal(init.method, 'POST')
      if (p.value === 'anthropic' || p.value === 'deepseek') {
        assert.equal(
          url,
          origin + (p.value === 'anthropic' ? '/messages' : '/anthropic/v1/messages')
        )
        assert.equal(headers.get('x-api-key'), 'fixture')
        return sse([
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: 'answer' },
          },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
          { type: 'message_stop' },
        ])
      }
      assert.equal(url, origin + '/chat/completions')
      assert.equal(headers.get('Authorization'), 'Bearer fixture')
      assert.equal(body.stream, true)
      assert.deepEqual(body.stream_options, { include_usage: true }, p.value)
      assert.equal(
        headers.has('x-opencode-session'),
        ['opencode', 'opencode-go'].includes(p.value),
        p.value
      )
      assert.deepEqual(body.messages, [{ role: 'user', content: 'Hi' }])
      assert.equal(body[p.value === 'openai' ? 'max_completion_tokens' : 'max_tokens'], 80)
      return sse([frame({ content: 'answer' }, 'stop'), '[DONE]'])
    })
    try {
      const stream = streamMessage(access, { ...req(false), model }, new AbortController().signal)
      assert.equal((await reply(stream)).blocks[0].text, 'answer', p.value)
      assert.equal(calls, 1, p.value)
    } finally {
      fetch.mock.restore()
    }
  }
})

test('official GPT chooses only supported Chat Completions effort, budget and usage fields', async (t) => {
  t.after(() => useSettings.setState(original))
  const origin = 'https://api.openai.com/v1'
  for (const [id, toggle] of [
    ['gpt-4.1', false],
    ['gpt-5-mini', false],
    ['o3', false],
    ['gpt-6.2-astra', false],
    ['gpt-5.4-mini-2026-03-17', true],
    ['gpt-5.5', true],
    ['gpt-6.1-terra', true],
  ]) {
    const access = select(origin, id)
    assert.equal(getConversationRoute().thinking, toggle)
    for (const enabled of [true, false]) {
      const fetch = t.mock.method(globalThis, 'fetch', async (url, init) => {
        assert.equal(url, origin + '/chat/completions')
        const body = JSON.parse(init.body)
        assert.equal(body.max_tokens, undefined)
        assert.equal(body.messages[0].role, id === 'gpt-4.1' ? 'system' : 'developer')
        assert.equal(body.max_completion_tokens, 80)
        assert.deepEqual(body.stream_options, { include_usage: true })
        assert.equal(body.reasoning_effort, toggle ? (enabled ? 'medium' : 'none') : undefined)
        return sse([
          frame({ content: 'answer', reasoning_content: 'private' }, 'stop'),
          { choices: [], usage: { completion_tokens: 0 } },
          '[DONE]',
        ])
      })
      const result = await reply(
        streamMessage(
          access,
          { ...req(enabled), system: 'Follow project instructions' },
          new AbortController().signal
        )
      )
      assert.deepEqual(
        result.blocks.map((b) => b.text),
        ['answer']
      )
      assert.deepEqual(result.usage, { output_tokens_total: 0, output_tokens: 0 })
      fetch.mock.restore()
    }
  }
})

test('official Responses handles JSON Pro and streaming Codex, summarizes only public output, reconciles final snapshots', async (t) => {
  t.after(() => useSettings.setState(original))
  const origin = 'https://api.openai.com/v1'
  for (const [id, stream] of [
    ['gpt-5.5-pro', false],
    ['o3-pro-2025-06-10', false],
    ['gpt-5.3-codex', true],
  ]) {
    const access = select(origin, id)
    assert.equal(getConversationRoute().summaryOnly, true)
    for (const enabled of [true, false]) {
      const fetch = t.mock.method(globalThis, 'fetch', async (url, init) => {
        assert.equal(url, origin + '/responses')
        const body = JSON.parse(init.body)
        assert.equal(body.stream, stream)
        assert.equal(body.store, false)
        assert.equal(body.max_output_tokens, 80)
        assert.equal(body.max_tokens, undefined)
        assert.equal(body.stream_options, undefined)
        assert.deepEqual(body.input, [{ role: 'user', content: 'Hi' }])
        assert.deepEqual(body.reasoning, enabled ? { summary: 'auto' } : undefined)
        const r = {
          status: 'completed',
          output: [
            {
              type: 'reasoning',
              content: [{ type: 'reasoning_text', text: 'private' }],
              encrypted_content: 'PRIVATE',
              summary: [{ type: 'summary_text', text: 'summary' }],
            },
            {
              type: 'message',
              content: [
                {
                  type: 'output_text',
                  text: 'answer',
                  annotations: [
                    { type: 'url_citation', url: 'https://example.test', title: 'Source' },
                  ],
                },
              ],
            },
          ],
          usage: {
            input_tokens: 15,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 7,
            output_tokens_details: { reasoning_tokens: 4 },
          },
        }
        return stream
          ? sse([
              { type: 'response.reasoning_text.delta', delta: 'private' },
              {
                type: 'response.reasoning_summary_text.delta',
                output_index: 0,
                summary_index: 0,
                delta: 'sum',
              },
              {
                type: 'response.output_text.delta',
                output_index: 1,
                content_index: 0,
                delta: 'ans',
              },
              { type: 'response.completed', response: r },
            ])
          : Response.json(r)
      })
      const result = await reply(events(access, enabled))
      assert.equal(result.stopReason, 'end_turn')
      assert.deepEqual(
        result.blocks.map((b) => b.thinking ?? b.text),
        enabled ? ['summary', 'answer'] : ['answer']
      )
      assert.equal(result.blocks.at(-1).citations[0].url, 'https://example.test/')
      assert.equal(result.usage.output_tokens, 7)
      assert.equal(result.usage.cache_read_output_tokens, undefined)
      fetch.mock.restore()
    }
  }
})

test('only authorized official GPT search uses Responses web_search; bounded title still uses Chat Completions', async (t) => {
  t.after(() => useSettings.setState(original))
  const origin = 'https://api.openai.com/v1'
  select(origin, 'gpt-5.4')
  const { allowSearch, revokeSearchGrant } = await import('./searchConsent.ts')
  const route = getConversationRoute()
  assert.equal(route.search, false)
  assert.equal(allowSearch(route, null), true)
  t.after(() => revokeSearchGrant(route, null))
  const access = getChatAccess()
  assert.match(access.searchGrant, /^openai:/)
  assert.equal(getConversationRoute().search, true)
  const requests = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const body = JSON.parse(init.body)
    requests.push([url, body])
    return url.endsWith('/responses')
      ? sse([
          {
            type: 'response.completed',
            response: {
              status: 'completed',
              output: [
                {
                  type: 'message',
                  content: [
                    {
                      type: 'output_text',
                      text: 'verified',
                      annotations: [
                        { type: 'url_citation', url: 'https://source.test/', title: 'Source' },
                      ],
                    },
                  ],
                },
              ],
            },
          },
        ])
      : sse([frame({ content: 'title' }, 'stop')])
  })
  const result = await reply(
    streamMessage(
      access,
      { ...req(false), tools: [{ type: 'deepseek_web_search', name: 'deepseek_web_search' }] },
      new AbortController().signal
    )
  )
  assert.equal(result.blocks[0].citations[0].url, 'https://source.test/')
  await reply(events(access, false))
  assert.deepEqual(
    requests.map((r) => r[0]),
    [origin + '/responses', origin + '/chat/completions']
  )
  assert.deepEqual(requests[0][1].tools, [{ type: 'web_search' }])
  assert.deepEqual(requests[0][1].reasoning, { effort: 'none' })
  assert.equal(requests[1][1].tools, undefined)
})

test('Responses terminals distinguish refusal, truncation, failed status and premature EOF', async (t) => {
  t.after(() => useSettings.setState(original))
  const access = select('https://api.openai.com/v1', 'gpt-5.4-pro')
  let rows = []
  t.mock.method(globalThis, 'fetch', async () => sse(rows))
  for (const [status, cause, reason] of [
    ['incomplete', 'max_output_tokens', 'max_tokens'],
    ['incomplete', 'content_filter', 'refusal'],
    ['completed', null, 'refusal'],
  ]) {
    rows = [
      {
        type: 'response.' + status,
        response: {
          status,
          incomplete_details: { reason: cause },
          output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'Sorry' }] }],
        },
      },
    ]
    assert.equal((await reply(events(access))).stopReason, reason)
  }
  rows = [
    { type: 'response.refusal.delta', output_index: 0, content_index: 0, delta: 'I cannot' },
    {
      type: 'response.refusal.done',
      output_index: 0,
      content_index: 0,
      refusal: 'I cannot assist',
    },
  ]
  const partial = []
  await assert.rejects(
    async () => {
      for await (const e of events(access)) {
        if (e.delta?.type === 'text_delta') {
          partial.push(e.delta.text)
        }
      }
    },
    (e) => e.kind === 'interrupted'
  )
  assert.equal(partial.join(''), 'I cannot assist')
  for (const [response, kind] of [
    [
      {
        type: 'response.failed',
        response: { status: 'failed', error: { message: 'provider failure' } },
      },
      'stream',
    ],
    [
      { type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: 'partial' },
      'interrupted',
    ],
    [
      {
        type: 'response.incomplete',
        response: { status: 'incomplete', incomplete_details: { reason: 'other' } },
      },
      'interrupted',
    ],
  ]) {
    rows = [response]
    await assert.rejects(reply(events(access)), (e) => e.kind === kind)
  }
})

test('usage details retain partial server counters and only explicit output cache buckets', async () => {
  const { completionUsage } = await import('./compatibleChunk.ts')
  assert.equal(completionUsage({ total_tokens: 44 }), undefined)
  assert.deepEqual(completionUsage({ prompt_tokens: 25 }), { input_tokens_total: 25 })
  assert.deepEqual(
    completionUsage({
      completion_tokens: 10,
      completion_tokens_details: {
        cached_tokens: 1,
        cache_write_tokens: 2,
        reasoning_tokens: 4,
        accepted_prediction_tokens: 2,
      },
    }),
    {
      output_tokens_total: 10,
      output_tokens: 7,
      cache_read_output_tokens: 1,
      cache_creation_output_tokens: 2,
    }
  )
  assert.deepEqual(
    completionUsage({
      prompt_tokens: 10,
      completion_tokens: 0,
      prompt_tokens_details: { cached_tokens: 99 },
    }),
    { input_tokens_total: 10, output_tokens_total: 0, output_tokens: 0 }
  )
})

test('an interrupted compatible stream reports partial and zero usage immediately', async (t) => {
  t.after(() => useSettings.setState(original))
  const access = select(ds, 'deepseek-flash')
  t.mock.method(globalThis, 'fetch', async () =>
    sse([
      { choices: [], usage: { prompt_tokens: 20, completion_tokens: 0 } },
      {
        choices: [],
        usage: { prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 4 } },
      },
      frame({ content: 'partial' }),
    ])
  )
  const seen = []
  await assert.rejects(
    async () => {
      for await (const e of events(access)) {
        seen.push(e)
      }
    },
    (e) => e.kind === 'interrupted'
  )
  assert.deepEqual(seen.filter((e) => e.type === 'message_usage').at(-1).usage, {
    input_tokens_total: 20,
    input_tokens: 16,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 4,
    output_tokens_total: 0,
    output_tokens: 0,
  })
})

test('real route and HTTP serializer agree on each exact toggle for on and off', async (t) => {
  t.after(() => useSettings.setState(original))
  for (const [origin, id, field, makeValue, extra = {}] of [
    [ds, 'deepseek-v4-pro', 'thinking', (on) => ({ type: on ? 'enabled' : 'disabled' })],
    [router, 'deepseek/deepseek-v4-pro', 'reasoning', (enabled) => ({ enabled })],
    ['https://api.siliconflow.cn/v1', 'deepseek-ai/DeepSeek-V4-Pro', 'enable_thinking', (on) => on],
    [
      'https://opencode.ai/inference/openai/v1',
      'deepseek-v4.1-flash',
      'thinking',
      (on) => ({ type: on ? 'enabled' : 'disabled' }),
    ],
    [
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
      'deepseek-v4-pro',
      'enable_thinking',
      (on) => on,
    ],
    [ollama, 'deepseek-v4-pro:cloud', 'reasoning_effort', (on) => (on ? 'high' : 'none')],
    ['https://private.invalid/v1', 'deepseek-v4-pro', undefined],
    ['https://api.deepseek.com/custom', 'deepseek-v4-pro', undefined],
    ['https://openrouter.ai.attacker.invalid/api/v1', 'deepseek/deepseek-v4-pro', undefined],
    ['https://api.siliconflow.cn/v1', 'deepseek-ai/DeepSeek-R1', undefined],
  ]) {
    const access = select(origin, id, extra)
    assert.equal(getConversationRoute().thinking, true, `${origin} / ${id}`)
    assert.equal(getConversationRoute().reasoningDisplayOnly, !field, `${origin} / ${id}`)
    for (const on of [true, false]) {
      const fetch = t.mock.method(globalThis, 'fetch', async (url, init) => {
        const body = JSON.parse(init.body)
        assert.equal(url, origin + '/chat/completions')
        assert.equal(body.model, id)
        assert.equal(body.max_tokens, 80)
        for (const switchName of ['thinking', 'reasoning', 'reasoning_effort', 'enable_thinking']) {
          assert.deepEqual(body[switchName], switchName === field ? makeValue(on) : undefined)
        }
        return sse([frame({ content: 'answer' }, 'stop'), '[DONE]'])
      })
      assert.equal((await reply(events(access, on))).blocks[0].text, 'answer')
      fetch.mock.restore()
    }
  }
  for (const origin of [ds, ds + '/', 'https://api.deepseek.com']) {
    assert.equal(isDeepSeekApiOrigin(origin), true)
  }
  for (const origin of [
    ds + '/proxy',
    ds + '?url=elsewhere',
    'http://api.deepseek.com',
    'https://api.deepseek.com.evil.invalid',
    'https://user@api.deepseek.com',
  ]) {
    assert.equal(isDeepSeekApiOrigin(origin), false)
  }
})

test('verified model contracts serialize both settings and return only the selected public reasoning', async (t) => {
  t.after(() => useSettings.setState(original))
  const dash = 'https://dashscope.aliyuncs.com/compatible-mode/v1'
  const moon = 'https://api.moonshot.cn/v1'
  const google = 'https://generativelanguage.googleapis.com/v1beta/openai'
  const fields = [
    'thinking',
    'enable_thinking',
    'reasoning',
    'reasoning_effort',
    'reasoning_format',
    'reasoning_split',
    'extra_body',
  ]
  const flag = (enabled) => ({ enable_thinking: enabled })
  const type = (on) => ({ thinking: { type: on ? 'enabled' : 'disabled' } })
  const effort = (on) => ({ reasoning_effort: on ? 'high' : 'none' })
  for (const [origin, model, support, serialize] of [
    [dash, 'qwen3.6-plus', 'toggle', flag],
    [dash, 'qwen3.7-max-preview', 'fixed', () => ({})],
    [dash, 'kimi-k3', 'toggle', flag],
    [moon, 'kimi-k3', 'fixed', () => ({})],
    [moon, 'kimi-k2.6', 'toggle', type],
    ['https://api.z.ai/api/paas/v4', 'glm-5.2', 'toggle', type],
    ['https://open.bigmodel.cn/api/paas/v4', 'glm-5.3', 'fixed', () => ({})],
    [
      'https://api.together.xyz/v1',
      'moonshotai/Kimi-K3',
      'toggle',
      (enabled) => ({ reasoning: { enabled } }),
    ],
    [
      'https://api.fireworks.ai/inference/v1',
      'accounts/fireworks/models/kimi-k3',
      'toggle',
      effort,
    ],
    ['https://api.deepinfra.com/v1/openai', 'moonshotai/Kimi-K3', 'toggle', effort],
    ['https://api.cohere.ai/compatibility/v1', 'command-a-reasoning-08-2025', 'toggle', effort],
    [
      'https://api.groq.com/openai/v1',
      'qwen/qwen3.8-27b',
      'toggle',
      (on) => ({
        reasoning_effort: on ? 'medium' : 'none',
        reasoning_format: on ? 'parsed' : 'hidden',
      }),
    ],
    [
      google,
      'gemini-2.5-flash',
      'toggle',
      (on) => ({
        extra_body: {
          google: { thinking_config: { thinking_budget: on ? -1 : 0, include_thoughts: on } },
        },
      }),
    ],
    [
      google,
      'gemini-2.5-pro',
      'fixed',
      (on) => ({ extra_body: { google: { thinking_config: { include_thoughts: on } } } }),
    ],
    [
      'https://api.minimax.io/v1',
      'MiniMax-M3',
      'toggle',
      (on) => ({ thinking: { type: on ? 'adaptive' : 'disabled' }, reasoning_split: true }),
    ],
    ['https://api.minimax.io/v1', 'MiniMax-M3.1-Flash', 'fixed', () => ({})],
    ['https://private.example/v1', 'kimi-k2.6', undefined, () => ({})],
    [dash + '/proxy', 'qwen3.6-plus', undefined, () => ({})],
    [dash, 'qwen3.6-plus-unlisted', undefined, () => ({})],
  ]) {
    const access = select(origin, model)
    assert.equal(getConversationRoute().reasoningSupport, support, model)
    assert.equal(getConversationRoute().reasoningDisplayOnly, support !== 'toggle', model)
    for (const on of [true, false]) {
      const fetch = t.mock.method(globalThis, 'fetch', async (_, init) => {
        const body = JSON.parse(init.body)
        assert.equal(body.model, model)
        assert.deepEqual(
          Object.fromEntries(fields.filter((k) => Object.hasOwn(body, k)).map((k) => [k, body[k]])),
          serialize(on),
          model
        )
        return sse([
          frame({ reasoning_content: 'public thought' }),
          frame({ content: 'answer' }, 'stop'),
          '[DONE]',
        ])
      })
      try {
        const result = await reply(events(access, on))
        assert.deepEqual(
          result.blocks.map((b) => b.type),
          on ? ['thinking', 'text'] : ['text']
        )
        if (on) {
          assert.equal(result.blocks[0].thinking, 'public thought')
        }
      } finally {
        fetch.mock.restore()
      }
    }
  }
})

test('discovered capability overrides a static ID and survives the profile vault with exact endpoint/model/protocol scoping', async (t) => {
  t.after(() => useSettings.setState(original))
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(url, router + '/models/user?output_modalities=all')
    return Response.json({
      data: [
        { id: 'custom/alias', reasoning: { mandatory: false } },
        { id: 'deepseek/deepseek-v4-pro', reasoning: { mandatory: true } },
        { id: 'plain', supported_parameters: ['temperature'] },
      ],
    })
  })
  const rows = await discoverModels(
    { providerId: 'openrouter', endpoint: router, apiKey: 'fixture' },
    new AbortController().signal
  )
  assert.deepEqual(
    rows.map((m) => m.reasoning),
    ['toggle', 'fixed', 'none']
  )
  const flags = Object.fromEntries(
    rows.map((m) => [profileWindowKey(router, m.id, 'openai'), m.reasoning])
  )
  select(router, 'custom/alias', { discoveredReasoning: flags })
  const [decoded] = decodeLegacy(JSON.stringify(useSettings.getState().apiProfiles), null)
  assert.deepEqual(decoded.discoveredReasoning, flags)
  assert.equal(getConversationRoute().thinking, true)
  assert.equal(
    getConversationRoute(undefined, { model: 'deepseek/deepseek-v4-pro' }).reasoningDisplayOnly,
    true
  )
  assert.equal(getChatAccess().config.reasoningSupport, 'toggle')
  select('https://custom.invalid/v1', 'custom/alias', { discoveredReasoning: flags })
  assert.equal(getConversationRoute().reasoningDisplayOnly, true) // No inferred computation switch at the new endpoint.
  assert.equal(getChatAccess().config.reasoningSupport, undefined)
})

test('rendered compatible blocks preserve deltas, order, cache counts, and truthful end state', async (t) => {
  const access = select(router, 'deepseek/deepseek-v4-pro')
  t.after(() => useSettings.setState(original))
  const detail = (text) => ({ type: 'reasoning.text', text })
  const frames = [
    frame({
      reasoning_details: [
        { type: 'reasoning.encrypted', data: 'never-render' },
        detail('[REDACTED]'),
      ],
    }),
    frame({ reasoning_content: 'one', reasoning: 'one', reasoning_details: [detail('one')] }),
    frame({ reasoning_details: [detail(' '), { type: 'reasoning.summary', summary: 'two' }] }),
    frame({ reasoning: '!', content: 'answer' }),
    frame({ content: ' continued' }, 'length'),
    {
      choices: [],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 7,
        prompt_tokens_details: { cached_tokens: 60, cache_write_tokens: 5 },
      },
    },
    '[DONE]',
  ]
  t.mock.method(globalThis, 'fetch', async () => sse(frames))
  for (const on of [true, false]) {
    const result = await reply(events(access, on))
    assert.deepEqual(
      result.blocks.map((b) => b.thinking ?? b.text),
      on ? ['one two!', 'answer continued'] : ['answer continued']
    )
    assert.deepEqual(result.usage, {
      input_tokens: 35,
      input_tokens_total: 100,
      output_tokens_total: 7,
      output_tokens: 7,
      cache_read_input_tokens: 60,
      cache_creation_input_tokens: 5,
    })
    assert.equal(result.stopReason, 'max_tokens')
  }
})

test('refusal, missing terminal frame, provider interruption, typed error and caller cancellation', async (t) => {
  t.after(() => useSettings.setState(original))
  const access = select(ds, 'deepseek-v4-pro')
  let frames = []
  const fetch = t.mock.method(globalThis, 'fetch', async () => sse(frames))
  for (const [response, reason] of [
    [frame({ refusal: 'Sorry' }, 'stop'), 'refusal'],
    [frame({}, 'content_filter'), 'refusal'],
    [frame({}, 'length'), 'max_tokens'],
    [frame({ content: 'hello' }, 'stop'), 'end_turn'],
  ]) {
    frames = [response]
    assert.equal((await reply(events(access))).stopReason, reason)
  }
  for (const [response, kind] of [
    [frame({ content: 'unfinished' }), 'interrupted'],
    [frame({}, 'insufficient_system_resource'), 'interrupted'],
    [frame({}, 'aborted'), 'interrupted'],
    [{ error: { message: 'stream failed' } }, 'stream'],
  ]) {
    frames = [response]
    await assert.rejects(reply(events(access)), (error) => error.kind === kind)
  }
  const ac = new AbortController()
  let cancel
  fetch.mock.mockImplementation(
    async () =>
      new Response(
        new ReadableStream({
          cancel: () => {
            cancel = true
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } }
      )
  )
  const it = events(access, true, ac.signal)
  await it.next()
  const wait = it.next()
  ac.abort()
  await assert.rejects(wait, { name: 'AbortError' })
  assert.equal(cancel, true)
})

test('native Messages filters unrequested and signature-only thinking before chat state storage', async (t) => {
  t.after(() => useSettings.setState(original))
  const access = select('https://api.deepseek.com', 'deepseek-v4-pro', { protocol: 'deepseek' })
  t.mock.method(globalThis, 'fetch', async () =>
    sse([
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'never-render' },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'thinking_delta', thinking: 'genuine' },
      },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_start', index: 2, content_block: { type: 'text', text: 'final' } },
      { type: 'message_stop' },
    ])
  )
  assert.deepEqual(
    (await reply(events(access))).blocks.map((b) => b.thinking ?? b.text),
    ['genuine', 'final']
  )
  assert.deepEqual(
    (await reply(events(access, false))).blocks.map((b) => b.thinking ?? b.text),
    ['final']
  )
})
