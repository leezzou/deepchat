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
test('preserves reported WorkBuddy usage after finish, with errors kept distinct from completed answers', async () => {
  const sse = (...chunks) => chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')
  respond(
    200,
    sse(
      {
        choices: [{ delta: { reasoning: '比较两款屏幕。', reasoning_content: '比较两款屏幕。' } }],
      },
      { choices: [{ delta: { content: '结果相同' }, finish_reason: 'stop' }] },
      {
        choices: [],
        usage: {
          prompt_tokens: 90,
          completion_tokens: 17,
          prompt_tokens_details: { cached_tokens: 25 },
        },
      }
    )
  )
  const events = await drain(access, { ...body, thinking: { type: 'enabled' } })
  assert.equal(
    events
      .filter((event) => event.delta?.type === 'thinking_delta')
      .map((event) => event.delta.thinking)
      .join(''),
    '比较两款屏幕。'
  )
  const done = events.find((event) => event.type === 'message_delta')
  assert.equal(done.delta.stop_reason, 'end_turn')
  assert.equal(done.usage.cache_read_input_tokens, 25)
  assert.equal(done.usage.output_tokens, 17)
  respond(200, sse({ choices: [{ delta: { content: 'partial' }, finish_reason: 'error' }] }))
  await assert.rejects(drain(), /Interrupted|中断/)
  respond(200, sse({ choices: [{ delta: { refusal: '无法回答' }, finish_reason: 'stop' }] }))
  const refused = await drain()
  assert.equal(refused.find((event) => event.type === 'message_delta').delta.stop_reason, 'refusal')
})

