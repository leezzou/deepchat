// Exercise the real route, text adapter and bridge with an isolated Android port. No external I/O.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import test from 'node:test'
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
    const { code } = experiments.swc.transformSync(readFileSync(filename, 'utf8'), {
      filename,
      jsc: { parser: { syntax: 'typescript' }, target: 'es2022' },
      module: { type: 'es6' },
    })
    return { format: 'module', shortCircuit: true, source: code }
  },
})
const records = new Map(),
  calls = []
const port = {
  postMessage(text) {
    calls.push(JSON.parse(text))
    queueMicrotask(() => reply(JSON.parse(text)))
  },
}
let reply = () => {}
globalThis.window = { WorkBuddyChat: port }
globalThis.localStorage = {
  getItem: (k) => records.get(k) ?? null,
  setItem: (k, v) => records.set(k, v),
  removeItem: (k) => records.delete(k),
}
globalThis.fetch = () => assert.fail('WorkBuddy must not dispatch a browser request')
globalThis.__API_ORIGIN__ = 'https://api.deepseek.com'
const { request, streamMessage } = await import('../api/client.ts')
const { isWorkBuddyModel, WORKBUDDY_MODELS } = await import('./models.ts')
const { useWorkBuddyState, refreshWorkBuddy } = await import('./provider.ts')
const { useSettings } = await import('../settings.ts')
const { getChatAccess } = await import('../api/access.ts')
const { useConversationModes } = await import('../conversationMode/storage.ts')
const revision = '01234567-89ab-4cde-abcd-0123456789ab'
const access = { source: 'workbuddy', revision, model: 'deepseek-v4.1-flash' }
const body = {
  system: 'system message exactly as written',
  messages: [{ role: 'user', content: '中文' }],
  model: 'deepseek-flash',
  tools: [],
  safety_check: { level: 'high' },
  thinking: { type: 'disabled' },
}
const drain = async (params = access, content = body, signal = new AbortController().signal) =>
  Array.fromAsync(streamMessage(params, content, signal))
function frame(id, fields) {
  port.onmessage({ data: JSON.stringify({ id, ...fields }) })
}
function respond(status, text, media = 'text/event-stream') {
  reply = ({ id, op }) => {
    if (op !== 'chat') {
      return
    }
    frame(id, { type: 'headers', status, contentType: media })
    for (const byte of Buffer.from(text)) {
      frame(id, { type: 'data', data: Buffer.from([byte]).toString('base64') })
    }
    frame(id, { type: 'end' })
  }
}
test('only exact and independently authorized WorkBuddy routes are available', async () => {
  assert.deepEqual(WORKBUDDY_MODELS, [
    'deepseek-v4.1-flash',
    'deepseek-v4-pro',
    'deepseek-v4-flash',
  ])
  for (const denied of [
    'auto',
    'DEEPSEEK-V4-PRO',
    'gpt-5',
    'deepseek-v4-pro ',
    'deepseek-v4-pro-extra',
    undefined,
  ]) {
    assert.equal(isWorkBuddyModel(denied), false)
  }
  useSettings.setState({
    chatSource: 'workbuddy',
    apiKey: 'unrelated-test-credential',
    accountSignedIn: true,
  })
  assert.equal(getChatAccess(), null)
  reply = ({ id }) => frame(id, { type: 'status', revision, model: access.model, name: 'Test' })
  await refreshWorkBuddy()
  assert.deepEqual(getChatAccess(), access)
  const cache = JSON.parse(records.get('chat-demo:workbuddy-route:v1'))
  assert.deepEqual(Object.keys(cache).sort(), ['model', 'revision'])
  useConversationModes.setState({ draft: { profileId: '@workbuddy', model: 'another-model' } })
  assert.equal(getChatAccess(null), null)
  useConversationModes.setState({ draft: { profileId: '@workbuddy', model: access.model } })
  assert.equal(getChatAccess(null), null, 'imported destination has no approval')
  useConversationModes.setState({ draft: {} })
  useWorkBuddyState.setState({ metadata: null })
  assert.equal(getChatAccess(), null)
})
test('direct chat preserves requested model, system text, Unicode and SSE reasoning/text', async () => {
  respond(
    200,
    'data: {"model":"deepseek-v4.1-flash","choices":[{"delta":{"reasoning_content":"想"}}]}\n\ndata: {"model":"deepseek-v4.1-flash","choices":[{"delta":{"content":"你好"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
  )
  const events = await drain()
  const call = calls.filter((x) => x.op === 'chat').at(-1)
  assert.deepEqual(Object.keys(call).sort(), ['id', 'messages', 'model', 'op', 'revision'])
  assert.deepEqual(call.messages, [{ role: 'system', content: body.system }, ...body.messages])
  assert.equal(call.model, access.model)
  assert.deepEqual(
    events.filter((x) => x.type === 'content_block_delta').map((x) => x.delta),
    [
      { type: 'thinking_delta', thinking: '想' },
      { type: 'text_delta', text: '你好' },
    ]
  )
  assert.equal(events.at(-1).type, 'message_stop')
})
test('service denials, different response model and interrupted streams cannot trigger fallback', async () => {
  const start = calls.filter((x) => x.op === 'chat').length
  respond(403, '{"code":11128,"message":"client denied"}', 'application/json')
  await assert.rejects(drain(), /HTTP 403.*11128.*client denied/)
  respond(200, 'data: {"model":"not-requested","choices":[{"delta":{"content":"bad"}}]}\n\n')
  await assert.rejects(drain(), /Model mismatch/)
  respond(200, 'data: {"choices":[{"delta":{"content":"part"}}]}\n\n')
  await assert.rejects(drain(), /Interrupted/)
  await assert.rejects(drain({ ...access, model: 'auto' }), /Unsupported model/)
  await assert.rejects(
    drain(access, {
      ...body,
      messages: [
        {
          role: 'user',
          content: [{ type: 'image', source: { type: 'file', file_id: 'unrelated' } }],
        },
      ],
    }),
    /Text messages only/
  )
  await assert.rejects(request('https://api.deepseek.com/voice', {}, access), /WorkBuddy/)
  assert.equal(calls.filter((x) => x.op === 'chat').length, start + 3)
})
test('cancelling a native request releases the stream', async () => {
  const controller = new AbortController()
  reply = ({ op }) => {
    if (op === 'chat') {
      controller.abort()
    }
  }
  await assert.rejects(drain(access, body, controller.signal), { name: 'AbortError' })
  assert.equal(calls.at(-1).op, 'cancel')
})
