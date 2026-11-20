// Exercise the composer/store and production protocol adapters. Only IndexedDB, browser APIs
// and native/network responses are fixtures. No real account or external request is used.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { experiments } from '@rspack/core'

registerHooks({
  resolve(id, ctx, next) {
    if (id === 'idb' && ctx.parentURL?.endsWith('/usage/ledger.ts')) {
      return {
        url: 'data:text/javascript,export const openDB = async () => globalThis.__usageDB',
        shortCircuit: true,
      }
    }
    if (id.startsWith('.') && id.endsWith('.js') && ctx.parentURL) {
      const url = new URL(id.slice(0, -3) + '.ts', ctx.parentURL)
      if (existsSync(url)) {
        return next(url.href, ctx)
      }
    }
    return next(id, ctx)
  },
  load(url, ctx, next) {
    if (url.endsWith('/chat/db.ts')) {
      return {
        shortCircuit: true,
        format: 'module',
        source: `
      export const {loadSession, loadSessionSummaries, renameSession, deleteSession, saveSession, clearStaging, commitStaging} = globalThis.__titleDB;
      export const reportStorageError = () => error => { throw error };
    `,
      }
    }
    if (!url.endsWith('.ts')) {
      return next(url, ctx)
    }
    const filename = fileURLToPath(url)
    const { code } = experiments.swc.transformSync(readFileSync(filename, 'utf8'), {
      filename,
      jsc: { parser: { syntax: 'typescript' }, target: 'es2022' },
      module: { type: 'es6' },
    })
    return { shortCircuit: true, format: 'module', source: code }
  },
})
const disk = new Map(),
  settingsDisk = new Map(),
  transports = []