test('direct chat preserves requested model, system text, Unicode and SSE reasoning/text', async () => {
  respond(
    200,
    'data: {"model":"deepseek-v4.1-flash","choices":[{"delta":{"reasoning_content":"想"}}]}\n\ndata: {"model":"deepseek-v4.1-flash","choices":[{"delta":{"content":"你好"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
  )
  const events = await drain(access, { ...body, thinking: { type: 'enabled' } })
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
  const search = calls.slice(start).find((x) => x.op === 'search')
  const chat = calls.slice(start).find((x) => x.op === 'chat')
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
test('off switches omit tools and discard unsolicited reasoning; omitted reasoning stays absent', async () => {
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
  assert.equal(
    result.blocks.some((block) => block.type === 'thinking'),
    false
  )
  assert.equal(
    missing.some((event) => 'workBuddyReasoningUnavailable' in event),
    false
  )
  assert.equal(buildReplyView(result, false).answer.text, '文档已更新')
  assert.equal(missing.at(-1).type, 'message_stop')
})

function sendPlan(id, plan) {
  delivery(
    id,
    200,
    'text/event-stream',
    `data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(plan) }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`
  )
}
function viewOf(events) {
  const indexes = new Map()
  return buildReplyView(
    events.reduce((reply, e) => applyEvent(reply, e, 1, indexes), {
      blocks: [],
      status: 'pending',
    }),
    false
  )
}
const comparison = {
  ...body,
  tools: [searchTool],
  system: 'secret-system-canary',
  messages: [
    { role: 'user', content: 'checkpoint-canary' },
    { role: 'user', content: 'private customer: AmberLedger 001' },
    { role: 'assistant', content: [{ type: 'text', text: 'private-answer-canary' }] },
    { role: 'latest_reminder', content: 'reminder-canary' },
    { role: 'user', content: '我在比较 MiraLoop X2 和 Kubo Air 这两款耳机' },
    { role: 'assistant', content: [{ type: 'text', text: '可以核对这两款的公开参数。' }] },
    { role: 'user', content: '那它们的续航呢？请逐篇核对原文。' },
  ],
}

test('resolves follow-up with same-grant planner; isolates private history, reads nine public results and resolves split citations', async () => {
  const start = calls.length
  let round = 0
  const rows = Array.from({ length: 9 }, (_, i) => ({
    title: `Source ${i + 1}`,
    url: `https://review${i}.example/news`,
    snippet: '独立的测评摘要',
    readKey: `native-only-${i}`,
  }))
  reply = ({ id, op, purpose, readKey }) => {
    if (purpose === 'search_plan') {
      return sendPlan(id, {
        queries: ['MiraLoop X2 Kubo Air 续航规格', 'MiraLoop X2 Kubo Air 续航实测'],
        multi: true,
        read: true,
      })
    }
    if (op === 'search') {
      return delivery(
        id,
        200,
        'application/json',
        JSON.stringify({
          results:
            round++ === 0
              ? rows.slice(0, 6)
              : [{ ...rows[0], url: rows[0].url + '?utm_source=x#old' }, ...rows.slice(6)],
        })
      )
    }
    if (op === 'read') {
      return delivery(
        id,
        200,
        'application/json',
        JSON.stringify({ text: 'Body for ' + readKey.split('-').at(-1) + ' 权威资料'.repeat(80) })
      )
    }
    if (op === 'chat') {
      return delivery(
        id,
        200,
        'text/event-stream',
        ['实测显示[S', '7]。可参考[S9][S999]']
          .map((content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`)
          .join('') + 'data: [DONE]\n\n'
      )
    }
  }
  const events = await drain(access, {
    ...comparison,
    messages: [
      ...comparison.messages.slice(0, -1),
      { role: 'user', content: '那这两款的官方续航规格和独立测评相比呢？' },
    ],
  })
  const sent = calls.slice(start).filter((x) => x.op !== 'cancel')
  const planner = sent[0]
  assert.equal(planner.purpose, 'search_plan')
  assert.equal(planner.thinking, false)
  assert.ok(sent.every((req) => req.model === access.model && req.revision === revision))
  assert.match(planner.messages[1].content, /MiraLoop X2 和 Kubo Air/)
  assert.doesNotMatch(planner.messages[1].content, /canary|AmberLedger/)
  assert.deepEqual(
    sent.filter((x) => x.op === 'search').map((x) => x.query),
    ['MiraLoop X2 Kubo Air 续航规格', 'MiraLoop X2 Kubo Air 续航实测']
  )
  const reads = sent.filter((x) => x.op === 'read')
  assert.equal(reads.length, 9)
  assert.ok(reads.every((x) => !('url' in x) && !('messages' in x)))
  const evidence = sent
    .at(-1)
    .messages.find((row) => row.content.startsWith('WorkBuddy search results')).content
  assert.match(evidence, /Body for 8/)
  assert.doesNotMatch(evidence, /native-only-|canary/)
  assert.doesNotMatch(JSON.stringify(events), /native-only-/)
  const view = viewOf(events)
  assert.equal(view.searchResults.length, 9)
  assert.equal(view.sources.length, 9)
  assert.deepEqual(view.answer, {
    text: '实测显示。可参考',
    markdown: '实测显示[citation:7]。可参考[citation:9]',
  })
})

test('single plain query gets a bounded second search only if needed; denied reads retain snippets', async () => {
  const content = {
    ...body,
    tools: [searchTool],
    messages: [{ role: 'user', content: '新品动态' }],
  }
  for (const sufficient of [true, false]) {
    const start = calls.length
    reply = ({ id, op }) => {
      if (op === 'search') {
        return delivery(
          id,
          200,
          'application/json',
          JSON.stringify({
            results: (sufficient ? [1, 2] : [1]).map((n) => ({
              url: `https://docs.example/${n}`,
              readKey: `read-${n}`,
              snippet: sufficient
                ? `新品动态：发布说明第 ${n} 期包含完整产品规格及上市时间。`
                : '保留的摘要',
            })),
          })
        )
      }
      if (op === 'read') {
        return delivery(id, 403, 'application/json', '{"error":{"message":"reader denied"}}')
      }
      if (op === 'chat') {
        return delivery(id, 200, 'text/event-stream', answer)
      }
    }
    const events = await drain(access, content)
    const sent = calls.slice(start).filter((x) => x.op !== 'cancel')
    assert.equal(sent.filter((x) => x.op === 'search').length, sufficient ? 1 : 2)
    assert.equal(sent.filter((x) => x.op === 'read').length, sufficient ? 0 : 1)
    const evidence = sent
      .at(-1)
      .messages.find((row) => row.content.startsWith('WorkBuddy search results')).content
    assert.doesNotMatch(evidence, /"page"/)
    assert.match(sent.at(-1).messages[0].content, /0 retrieved page excerpt.*Only search listings/s)
    if (!sufficient) {
      const fetchResults = events
        .map((event) => event.content_block)
        .filter((block) => block?.type === 'web_fetch_tool_result')
      assert.equal(fetchResults.length, 1)
      assert.equal(fetchResults[0].content.type, 'web_fetch_tool_result_error')
    }
    assert.match(evidence, sufficient ? /发布说明/ : /保留的摘要/)
    assert.equal(viewOf(events).answer.text, '文档已更新')
  }
})

