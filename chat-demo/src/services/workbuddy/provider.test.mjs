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
const { getChatAccess, getConversationRoute } = await import('../api/access.ts')
const { applyEvent } = await import('../chat/reply.ts')
const { buildReplyView } = await import('../chat/view.ts')
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
  assert.equal(getConversationRoute().thinking, true)
  assert.equal(getConversationRoute().search, true)
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
  assert.deepEqual(Object.keys(call).sort(), [
    'id',
    'messages',
    'model',
    'op',
    'revision',
    'thinking',
  ])
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

const searchTool = { type: 'deepseek_web_search', name: 'deepseek_web_search' }
const answer =
  'data: {"choices":[{"delta":{"content":"文档已更新"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
const reason = 'data: {"choices":[{"delta":{"reasoning_content":"核对更新时间"}}]}\n\n'
function delivery(id, status, contentType, text) {
  frame(id, { type: 'headers', status, contentType })
  frame(id, { type: 'data', data: Buffer.from(text).toString('base64') })
  frame(id, { type: 'end' })
}
test('search retrieves only this question and grounds the selected model; reply view shows real sources and reasoning', async () => {
  const start = calls.length
  const sample = {
    title: '版本说明',
    snippet: '检索得到的摘要',
    url: 'https://docs.example/release',
    date: '2026-10-06',
  }
  reply = ({ id, op }) => {
    if (op === 'search') {
      delivery(
        id,
        200,
        'application/json',
        JSON.stringify({ results: [sample, sample, { url: 'javascript:bad' }] })
      )
    }
    if (op === 'chat') {
      delivery(id, 200, 'text/event-stream', reason + answer)
    }
  }
  const messages = [
    { role: 'latest_reminder', content: 'private reminder' },
    { role: 'user', content: '帮我找更新文档' },
  ]
  const events = await drain(access, {
    ...body,
    messages,
    tools: [searchTool],
    thinking: { type: 'enabled' },
  })
  const [search, chat] = calls.slice(start).filter((x) => x.op !== 'cancel')
  assert.deepEqual(search, {
    op: 'search',
    query: '帮我找更新文档',
    model: access.model,
    revision,
    id: search.id,
  })
  assert.equal(chat.model, access.model)
  assert.equal(chat.revision, revision)
  assert.equal(chat.thinking, true)
  assert.deepEqual(chat.messages.at(-1), messages.at(-1))
  assert.ok(
    chat.messages.some(
      (message) => message.role === 'user' && message.content.includes(sample.snippet)
    )
  )
  assert.ok(
    !chat.messages.some(
      (message) => message.role === 'system' && message.content.includes(sample.snippet)
    )
  )
  const indexes = new Map()
  const model = events.reduce((acc, event) => applyEvent(acc, event, Date.now(), indexes), {
    role: 'assistant',
    blocks: [],
    status: 'pending',
  })
  const view = buildReplyView(model, false)
  assert.deepEqual(
    view.steps.map((x) => x.type),
    ['search', 'thinking']
  )
  assert.deepEqual(
    view.searchResults.map((x) => [x.title, x.url, x.snippet]),
    [[sample.title, sample.url, sample.snippet]]
  )
  assert.equal(view.answer.text, '文档已更新')
})
test('failed search, malformed search, cancellation and changed grant stop the request', async () => {
  const content = { ...body, tools: [searchTool] }
  const start = calls.length
  for (const [status, data, expected] of [
    [403, { code: 15003, msg: 'entitlement denied' }, /15003.*entitlement denied/],
    [200, { error: { code: 6004, message: 'quota' } }, /6004.*quota/],
    [200, { results: [{ url: 'file:///private' }] }, /Invalid search sources/],
  ]) {
    reply = ({ id }) => delivery(id, status, 'application/json', JSON.stringify(data))
    await assert.rejects(drain(access, content), expected)
  }
  assert.equal(
    calls.slice(start).some((x) => x.op === 'chat'),
    false
  )
  const controller = new AbortController()
  reply = ({ op }) => {
    if (op === 'search') {
      controller.abort()
    }
  }
  await assert.rejects(drain(access, content, controller.signal), { name: 'AbortError' })
  assert.equal(calls.at(-1).op, 'cancel')
  reply = ({ id, op }) => {
    if (op === 'search') {
      delivery(id, 200, 'application/json', '{"results":[]}')
    }
    if (op === 'chat') {
      frame(id, { type: 'error', code: 'account_changed' })
    }
  }
  await assert.rejects(drain(access, content), /account_changed/)
  assert.equal(calls.slice(start).filter((x) => x.op === 'chat').length, 1)
})
test('off switches omit search and send thinking false; provider omission is visible when thinking was requested', async () => {
  const start = calls.length
  respond(200, answer)
  const events = await drain(access, {
    ...body,
    tools: [{ type: 'deepseek_read_url', name: 'deepseek_read_url' }],
  })
  assert.equal(events.at(-1).type, 'message_stop')
  assert.deepEqual(
    calls
      .slice(start)
      .filter((x) => x.op !== 'cancel')
      .map((x) => [x.op, x.thinking]),
    [['chat', false]]
  )
  const missing = await drain(access, { ...body, thinking: { type: 'enabled' } })
  const indexes = new Map()
  const result = missing.reduce((acc, event) => applyEvent(acc, event, 1, indexes), {
    blocks: [],
    status: 'pending',
  })
  assert.equal(result.workBuddyReasoningUnavailable, true)
  assert.equal(buildReplyView(result, false).answer.text, '文档已更新')
  assert.equal(missing.at(-1).type, 'message_stop')
})

test('model quota refusals still reach the chat for both HTTP and SSE', async () => {
  const rejection = { code: 6004, msg: '本模型已达到限额' }
  respond(429, JSON.stringify(rejection), 'application/json')
  await assert.rejects(drain(access), /6004.*本模型已达到限额/)
  respond(200, 'event: error\ndata: ' + JSON.stringify(rejection) + '\n\n')
  await assert.rejects(drain(access), /6004.*本模型已达到限额/)
})
