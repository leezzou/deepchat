import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { test } from 'node:test'
registerHooks({
  resolve(id, ctx, next) {
    const ts = id.startsWith('.') && id.endsWith('.js') && ctx.parentURL && new URL(id.slice(0, -3) + '.ts', ctx.parentURL)
    return next(ts && existsSync(ts) ? ts.href : id, ctx)
  },
})
const { discoverModels, inspectOllama, modelEndpoint } = await import('./modelDiscovery.ts')
const signal = () => new AbortController().signal
const fixture = async (f, run) => {
  const original = globalThis.fetch
  globalThis.fetch = f
  try {
    await run()
  } finally {
    globalThis.fetch = original
  }
}
const profile = (providerId, endpoint, apiKey = 'fixture') => ({ providerId, endpoint, apiKey })

test('explicit metadata only, including nested context fields, unknown private ids and Together array', async () => {
  await fixture(
    async (url, init) => {
      assert.equal(url, 'https://edge.invalid/v1/models')
      assert.equal(init.credentials, 'omit')
      assert.equal(init.redirect, 'error')
      assert.equal(init.headers.Authorization, 'Bearer fixture')
      return Response.json([
        { id: 'private', max_tokens: 8192, max_output_tokens: 65536 },
        { id: 'meta', metadata: { context_length: 98304, max_tokens: 1024 } },
        { id: 'novita', context_size: 99999 },
        { id: 'safe', context_window: 77777, max_input_tokens: 512 },
        { id: 'bad', context_length: -1 },
      ])
    },
    async () =>
      assert.deepEqual(
        (await discoverModels(profile('anthropic', 'https://edge.invalid/v1'), signal())).map(
          (r) => r.contextWindow
        ),
        [undefined, 98304, 99999, 77777, undefined]
      )
  )
})

test('official OpenAI lists authorized chat and Responses IDs and excludes adjacent non-chat APIs',async()=>{
  await fixture(async(url,init)=>{
    assert.equal(url,'https://api.openai.com/v1/models');assert.equal(init.headers.Authorization,'Bearer fixture');
    return Response.json({data:['gpt-5.5-pro','o3-pro','gpt-5.3-codex','gpt-6.2-astra','ft:gpt-4o:org:name:id','gpt-image-1','gpt-4o-transcribe','text-embedding-3-small','gpt-3.5-turbo-instruct','tts-1','o3-deep-research','gpt-oss-120b'].map(id=>({id}))})
  },async()=>assert.deepEqual((await discoverModels(profile('openai','https://api.openai.com/v1'),signal())).map(row=>row.id),['gpt-5.5-pro','o3-pro','gpt-5.3-codex','gpt-6.2-astra','ft:gpt-4o:org:name:id']))
})

test('Gemini keeps key out of URL, pages safely and labels input limits', async () => {
  let page = 0
  await fixture(
    async (url, init) => {
      const parsed = new URL(url)
      assert.equal(parsed.origin, 'https://generativelanguage.googleapis.com')
      assert.equal(parsed.pathname, '/v1beta/models')
      assert.equal(parsed.searchParams.get('key'), null)
      assert.equal(init.headers['x-goog-api-key'], 'fixture')
      if (++page === 1) {
        return Response.json({
          models: [
            { name: 'models/a', displayName: 'A', inputTokenLimit: 333, outputTokenLimit: 64 },
          ],
          nextPageToken: 'https://other.invalid/collect',
        })
      }
      assert.equal(parsed.searchParams.get('pageToken'), 'https://other.invalid/collect')
      return Response.json({ models: [{ name: 'models/b', outputTokenLimit: 123 }] })
    },
    async () => {
      const rows = await discoverModels(
        profile('gemini', 'https://generativelanguage.googleapis.com/v1beta/openai'),
        signal()
      )
      assert.equal(rows[0].source, 'input')
      assert.equal(rows[0].contextWindow, 333)
      assert.equal(rows[1].id, 'b')
      assert.equal(rows[1].contextWindow, undefined)
      assert.equal(page, 2)
    }
  )
})