test('planner errors fall back to current safe question, explicit privacy abstention and sensitive input make zero search calls', async () => {
  for (const mode of [
    'malformed',
    'unresolved',
    'abstain',
    'sensitive-plan',
    'sensitive-question',
  ]) {
    const start = calls.length
    reply = ({ id, op, purpose }) => {
      if (purpose === 'search_plan') {
        return sendPlan(
          id,
          mode === 'malformed' || mode === 'unresolved'
            ? 'not a plan'
            : { queries: mode === 'sensitive-plan' ? ['API key abcxyz'] : [] }
        )
      }
      if (op === 'search') {
        return delivery(id, 200, 'application/json', '{"results":[]}')
      }
      if (op === 'chat') {
        return delivery(id, 200, 'text/event-stream', answer)
      }
    }
    const content =
      mode === 'sensitive-question'
        ? {
            ...comparison,
            messages: [
              ...comparison.messages,
              { role: 'user', content: '请查询私有项目及密码 hunter2' },
            ],
          }
        : mode === 'malformed'
          ? {
              ...comparison,
              messages: [
                ...comparison.messages.slice(0, -1),
                { role: 'user', content: '查询 MiraLoop X2 国内公开售价' },
              ],
            }
          : comparison
    await drain(access, content)
    const sent = calls.slice(start).filter((req) => req.op === 'search')
    if (mode === 'malformed') {
      assert.equal(sent[0].query, content.messages.at(-1).content.normalize('NFKC'))
    } else {
      assert.equal(sent.length, 0)
    }
  }
})

test('abort and credential changes during planner or page read prevent later search or answer dispatch', async () => {
  for (const stage of ['plan', 'read']) {
    for (const fault of ['cancel', 'account_changed']) {
      const start = calls.length
      const controller = new AbortController()
      reply = ({ id, op, purpose }) => {
        if ((purpose === 'search_plan' && stage === 'plan') || op === 'read') {
          if (fault === 'cancel') {
            controller.abort()
          } else {
            frame(id, { type: 'error', code: fault })
          }
        } else if (purpose === 'search_plan') {
          sendPlan(id, { queries: ['MiraLoop X2 续航'], read: true })
        } else if (op === 'search') {
          delivery(
            id,
            200,
            'application/json',
            '{"results":[{"url":"https://docs.example/x","readKey":"opaque"}]}'
          )
        }
      }
      await assert.rejects(
        drain(access, comparison, controller.signal),
        fault === 'cancel' ? { name: 'AbortError' } : /account_changed/
      )
      assert.equal(
        calls.slice(start).some((req) => req.op === 'chat' && !req.purpose),
        false
      )
      if (stage === 'plan') {
        assert.equal(
          calls.slice(start).some((req) => req.op === 'search'),
          false
        )
      }
    }
  }
})

test('disabled reasoning, empty reasoning and whitespace-only reasoning emit no thinking blocks', async () => {
  for (const [thinking, reasoning] of [
    ['disabled', 'do not display'],
    ['enabled', '  '],
    ['enabled', ''],
  ]) {
    respond(
      200,
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: reasoning } }] })}\n\n` +
        answer
    )
    const events = await drain(access, { ...body, thinking: { type: thinking } })
    assert.equal(
      events.some(
        (event) =>
          event.content_block?.type === 'thinking' || event.delta?.type === 'thinking_delta'
      ),
      false
    )
    assert.ok(viewOf(events).answer)
  }
})

test('bounds UTF-8 evidence and filters local, credential-bearing and duplicate sources across rounds', async () => {
  const { byteLength, searchSources, withSearchEvidence } = await import('./search.ts')
  const seen = new Set()
  const hits = []
  for (let round = 0; round < 3; round++) {
    const results = Array.from({ length: 24 }, (_, i) => ({
      url: `https://docs.example/${round}/${i}`,
      title: '标题'.repeat(200),
      snippet: '内容😀'.repeat(500),
      readKey: 'opaque-only',
    }))
    hits.push(
      ...searchSources(
        {
          results: [
            { url: 'http://127.1/secret' },
            { url: 'https://name:pass@docs.example/x' },
            { url: 'https://hidden.local/x' },
            ...results,
          ],
        },
        seen,
        round
      )
    )
    assert.equal(
      searchSources({ results: [{ ...results[0], url: results[0].url + '#section' }] }, seen)
        .length,
      0
    )
  }
  assert.equal(hits.length, 72)
  const { messages, ids } = withSearchEvidence([{ role: 'user', content: '核对' }], 0, hits)
  const serialized = messages.at(-2).content.split('\n')[1]
  assert.ok(byteLength(serialized) <= 12 * 1024)
  assert.equal(ids.size, JSON.parse(serialized).length)
  assert.ok(ids.has('S1') && ids.has('S25') && ids.has('S49'))
  assert.doesNotMatch(serialized, /opaque-only|hidden\.local|127\.1|name:pass|�/)
})