let duringRead, sendResponse
const summary = ({ id, title, titleSource, createdAt, updatedAt }) => ({
  id,
  title,
  titleSource,
  createdAt,
  updatedAt,
})
globalThis.__titleDB = {
  loadSession: async (id) => {
    const snapshot = structuredClone(disk.get(id))
    await duringRead?.()
    return snapshot
  },
  loadSessionSummaries: async () => [...disk.values()].map(summary),
  saveSession: async (s) => {
    disk.set(s.id, structuredClone(s))
  },
  deleteSession: async (id) => {
    disk.delete(id)
  },
  renameSession: async (id, title) => {
    Object.assign(disk.get(id), { title, titleSource: 'manual' })
  },
  clearStaging: async () => {},
  commitStaging: async () => [...disk.values()].map(summary),
}
globalThis.localStorage = {
  getItem: (k) => settingsDisk.get(k) ?? null,
  setItem: (k, v) => settingsDisk.set(k, v),
  removeItem: (k) => settingsDisk.delete(k),
}
globalThis.__API_ORIGIN__ = 'https://api.deepseek.com'
const sse = (text) => new Response(text, { headers: { 'content-type': 'text/event-stream' } })
const openAI = (text, finish_reason = 'stop', usage) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason }] })}\n\n` +
  (usage ? `data: ${JSON.stringify({ choices: [], usage })}\n\n` : '') +
  'data: [DONE]\n\n'
const native = (title, text = 'actual answer', stop_reason = 'end_turn', usage) =>
  [
    ...(usage ? [{ type: 'message_start', message: { usage: usage.start } }] : []),
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text },
    },
    { type: 'message_delta', delta: { stop_reason, title }, usage: usage?.final },
    { type: 'message_stop' },
  ]
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join('')
globalThis.fetch = async (url, init) => {
  const call = {
    channel: 'api',
    body: JSON.parse(init.body),
    url,
    headers: init.headers,
    signal: init.signal,
  }
  transports.push(call)
  return sendResponse(call)
}
// Account transport encodes the JSON request as base64; WorkBuddy uses its own fixed native port.
globalThis.FileReader = class {
  async readAsDataURL(blob) {
    this.result = `data:;base64,${Buffer.from(await blob.arrayBuffer()).toString('base64')}`
    this.onload?.()
    this.onloadend?.()
  }
}
function bridge(channel) {
  const port = {
    postMessage(raw) {
      const request = JSON.parse(raw)
      if (request.op === 'status' || request.op === 'cancel') {
        return
      }
      const body =
        channel === 'account' ? JSON.parse(Buffer.from(request.body, 'base64').toString()) : request
      const call = { channel, body, path: request.path }
      transports.push(call)
      void (async () => {
        const res = await sendResponse(call)
        const emit = (fields) =>
          port.onmessage({ data: JSON.stringify({ id: request.id, ...fields }) })
        emit({ type: 'headers', status: res.status, contentType: res.headers.get('content-type') })
        emit({
          type: 'data',
          [channel === 'account' ? 'base64' : 'data']: Buffer.from(await res.text()).toString(
            'base64'
          ),
        })
        emit({ type: 'end' })
      })()
    },
  }
  return port
}
globalThis.window = Object.assign(new EventTarget(), {
  WorkBuddyChat: bridge('workbuddy'),
  DshNative: bridge('account'),
})
// Production request accounting and readback run against an already-migrated, in-memory store.
const usageRows = new Map()
globalThis.indexedDB = {}
globalThis.__usageDB = {
  get: async (table, key) => table === 'meta' && key === 'legacy',
  put: async (table, row) => {
    assert.equal(table, 'requests')
    usageRows.set(row.id, structuredClone(row))
  },
  getAll: async (table) => {
    assert.equal(table, 'requests')
    return Array.from(usageRows.values(), (row) => structuredClone(row))
  },
}
const { readUsageLedger } = await import('../usage/ledger.ts')
const ledger = () => readUsageLedger(new AbortController().signal)
const { useSettings } = await import('../settings.ts')
const store = await import('./store.ts')
const { setDraftText } = await import('./drafts.ts')
const { useWorkBuddyState } = await import('../workbuddy/provider.ts')
const { initializeAccount } = await import('../../shell/account.ts')
const { addMemory, setMemoryEnabled } = await import('../library/index.ts')
const { questionTopic, providerTitle } = await import('./titles.ts')
initializeAccount(() => {})
const a = {
  id: 'a',
  name: 'A',
  origin: 'https://a.invalid/v1',
  protocol: 'openai',
  model: 'pinned-model',
  apiKey: 'a-fixture-key',
}
const b = {
  ...a,
  id: 'b',
  origin: 'https://b.invalid/v1',
  model: 'different-model',
  apiKey: 'b-fixture-key',
}
const wb = { model: 'deepseek-v4-pro', revision: '01234567-89ab-4cde-abcd-0123456789ab' }
const long =
  'Please compare the weekend hiking routes around Hangzhou, including short accessible trails, transit connections, and public viewpoints. '.repeat(
    4
  )
const state = store.useChatStore.getState
function configure(source) {
  store.newChat()
  useSettings.setState({
    chatSource: source,
    apiProfiles: [a, b],
    activeProfileId: a.id,
    apiKey: a.apiKey,
    accountSignedIn: true,
    search: false,
    thinking: false,
    locale: 'zh-CN',
  })
  useWorkBuddyState.setState({ metadata: wb })
  transports.length = 0
}
function enter(text, id = null) {
  setDraftText(id, text)
  assert.equal(store.sendMessage(id), true)
  return id ?? state().activeId
}
function title(id) {
  const value = state().sessionCache[id].title
  assert.equal(state().sessions.find((s) => s.id === id).title, value, 'header and history list')
  return value
}
async function until(check) {
  if (check()) {
    return
  }
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stop()
      reject(Error('timed out waiting for chat state'))
    }, 2500)
    const stop = store.useChatStore.subscribe(() => {
      if (check()) {
        clearTimeout(timer)
        stop()
        resolve()
      }
    })
  })
}
const idle = (id) => until(() => !state().streaming[id])
await store.initChat()

for (const channel of ['account', 'api']) {
  test(`native title wins on the first normal ${channel} request only`, async () => {
    configure(channel)
    if (channel === 'api') {
      useSettings.setState({
        apiProfiles: [{ ...a, protocol: 'deepseek', model: 'deepseek-v4-pro' }],
      })
    }
    const gate = Promise.withResolvers()
    sendResponse = async () => {
      await gate.promise
      return sse(native('杭州徒步路线'))
    }
    const id = enter('你好，请帮我规划杭州周末徒步路线。')
    assert.equal(title(id), '规划杭州周末徒步路线')
    gate.resolve()
    await idle(id)
    assert.equal(title(id), '杭州徒步路线')
    assert.equal(disk.get(id).title, title(id))
    assert.equal(transports[0].channel, channel)
    assert.deepEqual(transports[0].body.title, { enabled: true })
    assert.equal(
      transports[0].path ?? new URL(transports[0].url).pathname,
      channel === 'account' ? '/anthropic/v1/messages' : '/v1/anthropic/v1/messages'
    )
    enter('下周呢？', id)
    await idle(id)
    assert.equal(transports.length, 2)
    assert.equal(transports[1].body.title, undefined)
    assert.equal(title(id), '杭州徒步路线')
  })
}

test('manual rename beats a delayed native delta, even to the literal placeholder', async () => {
  configure('account')
  const gate = Promise.withResolvers()
  sendResponse = async () => {
    await gate.promise
    return sse(native('延迟的标题'))
  }
  const id = enter('南京一日游')
  store.renameSession(id, '新对话')
  gate.resolve()
  await idle(id)
  assert.equal(title(id), '新对话')
  assert.equal(disk.get(id).titleSource, 'manual')
})

for (const channel of ['api', 'workbuddy']) {
  test(`${channel} refines one long first turn asynchronously on its pinned model only`, async () => {
    configure(channel)
    const before = new Set((await ledger()).map((row) => row.id))
    const answer = Promise.withResolvers(),
      generated = Promise.withResolvers(),
      requested = Promise.withResolvers()
    sendResponse = async (call) => {
      if (call.body.max_tokens) {
        requested.resolve(call)
        await generated.promise
        return sse(openAI('Hangzhou weekend hiking routes'))
      }
      await answer.promise
      return sse(openAI('Fixture answer that must stay out of title requests'))
    }
    addMemory('MEMORY for the answer only')
    setMemoryEnabled(null, true)
    const id = enter(long),
      initialTitle = title(id)
    assert.match(initialTitle, /weekend hiking routes/)
    assert.equal(disk.get(id).title, initialTitle)
    await nextTurn()
    assert.equal(transports.length, 1)
    useSettings.setState({ chatSource: 'api', activeProfileId: b.id, apiKey: b.apiKey })
    answer.resolve()
    await idle(id)
    const call = await requested.promise
    assert.equal(title(id), initialTitle)
    assert.equal(call.channel, channel)
    assert.equal(call.body.max_tokens, 48)
    assert.deepEqual(
      call.body.messages.map((m) => m.role),
      ['system', 'user']
    )
    assert.equal([...call.body.messages[1].content].length, 320)
    assert.doesNotMatch(JSON.stringify(call.body.messages), /MEMORY|Fixture answer|fixture-key/)
    if (channel === 'api') {
      assert.equal(call.body.model, a.model)
      assert.equal(call.url, a.origin + '/chat/completions')
      assert.equal(call.headers.Authorization, 'Bearer ' + a.apiKey)
    } else {
      assert.equal(call.body.model, wb.model)
      assert.equal(call.body.revision, wb.revision)
      assert.equal(call.body.thinking, false)
      assert.equal(call.body.op, 'chat')
    }
    // Finish a follow-up first; the foreground reply and the separate title have independent lifetimes.
    enter('Another question', id)
    await idle(id)
    assert.equal(transports.length, 3)
    generated.resolve()
    await until(() => title(id) === 'Hangzhou weekend hiking routes')
    await nextTurn()
    assert.equal(disk.get(id).title, title(id))
    assert.equal(disk.get(id).messages.length, 4)
    store.regenerateReply(id)
    await idle(id)
    assert.equal(transports.filter((c) => c.body.max_tokens).length, 1)
    const receipts = (await ledger()).filter((row) => !before.has(row.id))
    assert.deepEqual(receipts.map((row) => row.purpose).sort(), [
      'chat',
      'chat',
      'regenerate',
      'title',
    ])
    assert.equal(receipts.find((row) => row.purpose === 'title').model, call.body.model)
  })
}

for (const action of ['rename', 'delete', 'grant change', 'replace history', 'HTTP failure']) {
  test(`late compatible title after ${action} cannot overwrite newer state`, async () => {
    configure('api')
    const generated = Promise.withResolvers(),
      requested = Promise.withResolvers()
    sendResponse = async (call) => {
      if (!call.body.max_tokens) {
        return sse(openAI('Answer'))
      }
      requested.resolve(call)
      await generated.promise
      return action === 'HTTP failure'
        ? new Response(null, { status: 503 })
        : sse(openAI('A late title'))
    }
    const id = enter(long),
      fallback = title(id)
    await idle(id)
    const call = await requested.promise
    if (action === 'rename') {
      store.renameSession(id, fallback)
    } // same string still locks ownership
    if (action === 'delete') {
      assert.equal(await store.removeSession(id), true)
    }
    if (action === 'grant change') {
      useSettings.setState({ apiProfiles: [{ ...a, apiKey: 'changed' }, b] })
    }
    if (action === 'replace history') {
      await store.replaceHistory(async () => {
        disk.set(id, { id, title: 'Imported', messages: [], createdAt: 10, updatedAt: 10 })
      })
    }
    generated.resolve()
    await nextTurn()
    await nextTurn()
    if (action === 'delete') {
      assert.equal(state().sessionCache[id], undefined)
      assert.equal(disk.has(id), false)
    } else if (action === 'replace history') {
      assert.equal(state().sessionCache[id], undefined)
      assert.equal(disk.get(id).title, 'Imported')
    } else {
      assert.equal(title(id), fallback)
      assert.equal(disk.get(id).title, fallback)
    }
    if (['rename', 'delete', 'replace history'].includes(action)) {
      assert.equal(call.signal.aborted, true)
    }
    assert.equal(transports.length, 2)
    if (action === 'HTTP failure') {
      enter(long, id)
      await idle(id)
      assert.equal(transports.length, 3)
    }
  })
}

const user = (id, content, files = []) => ({ id, role: 'user', createdAt: 1, content, files })
const answer = (id) => ({
  id,
  role: 'assistant',
  createdAt: 2,
  prefix: true,
  model: null,
  status: 'done',
  blocks: [{ type: 'text', text: 'previous answer' }],
})
test('opening upgraded unbound multi-turn history repairs only missing titles locally and preserves sort order', async () => {
  configure('api')
  sendResponse = () => assert.fail('Opening history dispatched a model request')
  const rows = ['', '新对话', 'New chat', 'A manual topic'].map((s, i) => ({
    id: `legacy-${i}`,
    title: s,
    createdAt: 1,
    updatedAt: 10 + i,
    messages: [
      user('a', '你好'),
      answer('b'),
      user('c', '请帮我比较西湖春季徒步路线'),
      answer('d'),
    ],
  }))
  await store.replaceHistory(async () => {
    disk.clear()
    for (const row of rows) {
      disk.set(row.id, row)
    }
  })
  const order = state().sessions.map((s) => s.id)
  for (const row of rows) {
    store.selectSession(row.id)
    await until(() => state().sessionCache[row.id])
    await nextTurn()
    assert.equal(title(row.id), row.title === 'A manual topic' ? row.title : '比较西湖春季徒步路线')
    assert.equal(disk.get(row.id).title, title(row.id))
    assert.equal(disk.get(row.id).updatedAt, row.updatedAt)
  }
  assert.deepEqual(
    state().sessions.map((s) => s.id),
    order
  )
  assert.equal(transports.length, 0)
})

test('an uncached rename during a stale load survives reopen and archive round trip', async () => {
  const row = {
    id: 'manual-upgrade',
    title: '新对话',
    createdAt: 1,
    updatedAt: 5,
    messages: [user('a', '历史问题'), answer('b')],
  }
  await store.replaceHistory(async () => {
    disk.set(row.id, row)
  })
  const gate = Promise.withResolvers()
  duringRead = () => gate.promise
  store.selectSession(row.id)
  store.renameSession(row.id, 'New chat')
  gate.resolve()
  await until(() => state().sessionCache[row.id])
  duringRead = undefined
  assert.equal(title(row.id), 'New chat')
  assert.equal(state().sessionCache[row.id].titleSource, 'manual')
  const { toSessionFile } = await import('./history/toArchive.ts'),
    { toLocalSession } = await import('./history/toLocal.ts'),
    { readSessionFile } = await import('./history/schema.ts')
  const archive = toSessionFile(disk.get(row.id), () => null)
  const restored = toLocalSession(readSessionFile(archive)).session
  assert.equal(restored.title, 'New chat')
  assert.equal(restored.titleSource, 'manual')
})

test('short topics, sensitive questions, files and unavailable answers spend no title call', async () => {
  configure('api')
  sendResponse = async () => sse(openAI('Answer'))
  const id = enter('Hello')
  await idle(id)
  assert.equal(title(id), 'Conversation')
  enter('Please compare hiking routes in Hangzhou', id)
  await idle(id)
  assert.equal(title(id), 'compare hiking routes in Hangzhou')
  for (const content of [
    '密码：secret123',
    'Read https://example.invalid/path?a=privatedata',
    'const value = "some local data"',
    'How about sk-fixture123456',
    'a'.repeat(40),
  ]) {
    const topic = questionTopic(user('s', content), 'en-US')
    assert.ok(topic.provisional)
    assert.equal(topic.excerpt, '')
    assert.doesNotMatch(topic.title, /secret123|privatedata|some local data|sk-fixture|a{20}/)
  }
  const file = { name: 'private-client-file.pdf', serverId: 'file-private' }
  assert.deepEqual(questionTopic(user('z', '', [file]), 'zh-CN'), {
    title: '附件讨论',
    provisional: true,
    excerpt: '',
  })
  assert.equal(questionTopic(user('z', long, [file]), 'en-US').excerpt, '')
  assert.equal(providerTitle('Here is a title\nother line', 'test'), '')
  assert.equal(providerTitle('sk-fixture123', 'test'), '')
  store.newChat()
  sendResponse = async () => new Response(null, { status: 503 })
  const failed = enter(long)
  await idle(failed)
  assert.equal(disk.get(failed).messages.at(-1).status, 'error')
  assert.equal(transports.length, 3)
})

// Run the same branch operations against all three real encoders using one model ID.
const { getVisibleMessages } = await import('./branches.ts')
const { getReplyText } = await import('./reply.ts')
for (const channel of ['account', 'api', 'workbuddy']) {
  test(`${channel} continues the truncated answer and preserves regenerate/edit branches`, async () => {
    configure(channel)
    const { setConversationMode } = await import('../conversationMode/storage.ts')
    setConversationMode(null, { model: 'deepseek-v4-pro' })
    const original = 'One and',
      suffix = ' two.'
    let text = original,
      clipped = true
    const priorReceipts = new Set((await ledger()).map((row) => row.id))
    sendResponse = async () => {
      const turn = transports.length
      // The edit returns no usage. All three other sends report the same fully counted values.
      const usage = turn < 4 && {
        start: { input_tokens: 10 + turn, cache_read_input_tokens: 2, output_tokens: 0 },
        final: { output_tokens: turn * 2 - 1, cache_read_output_tokens: 1 },
        compatible: {
          prompt_tokens: 12 + turn,
          prompt_tokens_details: { cached_tokens: 2 },
          completion_tokens: 2 * turn,
          completion_tokens_details: { cached_tokens: 1 },
        },
      }
      return sse(
        channel === 'account'
          ? native('', text, clipped ? 'max_tokens' : 'end_turn', usage)
          : openAI(text, clipped ? 'length' : 'stop', usage?.compatible)
      )
    }
    const id = enter('Count to two')
    await idle(id)
    const visible = () => getVisibleMessages(state().sessionCache[id])
    const [question, first] = visible()
    assert.equal(first.stopReason, 'max_tokens')
    assert.equal(store.canResumeReply(id, first), true)
    const archive = (await import('./history/toArchive.ts')).toSessionFile(disk.get(id), () => null)
    const validated = (await import('./history/schema.ts')).readSessionFile(archive)
    const restored = (await import('./history/toLocal.ts'))
      .toLocalSession(validated)
      .session.messages.at(-1)
    assert.equal(restored.stopReason, 'max_tokens')
    assert.equal(restored.prefix, 'text')
    assert.equal(store.canResumeReply(id, restored), true)
    text = suffix
    clipped = false
    store.continueReply(id, first.id)
    await idle(id)
    const sent = transports.at(-1).body.messages
    if (channel === 'account') {
      assert.equal(sent.at(-1).role, 'assistant')
      assert.match(JSON.stringify(sent.at(-1).content), /One and/)
    } else {
      assert.deepEqual(sent.at(-2), { role: 'assistant', content: original })
      assert.equal(sent.at(-1).role, 'user')
      assert.match(sent.at(-1).content, /continue.*remaining text/i)
    }
    assert.equal(visible().at(-1).id, first.id)
    assert.equal(getReplyText(visible().at(-1)), original + suffix)
    assert.equal(visible().length, 2)
    assert.equal(store.canResumeReply(id, visible().at(-1)), false)
    text = 'Second version.'
    store.regenerateReply(id, first.id)
    await idle(id)
    assert.equal(visible()[0].id, question.id)
    assert.notEqual(visible()[1].id, first.id)
    assert.equal(getReplyText(visible()[1]), text)
    assert.equal(transports.at(-1).body.messages.at(-1).content, question.content)
    text = 'New question answer.'
    assert.equal(store.editMessage(id, question.id, 'Count to four'), true)
    await idle(id)
    assert.equal(visible()[0].content, 'Count to four')
    assert.equal(transports.at(-1).body.messages.at(-1).content, 'Count to four')
    store.selectMessageVersion(id, question.id)
    store.selectMessageVersion(id, first.id)
    assert.equal(getReplyText(visible()[1]), original + suffix)
    assert.equal(transports.length, 4)
    assert.ok(transports.every((call) => call.body.model === 'deepseek-v4-pro'))
    assert.doesNotMatch(JSON.stringify(disk.get(id)), /remaining text/)
    assert.doesNotMatch(JSON.stringify(archive), /usageLedger|inputHit|outputHit|fixture-key/)
    assert.ok(
      disk
        .get(id)
        .messages.filter((m) => m.role === 'assistant')
        .every((m) => m.usageLedger === true)
    )
    const rows = (await ledger()).filter((row) => !priorReceipts.has(row.id))
    assert.equal(rows.length, 4)
    assert.deepEqual(rows.map((row) => row.purpose).sort(), [
      'chat',
      'chat',
      'continue',
      'regenerate',
    ])
    const provider = { account: 'DeepSeek account', api: 'a.invalid', workbuddy: 'WorkBuddy' }[
      channel
    ]
    assert.ok(
      rows.every(
        (row) =>
          row.model === 'deepseek-v4-pro' && row.provider === provider && row.status === 'done'
      )
    )
    for (const [index, purpose] of ['chat', 'continue', 'regenerate'].entries()) {
      const turn = index + 1
      const row = rows.find((row) => row.purpose === purpose && row.input !== undefined)
      assert.deepEqual(
        [row?.input, row?.output, row?.inputHit, row?.outputHit],
        [12 + turn, 2 * turn, 2, 1]
      )
    }
    const editReceipt = rows.find((row) => row.purpose === 'chat' && row.input === undefined)
    assert.ok(editReceipt)
    assert.equal(editReceipt.output, undefined)
    assert.equal(editReceipt.inputHit, undefined)
    assert.equal(editReceipt.outputHit, undefined)
    assert.doesNotMatch(
      JSON.stringify(rows),
      /fixture-key|Count to|One and|Second version|remaining text/
    )
  })
}

test('restored WorkBuddy continuation never searches its internal prompt and keeps mid-word answers intact', async () => {
  configure('workbuddy')
  const { toSessionFile } = await import('./history/toArchive.ts')
  const { toLocalSession } = await import('./history/toLocal.ts')
  const partial = {
    ...answer('partial'),
    search: true,
    thinking: true,
    stopReason: 'max_tokens',
    blocks: [{ type: 'text', text: 'The inter' }],
  }
  const previous = {
    id: 'restore-search',
    title: 'Network',
    createdAt: 1,
    updatedAt: 2,
    messages: [user('question', 'Explain the internet'), partial],
  }
  const restored = toLocalSession(toSessionFile(previous, () => null)).session
  await store.replaceHistory(async () => {
    disk.set(restored.id, restored)
  })
  store.selectSession(restored.id)
  await until(() => state().sessionCache[restored.id])
  const visible = () => getVisibleMessages(state().sessionCache[restored.id])
  assert.equal(visible().at(-1).search, true)
  sendResponse = async (call) => {
    assert.equal(call.body.op, 'chat')
    assert.match(call.body.messages.at(-1).content, /only the remaining text/)
    return sse(
      'data: {"choices":[{"delta":{"reasoning_content":"Finish the word."}}]}\n\n' +
        openAI('net connects networks.')
    )
  }
  store.continueReply(restored.id, visible().at(-1).id)
  await idle(restored.id)
  const reply = visible().at(-1)
  assert.equal(reply.status, 'done')
  assert.equal(transports.length, 1)
  assert.ok(
    reply.blocks.some((block) => block.type === 'thinking' && block.thinking === 'Finish the word.')
  )
  const { buildReplyView } = await import('./view.ts')
  assert.equal(buildReplyView(reply, false).answer.text, 'The internet connects networks.')
  sendResponse = async () => sse(openAI('Yes.'))
  enter('Is this correct?', restored.id)
  await idle(restored.id)
  assert.equal(
    transports.at(-1).body.messages.find((row) => row.role === 'assistant').content,
    'The internet connects networks.'
  )
})

test('empty, template, tool, and reasoning-only compatible answers cannot restart the original request as a continuation', async () => {
  configure('api')
  for (const blocks of [
    [],
    [{ type: 'text', text: ' ' }],
    [{ type: 'thinking', thinking: 'hidden' }],
    [{ type: 'text', text: 'a', isTemplate: true }],
    [{ type: 'server_tool_use' }, { type: 'text', text: 'partial' }],
  ]) {
    const reply = { ...answer('a'), status: 'stopped', blocks }
    assert.equal(store.canResumeReply('fixture', reply), false)
  }
  const interrupted = (await import('./describe.ts')).describeReply({
    ...answer('a'),
    status: 'error',
    error: { kind: 'interrupted', message: '' },
  })
  assert.ok(interrupted?.text.trim())
})

test('Claude composer, title and compaction keep the exact profile model and three separate receipts', async () => {
  configure('api')
  const model = 'claude-sonnet-4-5-20250929'
  const origin = 'https://api.anthropic.com/v1'
  useSettings.setState({ apiProfiles: [{ ...a, origin, protocol: 'anthropic', model }] })
  const previous = new Set((await ledger()).map(row => row.id))
  const generatedTitle = 'Hangzhou weekend hiking routes'
  const checkpoint = 'Weekend hikes in Hangzhou.'
  const sample = { start: { input_tokens: 12, cache_creation_input_tokens: 8, cache_read_input_tokens: 4 }, final: { output_tokens: 6 } }
  sendResponse = async ({ body, url, headers }) => {
    assert.equal(url, origin + '/messages')
    assert.equal(headers['x-api-key'], a.apiKey)
    assert.equal(body.model, model)
    assert.equal(body.title, undefined)
    assert.equal(body.safety_check, undefined)
    const text = body.max_tokens === 48 ? generatedTitle : body.system?.startsWith('Summarize') ? checkpoint : long
    return sse(native(undefined, text, 'end_turn', sample))
  }
  const id = enter(long)
  await idle(id)
  await until(() => title(id) === generatedTitle)
  const { compactSession } = await import('./compact.ts')
  const compacted = await compactSession(id, { automatic: true })
  assert.equal(compacted.ok, true, compacted.message)
  assert.match(state().sessionCache[id].checkpoint.text, /Weekend hikes/)
  const rows = (await ledger()).filter(row => !previous.has(row.id))
  assert.deepEqual(rows.map(row => row.purpose).sort(), ['chat', 'summary', 'title'])
  assert.ok(rows.every(row => row.model === model && row.input === 24 && row.output === 6 && row.inputHit === 4 && row.cacheWrite === 8 && row.status === 'done'))
})