test('Anthropic uses native headers and cursor, Cohere uses its model name and token', async () => {
  const paths = []
  await fixture(
    async (url, init) => {
      const u = new URL(url)
      paths.push(u.pathname)
      if (u.hostname === 'api.anthropic.com') {
        assert.equal(init.headers['x-api-key'], 'fixture')
        assert.equal(init.headers['anthropic-version'], '2026-10-21')
        assert.equal(init.headers['anthropic-dangerous-direct-browser-access'], 'true')
        return Response.json(
          u.searchParams.has('after_id')
            ? { data: [{ id: 'b', max_tokens: 123 }], has_more: false }
            : {
                data: [{ id: 'a', max_input_tokens: 456, max_tokens: 123 }],
                has_more: true,
                last_id: 'a',
              }
        )
      }
      return Response.json(
        u.searchParams.has('page_token')
          ? { models: [{ name: 'b' }] }
          : { models: [{ name: 'a', context_length: 8192 }], next_page_token: 'next' }
      )
    },
    async () => {
      const a = await discoverModels(profile('anthropic', 'https://api.anthropic.com/v1'), signal())
      assert.deepEqual(
        a.map((x) => x.contextWindow),
        [456, undefined]
      )
      assert.equal(a[0].source, 'input')
      const c = await discoverModels(
        profile('cohere', 'https://api.cohere.ai/compatibility/v1'),
        signal()
      )
      assert.deepEqual(
        c.map((x) => x.id),
        ['a', 'b']
      )
      assert.deepEqual(paths, ['/v1/models', '/v1/models', '/v1/models', '/v1/models'])
    }
  )
})

test('OpenCode uses selected plan, SenseNova honors chat permissions, TokenHub honors online status', async () => {
  const data = new Map([
    ['/inference/go/v1/models', [{ id: 'go', limit: { context: 100000, output: 50000 } }]],
    [
      '/v1/llm/models',
      [
        { id: 'chat', permission: [{ allow_chat: true }] },
        { id: 'no', permission: [{ allow_chat: false }] },
      ],
    ],
    [
      '/v1/models',
      [
        { id: 'x', status: 'pre-offline' },
        { id: 'no', status: 'offline' },
      ],
    ],
  ])
  await fixture(
    async (url) => Response.json({ data: data.get(new URL(url).pathname) }),
    async () => {
      const discover = (id, url) => discoverModels(profile(id, url), signal())
      assert.equal(
        (await discover('opencode-go', 'https://opencode.ai/inference/go/openai/v1'))[0]
          .contextWindow,
        100000
      )
      assert.deepEqual(
        (await discover('sensenova', 'https://api.sensenova.cn/compatible-mode/v2')).map(
          (x) => x.id
        ),
        ['chat']
      )
      assert.deepEqual(
        (await discover('hunyuan', 'https://tokenhub.tencentmaas.com/v1')).map((x) => x.id),
        ['x']
      )
    }
  )
})

test('Ollama tags plus running contexts; show is selection-only and honors num_ctx before architecture maximum', async () => {
  const calls = []
  const p = profile('ollama', 'http://127.0.0.1:11434/proxy/v1', '')
  await fixture(
    async (url, init) => {
      assert.equal(init.headers.Authorization, undefined)
      calls.push([new URL(url).pathname, init.method])
      if (url.endsWith('/tags')) {
        return Response.json({ models: [{ name: 'awake' }, { name: 'cold' }] })
      }
      if (url.endsWith('/ps')) {
        return Response.json({ models: [{ name: 'awake', context_length: 4096 }] })
      }
      if (init.body === '{"model":"awake"}') {
        return Response.json({ thinking: { values: [false, true] } })
      }
      assert.equal(init.body, '{"model":"cold"}')
      return Response.json({
        parameters: 'num_ctx 2048',
        model_info: { 'general.architecture': 'llama', 'llama.context_length': 131072 },
      })
    },
    async () => {
      const models = await discoverModels(p, signal())
      assert.deepEqual(
        models.map((r) => r.contextWindow),
        [4096, undefined]
      )
      const awake = await inspectOllama(p, models[0], signal())
      assert.equal(awake.contextWindow, 4096)
      assert.equal(awake.reasoning, 'toggle')
      const cold = await inspectOllama(p, models[1], signal())
      assert.equal(cold.contextWindow, 2048)
      assert.equal(cold.source, 'endpoint')
      assert.deepEqual(calls, [
        ['/proxy/api/tags', 'GET'],
        ['/proxy/api/ps', 'GET'],
        ['/proxy/api/show', 'POST'],
        ['/proxy/api/show', 'POST'],
      ])
    }
  )
})