test('text-only WorkBuddy rejects attachment requests before any search or planner dispatch', async () => {
  const start = calls.length
  const content = {
    ...comparison,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'document', source: { type: 'file', file_id: 'attachment-canary' } },
          { type: 'text', text: '请搜索一下' },
        ],
      },
    ],
  }
  await assert.rejects(drain(access, content), /Text messages only/)
  assert.equal(calls.length, start)
})

test('recent Chinese comparison follows each model to dated facts and selects the relevant passage after navigation', async () => {
  const start = calls.length
  const now = new Date(),
    month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const subjects = ['MiraLoop X2', 'Kubo Air']
  const query = subjects.map((name) => `${name} 国内售价`)
  const make = (key, title, snippet, date) => ({
    title,
    snippet,
    date,
    url: `https://${key}.example/story`,
    readKey: key,
  })
  const stale = make('old', 'MiraLoop X2 开箱', '发布会价格为 1499 元。'.repeat(8), '2021-01-12')
  const ad = make(
    'unrelated',
    '本网站使用条款',
    '注册登录关闭弹窗后查看全部新闻资讯与推荐活动。'.repeat(5),
    month + '-01'
  )
  const current = subjects.map((name, i) =>
    make(`shop${i}`, `${name} 国内售价更新`, `${name} 最新到手价见评测正文。`, month + '-01')
  )
  reply = ({ id, op, purpose, query: text, readKey }) => {
    if (purpose === 'search_plan') {
      return sendPlan(id, { queries: query, subjects, multi: false, read: false })
    }
    if (op === 'search') {
      return delivery(
        id,
        200,
        'application/json',
        JSON.stringify({
          results: text.includes(subjects[1]) ? [current[1]] : [ad, stale, current[0]],
        })
      )
    }
    if (op === 'read') {
      const idx = Number(readKey.slice(-1))
      const page =
        `首页 | 注册 | 登录 | 订阅\n`.repeat(140) +
        `\n${subjects[idx]} 国内售价 ${idx ? 799 : 999} 元，含税；活动截至 ${month}。`
      return delivery(id, 200, 'application/json', JSON.stringify({ text: page }))
    }
    if (op === 'chat') {
      return delivery(id, 200, 'text/event-stream', answer)
    }
  }
  await drain(access, {
    ...comparison,
    messages: [
      ...comparison.messages.slice(0, -1),
      { role: 'user', content: '那这两款最近在国内各卖多少钱？' },
    ],
  })
  const sent = calls.slice(start).filter((req) => req.op !== 'cancel')
  const searches = sent.filter((req) => req.op === 'search')
  assert.ok(
    searches.some((req) => req.query.includes(subjects[0])) &&
      searches.some((req) => req.query.includes(subjects[1]))
  )
  assert.ok(searches.every((req) => req.query.includes(month)))
  const reads = sent.filter((req) => req.op === 'read').map((req) => req.readKey)
  assert.deepEqual(new Set(reads), new Set(['shop0', 'shop1']))
  const ref = sent
    .at(-1)
    .messages.find((row) => row.content.startsWith('WorkBuddy search results')).content
  assert.match(ref, /999 元/)
  assert.match(ref, /799 元/)
})

test('empty web results cannot produce source citations from the model', async () => {
  let instruction
  reply = ({ id, op, messages }) => {
    if (op === 'search') {
      return delivery(id, 200, 'application/json', '{"results":[]}')
    }
    instruction = messages[0].content
    return delivery(
      id,
      200,
      'text/event-stream',
      'data: {"choices":[{"delta":{"content":"公开资料不足[S1]。"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
    )
  }
  const events = await drain(access, {
    ...body,
    tools: [searchTool],
    messages: [{ role: 'user', content: '公开资料' }],
  })
  assert.match(instruction, /No public evidence/)
  assert.equal(viewOf(events).answer.text, '公开资料不足。')
  assert.deepEqual(viewOf(events).sources, [])
})

test('variant names remain distinct and battery evidence retains playback conditions instead of storage numbers', async () => {
  const { assessHits, pagePassage, taskSignals } = await import('./quality.ts')
  const { searchSources } = await import('./search.ts')
  const focus = {
    signals: taskSignals('那这两款的续航呢？'),
    subjects: ['iPhone 15', 'iPhone 15 Plus'],
    queries: ['iPhone 15 续航', 'iPhone 15 Plus 续航'],
  }
  const hits = searchSources(
    {
      results: [
        { title: 'iPhone 15 Plus 技术规格', url: 'https://support.apple.com/zh-cn/111830' },
      ],
    },
    new Set()
  )
  assert.deepEqual(assessHits(hits, focus)[0].subjects, ['iPhone 15 Plus'])
  const body =
    'iPhone 15 Plus 技术规格 128 GB 256 GB 512 GB 显示屏。'.repeat(60) +
    '\n电源和电池\n视频播放：最长可达 26 小时\n流媒体视频播放：最长可达 20 小时\n'
  const excerpt = pagePassage(body, focus, 800)
  assert.match(excerpt, /视频播放：最长可达 26 小时/)
  assert.match(excerpt, /流媒体视频播放：最长可达 20 小时/)
})

test('two denied page reads use an available backup query once and label all remaining evidence as listings', async () => {
  const start = calls.length
  const subjects = ['红桥 A1', '青禾 B2']
  reply = ({ id, op, purpose, query }) => {
    if (purpose === 'search_plan') {
      return sendPlan(id, {
        subjects,
        queries: ['红桥 A1 青禾 B2 价格', '红桥 A1 青禾 B2 在售 报价'],
        read: false,
        multi: false,
      })
    }
    if (op === 'read') {
      return delivery(id, 403, 'application/json', '{"error":{"message":"reader denied"}}')
    }
    if (op === 'search') {
      const round = query.includes('在售') ? 1 : 0
      return delivery(
        id,
        200,
        'application/json',
        JSON.stringify({
          results: subjects.map((name, i) => ({
            title: name,
            snippet: `${name} 有公开的价格记录，详细的售价和生效日期见正文。`,
            url: `https://shop${i}.example/${round}`,
            readKey: `only-${i}`,
          })),
        })
      )
    }
    return delivery(id, 200, 'text/event-stream', answer)
  }
  await drain(access, {
    ...body,
    tools: [searchTool],
    messages: [{ role: 'user', content: '红桥 A1 和青禾 B2 现在各卖多少钱？' }],
  })
  const sent = calls.slice(start).filter((call) => call.op !== 'cancel')
  assert.deepEqual(
    sent.map((call) => call.op),
    ['chat', 'search', 'read', 'read', 'search', 'chat']
  )
  assert.match(sent.at(-1).messages[0].content, /4 source\(s\), 0 retrieved page excerpt/)
})