test('LM Studio separates two loaded instances from the model maximum; v0 fallback keeps loaded limit', async () => {
  let modern = true
  const p = profile('lmstudio', 'http://10.0.2.2:1234/v1')
  await fixture(
    async (url) => {
      if (url.endsWith('/api/v1/models')) {
        return modern
          ? Response.json({
              models: [
                {
                  key: 'a',
                  max_context_length: 131072,
                  loaded_instances: [
                    { id: 'a', config: { context_length: 2048 } },
                    { id: 'a:2', config: { context_length: 4096 } },
                  ],
                },
                { key: 'b', max_context_length: 99999 },
              ],
            })
          : new Response(null, { status: 404 })
      }
      assert.ok(url.endsWith('/api/v0/models'))
      return Response.json({
        data: [{ id: 'a', max_context_length: 131072, loaded_context_length: 8192 }],
      })
    },
    async () => {
      assert.deepEqual(
        (await discoverModels(p, signal())).map((x) => [x.id, x.contextWindow, x.source]),
        [
          ['a', 2048, 'instance'],
          ['a:2', 4096, 'instance'],
          ['b', 99999, 'model'],
        ]
      )
      modern = false
      assert.equal((await discoverModels(p, signal()))[0].contextWindow, 8192)
    }
  )
})

test('browser transport refuses actual cross-origin auth redirect before the second server receives any request', async () => {
  let leaked = 0,
    originalReceived = false
  const trap = createServer((_q, r) => {
    leaked++
    r.end('{}')
  })
  trap.listen(0, '127.0.0.1')
  await once(trap, 'listening')
  const source = createServer((q, r) => {
    originalReceived = q.headers.authorization === 'Bearer fixture'
    r.writeHead(307, { Location: `http://127.0.0.1:${trap.address().port}/models` })
    r.end()
  })
  source.listen(0, '127.0.0.1')
  await once(source, 'listening')
  try {
    await assert.rejects(
      discoverModels(profile('custom', `http://127.0.0.1:${source.address().port}/v1`), signal())
    )
    assert.ok(originalReceived)
    assert.equal(leaked, 0)
  } finally {
    source.close()
    trap.close()
  }
})

test('native bridge reassembles a multi-frame catalog and rejects truncated replies', async () => {
  const original = globalThis.window
  const port = { postMessage: () => {} }
  globalThis.window = { DeepChatSecurity: port, clearTimeout, setTimeout }
  try {
    const { nativeModelRequest } = await import('../security/bridge.ts?model-chunk-test')
    const payload = JSON.stringify({
      data: Array.from({ length: 1400 }, (_, i) => ({ id: `private-model-${i}` })),
    })
    let truncated = false
    port.postMessage = (raw) => {
      const { id } = JSON.parse(raw)
      for (let i = 0; i < payload.length; i += 32768) {
        port.onmessage({ data: JSON.stringify({ id, modelChunk: payload.slice(i, i + 32768) }) })
      }
      port.onmessage({
        data: JSON.stringify({
          id,
          value: { status: 200, length: payload.length + (truncated ? 1 : 0) },
        }),
      })
    }
    const fields = {
      endpoint: 'https://edge.invalid/v1',
      url: 'https://edge.invalid/v1/models',
      auth: 'bearer',
      key: 'fixture',
    }
    assert.equal((await nativeModelRequest(fields, signal())).body, payload)
    truncated = true
    await assert.rejects(nativeModelRequest(fields, signal()), /incomplete/u)
  } finally {
    globalThis.window = original
  }
})

test('invalid endpoints reject embedded credentials, query keys, external cleartext and non-http schemes', () => {
  for (const s of [
    'https://u:k@edge.invalid/api',
    'https://edge.invalid/?key=secret',
    'https://edge.invalid/#x',
    'http://edge.invalid',
    'file:///data',
  ]) {
    assert.throws(() => modelEndpoint(s))
  }
})