// Synthetic response frames. Product names and route IDs come from Tencent's shipped catalog.
test('Hunyuan receipts keep the exact chat/title request while validating specific backend identities', async (t) => {
  const { setWorkBuddyCatalog } = await import('./models.ts')
  const catalog = ['hy3', 'hy3-x', 'hy3-preview', 'hy4-preview', 'hy4-preview-x', 'hy4-flash', 'hy4', 'hunyuan-chat', 'glm-5.3']
  setWorkBuddyCatalog(catalog.map(id => ({ id, name: id })))
  t.after(() => setWorkBuddyCatalog(null))
  const sse = (...frames) => frames.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n'
  const completion = model => ({ model, choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }] })
  for (const [requested, returned, purpose, originModel] of [
    ['hy3', 'Hy3', 'chat'], ['hy3', 'hy3-202608', 'chat'], ['hy4', 'Hy4', 'chat'],
    ['hy4-flash', 'Hy4 flash', 'chat'], ['hy4-preview', 'Hy4 preview', 'title'],
    ['hunyuan-chat', 'Hunyuan-Turbos', 'chat'], ['hy3-x', 'hy3-x', 'chat'],
    ['hy3-x', 'hy-deploy-42', 'chat', 'hy-deploy-42'],
  ]) {
    const start = calls.length
    reply = ({ id, op }) => {
      if (op !== 'chat') {return}
      frame(id, { type: 'headers', status: 200, contentType: 'text/event-stream', originModel })
      const text = sse({ model: '', choices: [{ delta: { role: 'assistant' } }] }, completion(returned),
        { model: '', choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } })
      frame(id, { type: 'data', data: Buffer.from(text).toString('base64') })
      frame(id, { type: 'end' })
    }
    const limit = purpose === 'title' ? { max_tokens: 48 } : {}
    const events = await Array.fromAsync(streamMessage({ ...access, model: requested }, { ...body, ...limit }, new AbortController().signal, undefined, purpose))
    assert.deepEqual(calls.slice(start).filter(x => x.op !== 'cancel').map(x => [x.op, x.model, x.revision, x.max_tokens]),
      [['chat', requested, revision, limit.max_tokens]])
    assert.equal(events[0].message.model, requested)
    assert.equal(events.at(-2).workBuddyResponseModel, requested === returned ? undefined : returned)
    assert.equal(events.at(-2).usage.output_tokens, 3)
    assert.equal(events.at(-1).type, 'message_stop')
  }
  for (const [requested, returned] of [
    ['hy3', 'hy3-x'], ['hy3-x', 'hy3'], ['hy3-x', 'Hy3'], ['hy3', 'hy3-preview'],
    ['hy4-preview-x', 'hy4-preview'], ['hy4', 'hy4-flash'], ['hy4-preview', 'glm-5.3'],
    ['hy3', 'hy3-unknown'], ['hy3', 'hy3-202701'], ['hy3', { model: 'hy3' }], ['hy3', 'Bearer private-canary'],
  ]) {
    const start = calls.length
    respond(200, sse(completion(requested), { model: returned, choices: [], usage: { completion_tokens: 999 } }))
    const received = []
    await assert.rejects(async () => {
      for await (const event of streamMessage({ ...access, model: requested }, body, new AbortController().signal)) {received.push(event)}
    }, error => error.message.includes(`Model mismatch (${requested} → `) && !error.message.includes('private-canary'))
    assert.equal(received.some(x => x.type === 'message_stop' || x.usage?.output_tokens === 999), false)
    assert.equal(calls.slice(start).filter(x => x.op === 'chat').length, 1)
  }
})

test('a planner mismatch or quota refusal stops before any subsequent search or model dispatch', async () => {
  for (const [status, media, text, expected] of [
    [200, 'text/event-stream', 'data: {"model":"hy4-preview","choices":[],"usage":{"completion_tokens":999}}\n\n', /Model mismatch \(deepseek-v4\.1-flash → hy4-preview\)/],
    [200, 'text/event-stream', 'event: error\ndata: {"model":"gateway","error":{"code":6004,"message":"quota"}}\n\n', /6004.*quota/],
    [429, 'application/json', '{"code":6004,"msg":"quota"}', /HTTP 429.*6004.*quota/],
    [200, 'application/json', '{"code":6004,"msg":"quota"}', /HTTP 200.*6004.*quota/],
  ]) {
    const start = calls.length
    reply = ({ id, purpose }) => {
      if (purpose === 'search_plan') {delivery(id, status, media, text)}
    }
    await assert.rejects(drain(access, comparison), expected)
    assert.deepEqual(calls.slice(start).filter(call => call.op !== 'cancel').map(call => [call.op, call.purpose]), [['chat', 'search_plan']])
  }
})

test('model quota refusals still reach the chat for both HTTP and SSE', async () => {
  const rejection = { code: 6004, msg: '本模型已达到限额' }
  respond(429, JSON.stringify(rejection), 'application/json')
  await assert.rejects(drain(access), /6004.*本模型已达到限额/)
  respond(200, 'event: error\ndata: ' + JSON.stringify(rejection) + '\n\n')
  await assert.rejects(drain(access), /6004.*本模型已达到限额/)
})
