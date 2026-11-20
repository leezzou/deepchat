// Run: node --test src/services/chat/contextFeature.test.mjs (Node 24+).
// Native module hooks mock network/storage only; the chat, request and compaction code is real.
import assert from 'node:assert/strict'
import { test, beforeEach } from 'node:test'
import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const storage = new Map()
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value),
}
const fixture = (globalThis.__contextTest = {
  settings: {
    apiKey: 'test',
    apiProfiles: [{ id: 'p', contextWindow: 10000 }],
    activeProfileId: 'p',
    thinking: false,
    search: false,
    locale: 'en-US',
  },
  config: { protocol: 'openai', model: 'test-model', origin: 'https://test.invalid' },
  records: [],
  sessions: new Map(),
  requests: [],
  stream: null,
  save: null,
  draft: null,
})
const mocks = new Map(
  Object.entries({
    '/services/settings.ts': `export const useSettings = { getState: () => globalThis.__contextTest.settings }; export const setChatSource = (source) => { globalThis.__contextTest.settings.chatSource = source }`,
    '/services/api/origin.ts': `export const defaultApiModel="deepseek-flash", defaultApiOrigin="https://api.deepseek.com"; export const getApiConfig = () => globalThis.__contextTest.config`,
    '/services/api/client.ts': `export class ApiError extends Error { constructor(kind,message,status) { super(typeof message === 'string' ? message : message.key); this.kind=kind; this.status=status; this.localMessage=typeof message==='object'?message:undefined } } export const streamMessage = (...args) => globalThis.__contextTest.stream(...args)`,
    '/services/api/errors.ts': `export const extractFileIds=()=>[]; export const getFileErrorCode=()=>null; export const isRetryableApiError=()=>false; export const isContextOverflow=()=>false`,
    '/services/attachments.ts': `export const cancelUpload=()=>{}; export const describeUploadError=()=>({key:'upload'}); export const uploadAttachment=async()=>null; export const useUploads={getState:()=>({tasks:{}})}`,
    '/services/chat/db.ts': `export const saveSession=async(session)=>{ globalThis.__contextTest.records.push(session); if(globalThis.__contextTest.save) await globalThis.__contextTest.save(session) }; export const reportStorageError=()=>()=>{}; export const loadSession=async(id)=>globalThis.__contextTest.sessions.get(id); export const loadFile=async()=>null; export const clearStaging=async()=>{}; export const commitStaging=async()=>[]`,
    '/services/chat/drafts.ts': `export const clearAllDrafts=()=>{}; export const clearDraft=()=>{}; export const clearSentDraft=()=>{}; export const getDraft=()=>globalThis.__contextTest.draft; export const prepareDraftMessage=(draft)=>draft`,
    '/services/chat/latestReminder.ts': `export const createLatestReminder=()=> 'Current test reminder'`,
    '/services/chat/compactionIndex.ts': `export const recordCompaction=()=>{}`,
    '/i18n/index.ts': `export const translate=(key)=>key; export const resolveLocale=()=> 'en-US'`,
  })
)
registerHooks({
  resolve(specifier, context, next) {
    if (
      specifier.startsWith('.') &&
      specifier.endsWith('.js') &&
      context.parentURL?.includes('/src/')
    ) {
      const url = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (existsSync(url)) {
        return next(url.href, context)
      }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url.startsWith('file:')) {
      const path = fileURLToPath(url)
      for (const [suffix, source] of mocks) {
        if (path.endsWith(suffix)) {
          return { format: 'module', source, shortCircuit: true }
        }
      }
    }
    return next(url, context)
  },
})
const { getEffectiveContext, getContextRounds, toRequestMessages } = await import('./reply.ts')
const { buildMessageDeletion, previewMessageDeletion } = await import('./contextDeletion.ts')
const { getVisibleMessages, appendBranch } = await import('./branches.ts')
const { compactSession, contextWindowTokens, sessionContextTokens } = await import('./compact.ts')
const { splitContextText, estimateRequestTokens, indexRequestFiles, requestFileLimit } =
  await import('./contextBudget.ts')
const { createContextBatcher } = await import('./contextStreamBatcher.ts')
const { useContextPreferences } = await import('./contextPreferences.ts')
const store = await import('./store.ts')
const { useChatStore } = store
let serial = 0
const user = (id, content = 'question') => ({ id, role: 'user', content, files: [], createdAt: 1 })
const assistant = (id, text = 'answer') => ({
  id,
  role: 'assistant',
  blocks: [{ type: 'text', text }],
  status: 'done',
  stopReason: 'end_turn',
  prefix: true,
  model: 'deepseek-flash',
  createdAt: 1,
})
const session = (messages, extra = {}) => ({
  id: `s${++serial}`,
  title: 'test',
  createdAt: 1,
  updatedAt: 1,
  messages,
  ...extra,
})
const mount = (value) =>
  useChatStore.setState({
    sessionCache: { [value.id]: value },
    sessions: [value],
    activeId: value.id,
  })
const summaryStream = async function* (_key, request) {
  fixture.requests.push(request)
  yield {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '## Primary Request and Intent\n' },
  }
  yield {
    type: 'content_block_delta',
    index: 0,
    delta: {
      type: 'text_delta',
      text: '- Keep all important requirements, including the tail marker.',
    },
  }
  yield { type: 'message_delta', delta: { stop_reason: 'end_turn' } }
  yield { type: 'message_stop' }
}
beforeEach(async () => {
  await store.flushChatPersistence().catch(() => {})
  fixture.requests = []
  fixture.records = []
  fixture.sessions.clear()
  fixture.save = null
  fixture.settings.apiProfiles = [{ id: 'p', contextWindow: 10000 }]
  fixture.settings.activeProfileId = 'p'
  fixture.settings.apiKey = 'test'
  fixture.config = { protocol: 'openai', model: 'test-model', origin: 'https://test.invalid' }
  fixture.stream = summaryStream
  useContextPreferences.setState({ autoCompact: false })
  useChatStore.setState({
    ready: true,
    importingHistory: false,
    sessionCache: {},
    sessions: [],
    sessionLoadErrors: {},
    sessionSaveErrors: {},
    activeId: null,
    streaming: {},
    compacting: {},
    contextErrors: {},
  })
})

test('exclusions remove complete rounds but never the current question or continuation', () => {
  const history = [user('u1'), assistant('a1'), user('u2'), assistant('a2')]
  const current = user('u3', 'current question')
  const prefix = { ...assistant('a3', 'unfinished prefix'), status: 'stopped' }
  const request = toRequestMessages(
    history,
    current,
    prefix,
    false,
    undefined,
    undefined,
    undefined,
    ['u1', 'u3']
  )
  assert.equal(request.length, 4)
  assert.equal(request[0].content, 'question')
  assert.equal(request.at(-2).content, 'current question')
  assert.match(JSON.stringify(request.at(-1)), /unfinished prefix/)
})

test('checkpoint only replaces its exact current branch and never leaks excluded source', () => {
  const history = [user('u1'), assistant('a1'), user('u2'), assistant('a2')]
  assert.equal(getEffectiveContext(history, 'summary', 'a1', [], ['u1', 'a1']).rounds.length, 1)
  assert.equal(
    getEffectiveContext(history, 'summary', 'a1', ['u1'], ['u1', 'a1']).checkpoint,
    undefined
  )
  assert.equal(
    getEffectiveContext(history, 'wrong branch', 'a1', [], ['other', 'a1']).checkpoint,
    undefined
  )
  const regenerateHistory = history.slice(0, 2)
  assert.equal(
    getEffectiveContext(regenerateHistory, 'future summary', 'a2', [], ['u1', 'a1', 'u2', 'a2'])
      .checkpoint,
    undefined
  )
  assert.equal(getEffectiveContext(history, 'stale', 'missing').rounds.length, 2)
})

test('last five/ten and restore preserve all messages, and selection invalidates summaries', () => {
  const messages = Array.from({ length: 12 }, (_, index) => [
    user(`u${index}`),
    assistant(`a${index}`),
  ]).flat()
  const value = session(messages, {
    checkpoint: { text: 'old', createdAt: 1, coveredMessages: 2, coveredMessageIds: ['u0', 'a0'] },
    compactedThrough: 'a0',
  })
  mount(value)
  store.retainContextRounds(value.id, 5)
  let selected = useChatStore.getState().sessionCache[value.id]
  assert.equal(selected.excludedContextRoundIds.length, 7)
  assert.equal(selected.messages, messages)
  assert.equal(selected.checkpoint, undefined)
  store.retainContextRounds(value.id, 10)
  assert.equal(useChatStore.getState().sessionCache[value.id].excludedContextRoundIds.length, 2)
  store.retainContextRounds(value.id, 'all')
  store.setContextRoundIncluded(value.id, 'u11', false)
  assert.deepEqual(useChatStore.getState().sessionCache[value.id].excludedContextRoundIds, ['u11'])
})

test('budget honors configured model window and counts only visible selected branch', () => {
  let value = session([])
  value = appendBranch(value, null, [user('u1'), assistant('a1')])
  const baseline = sessionContextTokens(value)
  value = appendBranch(value, 'u1', [assistant('a2', 'hidden'.repeat(10000))])
  value = {
    ...value,
    messages: value.messages.map((message) =>
      message.id === 'u1' ? { ...message, selectedChildId: 'a1' } : message
    ),
  }
  assert.equal(sessionContextTokens(value), baseline)
  fixture.settings.apiProfiles[0].contextWindow = 4096
  assert.equal(contextWindowTokens(), 4096)
  fixture.settings.apiProfiles[0].contextWindow = undefined
  assert.equal(contextWindowTokens(), 128000)
})

test('long round splits without losing its tail or Unicode characters', () => {
  const text = '甲😀abc'.repeat(900) + 'TAIL_MARKER'
  const chunks = splitContextText(text, 100)
  assert.ok(chunks.length > 1)
  assert.equal(chunks.join(''), text)
})

test('model compaction batches the full selected history, preserves originals, and records exact coverage', async () => {
  const value = session([
    user('u1', 'x'.repeat(36000) + 'TAIL_MARKER'),
    assistant('a1', 'old answer'),
    user('u2', 'latest question'),
    assistant('a2', 'latest answer'),
  ])
  mount(value)
  const result = await compactSession(value.id)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.ok(fixture.requests.length > 1)
  assert.ok(fixture.requests.some((request) => JSON.stringify(request).includes('TAIL_MARKER')))
  assert.ok(
    fixture.requests.every((request) => !JSON.stringify(request).includes('latest question'))
  )
  const updated = useChatStore.getState().sessionCache[value.id]
  assert.equal(updated.messages, value.messages)
  assert.deepEqual(updated.checkpoint.coveredMessageIds, ['u1', 'a1'])
  assert.equal(updated.compactedThrough, 'a1')
})

test('refused, truncated, empty and interrupted summaries never replace the existing checkpoint', async () => {
  for (const reason of ['refusal', 'max_tokens', 'empty', 'interrupted']) {
    const value = session(
      [
        user('u1', 'old'),
        assistant('a1'),
        user('u2', 'x'.repeat(30000)),
        assistant('a2'),
        user('u3'),
        assistant('a3'),
      ],
      {
        checkpoint: {
          text: 'original checkpoint',
          createdAt: 1,
          coveredMessages: 2,
          coveredMessageIds: ['u1', 'a1'],
        },
        compactedThrough: 'a1',
      }
    )
    mount(value)
    fixture.stream = async function* () {
      if (reason !== 'empty') {
        yield {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'partial summary' },
        }
      }
      yield {
        type: 'message_delta',
        delta: { stop_reason: reason === 'empty' ? 'end_turn' : reason },
      }
      if (reason !== 'interrupted') {
        yield { type: 'message_stop' }
      }
    }
    assert.equal((await compactSession(value.id)).ok, false)
    assert.equal(useChatStore.getState().sessionCache[value.id], value)
    assert.equal(useChatStore.getState().compacting[value.id], undefined)
  }
})

test('cancelled or changed-model summary leaves its originals intact', async () => {
  for (const action of ['cancel', 'profile']) {
    const value = session([
      user('u1', 'x'.repeat(30000)),
      assistant('a1'),
      user('u2'),
      assistant('a2'),
    ])
    mount(value)
    fixture.stream = async function* (...args) {
      if (action === 'cancel') {
        store.cancelCompaction(value.id)
      } else {
        fixture.config = { ...fixture.config, model: 'changed' }
      }
      yield* summaryStream(...args)
    }
    const result = await compactSession(value.id)
    assert.equal(result.ok, false)
    assert.equal(useChatStore.getState().sessionCache[value.id], value)
  }
})

test('repeated compaction merges only newly selected rounds and never another branch', async () => {
  const value = session(
    [
      user('u1', 'DO_NOT_REPEAT_OLD_SOURCE'),
      assistant('a1'),
      user('u2', 'x'.repeat(30000)),
      assistant('a2'),
      user('u3'),
      assistant('a3'),
    ],
    {
      checkpoint: {
        text: 'prior checkpoint',
        createdAt: 1,
        coveredMessages: 2,
        coveredMessageIds: ['u1', 'a1'],
      },
      compactedThrough: 'a1',
    }
  )
  mount(value)
  assert.equal((await compactSession(value.id)).ok, true)
  assert.ok(
    fixture.requests.some((request) => JSON.stringify(request).includes('prior checkpoint'))
  )
  assert.ok(
    fixture.requests.every(
      (request) => !JSON.stringify(request).includes('DO_NOT_REPEAT_OLD_SOURCE')
    )
  )
  assert.deepEqual(useChatStore.getState().sessionCache[value.id].checkpoint.coveredMessageIds, [
    'u1',
    'a1',
    'u2',
    'a2',
  ])
})

test('80ms batcher bounds high frequency updates and synchronously flushes final/cancelled data', async () => {
  let published = 0
  const batcher = createContextBatcher(() => published++)
  for (let index = 0; index < 500; index++) {
    batcher.schedule()
  }
  assert.equal(published, 0)
  await new Promise((resolve) => setTimeout(resolve, 90))
  assert.equal(published, 1)
  batcher.schedule()
  batcher.flush()
  assert.equal(published, 2)
  batcher.finish()
  batcher.schedule()
  batcher.finish()
  assert.equal(published, 3)
  await new Promise((resolve) => setTimeout(resolve, 90))
  assert.equal(published, 3)
})

test('search reveals a hidden deep branch atomically and honours cancellation', async () => {
  let value = session([])
  value = appendBranch(value, null, [user('u1'), assistant('a1'), user('u2'), assistant('a2')])
  value = appendBranch(value, 'u1', [assistant('other'), user('other-u'), assistant('other-a')])
  mount(value)
  assert.equal(await store.revealMessage(value.id, 'a2'), 'ok')
  assert.deepEqual(
    getVisibleMessages(useChatStore.getState().sessionCache[value.id]).map((message) => message.id),
    ['u1', 'a1', 'u2', 'a2']
  )
  assert.equal(useChatStore.getState().sessionCache[value.id].updatedAt, 1)
  const controller = new AbortController()
  controller.abort()
  assert.equal(await store.revealMessage(value.id, 'other-a', controller.signal), 'failed')
  assert.equal(getVisibleMessages(useChatStore.getState().sessionCache[value.id]).at(-1).id, 'a2')
})

test('automatic compaction retains current question and flushes the final reply in one object', async () => {
  const value = session([
    user('u1', 'x'.repeat(30000)),
    assistant('a1'),
    user('u2'),
    assistant('a2'),
  ])
  mount(value)
  useContextPreferences.setState({ autoCompact: true })
  fixture.draft = { text: 'CURRENT_QUESTION', files: [] }
  fixture.stream = async function* (...args) {
    if (args[1].messages.at(-1)?.content.includes('compaction engine')) {
      yield* summaryStream(...args)
      return
    }
    fixture.requests.push(args[1])
    yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
    for (let index = 0; index < 100; index++) {
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'z' } }
    }
    yield { type: 'message_delta', delta: { stop_reason: 'end_turn' } }
    yield { type: 'message_stop' }
  }
  assert.equal(store.sendMessage(value.id), true)
  await new Promise((resolve) => {
    const unsubscribe = useChatStore.subscribe((state) => {
      if (!state.streaming[value.id]) {
        unsubscribe()
        resolve()
      }
    })
  })
  const result = useChatStore.getState().sessionCache[value.id]
  const last = getVisibleMessages(result).at(-1)
  assert.equal(last.status, 'done')
  assert.equal(last.blocks[0].text, 'z'.repeat(100))
  const request = fixture.requests.at(-1)
  assert.equal(request.messages.at(-1).content, 'CURRENT_QUESTION')
  assert.ok(estimateRequestTokens(request.messages) < 10000)
  assert.equal(result.messages.length, value.messages.length + 2)
})

test('auto summary failure keeps history and reports overflow without sending truncated context', async () => {
  const value = session([
    user('u1', 'x'.repeat(33000)),
    assistant('a1'),
    user('u2'),
    assistant('a2'),
  ])
  mount(value)
  useContextPreferences.setState({ autoCompact: true })
  fixture.draft = { text: 'CURRENT_QUESTION', files: [] }
  fixture.stream = async function* (_key, request) {
    fixture.requests.push(request)
    yield { type: 'message_delta', delta: { stop_reason: 'refusal' } }
    yield { type: 'message_stop' }
  }
  store.sendMessage(value.id)
  await new Promise((resolve) => {
    const unsubscribe = useChatStore.subscribe((state) => {
      if (!state.streaming[value.id]) {
        unsubscribe()
        resolve()
      }
    })
  })
  const updated = useChatStore.getState().sessionCache[value.id]
  assert.equal(updated.checkpoint, undefined)
  assert.equal(updated.messages[0].content, value.messages[0].content)
  assert.equal(getVisibleMessages(updated).at(-1).error.localMessage.key, 'contextRequestTooLarge')
  assert.ok(useChatStore.getState().contextErrors[value.id])
  assert.ok(fixture.requests.every((request) => request.tools.length === 0))
})

test('continuing a summarized message invalidates its old checkpoint and retains the full prefix', async () => {
  const previous = {
    ...assistant('a1', 'ORIGINAL_PREFIX'),
    status: 'stopped',
    stopReason: undefined,
  }
  const value = session([user('u1', 'ORIGINAL_QUESTION'), previous], {
    checkpoint: {
      text: 'old summary',
      createdAt: 1,
      coveredMessages: 2,
      coveredMessageIds: ['u1', 'a1'],
    },
    compactedThrough: 'a1',
  })
  mount(value)
  fixture.stream = async function* (_key, request) {
    fixture.requests.push(request)
    yield {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: 'NEW_SUFFIX' },
    }
    yield { type: 'message_delta', delta: { stop_reason: 'end_turn' } }
    yield { type: 'message_stop' }
  }
  store.continueReply(value.id, 'a1')
  await new Promise((resolve) => {
    const unsubscribe = useChatStore.subscribe((state) => {
      if (!state.streaming[value.id]) {
        unsubscribe()
        resolve()
      }
    })
  })
  const updated = useChatStore.getState().sessionCache[value.id]
  assert.equal(updated.checkpoint, undefined)
  const messages = fixture.requests.at(-1).messages
  assert.match(JSON.stringify(messages.at(-2)), /ORIGINAL_PREFIX/)
  assert.equal(messages.at(-1).role, 'user')
  assert.equal(
    getVisibleMessages(updated)
      .at(-1)
      .blocks.map((block) => block.text)
      .join(''),
    'ORIGINAL_PREFIXNEW_SUFFIX'
  )
})

test('background persistence and cancellation flush staged SSE text without animation frames', async () => {
  const document = (globalThis.document = new EventTarget())
  globalThis.window = new EventTarget()
  document.visibilityState = 'visible'
  const cleanup = store.bindChatPersistence()
  const value = session([user('u1'), assistant('a1')])
  mount(value)
  fixture.draft = { text: 'question', files: [] }
  let ready
  const received = new Promise((resolve) => {
    ready = resolve
  })
  fixture.stream = async function* (_key, _request, signal) {
    yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
    yield {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'STAGED_TEXT' },
    }
    ready()
    await new Promise((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    )
  }
  store.sendMessage(value.id)
  await received
  document.visibilityState = 'hidden'
  document.dispatchEvent(new Event('visibilitychange'))
  assert.equal(
    getVisibleMessages(useChatStore.getState().sessionCache[value.id]).at(-1).blocks[0].text,
    'STAGED_TEXT'
  )
  const finished = new Promise((resolve) => {
    const unsubscribe = useChatStore.subscribe((state) => {
      if (!state.streaming[value.id]) {
        unsubscribe()
        resolve()
      }
    })
  })
  store.stopReply(value.id)
  await finished
  const last = getVisibleMessages(useChatStore.getState().sessionCache[value.id]).at(-1)
  assert.equal(last.status, 'stopped')
  assert.equal(last.blocks[0].text, 'STAGED_TEXT')
  cleanup()
})

test('single root deletion preserves every answer branch and gives orphan answers an explicit anchor', () => {
  let value = session([])
  value = appendBranch(value, null, [user('u1'), assistant('a1'), user('u2'), assistant('a2')])
  value = appendBranch(value, 'u1', [assistant('a1-other'), user('u-other'), assistant('a-other')])
  const deleted = buildMessageDeletion(value, 'u1', 'single', ['u1'])
  assert.ok(deleted)
  assert.equal(deleted.session.messages.length, value.messages.length - 1)
  assert.equal(deleted.session.rootMessageId, 'a1-other')
  assert.equal(deleted.session.messages.find((message) => message.id === 'a1').parentId, null)
  assert.equal(
    deleted.session.messages.find((message) => message.id === 'a1-other').contextUserId,
    null
  )
  assert.deepEqual(
    getContextRounds(getVisibleMessages(deleted.session)).map(([question]) => question.id),
    ['u-other']
  )
})

test('successive single deletions never pair an old question with another question’s orphan answer', () => {
  let value = session([
    user('u1'),
    assistant('a1'),
    user('u2'),
    { ...assistant('a2'), status: 'stopped' },
  ])
  value = buildMessageDeletion(value, 'u2', 'single').session
  value = buildMessageDeletion(value, 'a1', 'single').session
  assert.deepEqual(
    getVisibleMessages(value).map((message) => message.id),
    ['u1', 'a2']
  )
  assert.equal(getContextRounds(getVisibleMessages(value)).length, 0)
  mount(value)
  store.regenerateReply(value.id, 'a2')
  store.continueReply(value.id, 'a2')
  assert.equal(useChatStore.getState().sessionCache[value.id].messages.length, 2)
  assert.equal(useChatStore.getState().streaming[value.id], undefined)
  const errorValue = {
    ...value,
    messages: value.messages.map((message) =>
      message.id === 'a2' ? { ...message, status: 'error', error: { kind: 'upload' } } : message
    ),
  }
  mount(errorValue)
  store.retryUpload(value.id, 'a2')
  assert.equal(useChatStore.getState().streaming[value.id], undefined)
})

test('following deletion preview includes hidden descendants and refuses a changed confirmation scope', () => {
  let value = session([])
  value = appendBranch(value, null, [user('u1'), assistant('a1'), user('u2'), assistant('a2')])
  value = appendBranch(value, 'u2', [assistant('a2-hidden'), user('u3'), assistant('a3')])
  assert.deepEqual(
    new Set(previewMessageDeletion(value, 'u2', 'following').messageIds),
    new Set(['u2', 'a2', 'a2-hidden', 'u3', 'a3'])
  )
  mount(value)
  assert.equal(store.deleteMessage(value.id, 'u2', 'following', ['u2', 'a2']), false)
  assert.equal(useChatStore.getState().sessionCache[value.id], value)
  const expected = previewMessageDeletion(value, 'u2', 'following').messageIds
  assert.equal(store.deleteMessage(value.id, 'u2', 'following', expected), true)
  assert.deepEqual(
    getVisibleMessages(useChatStore.getState().sessionCache[value.id]).map((message) => message.id),
    ['u1', 'a1']
  )
})

test('single deletion keeps referenced files and invalidates only affected checkpoint sources', () => {
  const shared = {
    id: 'shared',
    serverId: 'server',
    name: 'shared.txt',
    size: 1,
    isImage: false,
    mimeType: 'text/plain',
  }
  const unique = { ...shared, id: 'unique' }
  const value = session(
    [
      { ...user('u1'), files: [shared, unique] },
      assistant('a1'),
      { ...user('u2'), files: [shared] },
      assistant('a2'),
    ],
    {
      checkpoint: {
        text: 'summary',
        createdAt: 1,
        coveredMessages: 2,
        coveredMessageIds: ['u1', 'a1'],
      },
      compactedThrough: 'a1',
    }
  )
  const first = buildMessageDeletion(value, 'u1', 'single')
  assert.deepEqual(first.removedFileIds, ['unique'])
  assert.equal(first.session.checkpoint, undefined)
  assert.equal(first.session.messages.find((message) => message.id === 'u2').files[0], shared)
  const later = buildMessageDeletion(value, 'u2', 'single')
  assert.equal(later.session.checkpoint, value.checkpoint)
  assert.deepEqual(later.removedFileIds, [])
})

const attachment = (id, name, size, image = false) => ({
  id,
  name,
  size,
  isImage: image,
  serverId: `file-api-${id}`,
  mimeType: '',
})

const lastReplyAfter = async (value, start) => {
  mount(value)
  start()
  if (useChatStore.getState().streaming[value.id]) {
    await new Promise((resolve) => {
      const unsubscribe = useChatStore.subscribe((state) => {
        if (state.streaming[value.id]) {
          return
        }
        unsubscribe()
        resolve()
      })
    })
  }
  return getVisibleMessages(useChatStore.getState().sessionCache[value.id]).at(-1)
}

test('send counts document references across selected rounds and accepts exactly 20', async () => {
  fixture.config.protocol = 'deepseek'
  fixture.settings.apiProfiles[0].contextWindow = 128000 // isolate the document count limit from its token estimate
  const file = attachment('pdf', 'large.pdf', 90 * 1024 * 1024)
  const old = { ...user('u1'), files: Array(20).fill(file) }
  fixture.draft = { text: '', files: [file] }
  const value = session([old, assistant('a1')])
  const blocked = await lastReplyAfter(value, () => store.sendMessage(value.id))
  assert.equal(blocked.error.localMessage.key, 'contextDocumentCount')
  assert.deepEqual(blocked.error.localMessage.params, { count: 21, limit: 20 })
  assert.equal(fixture.requests.length, 0)

  fixture.draft = { text: '', files: Array(20).fill(file) }
  const reduced = session([old, assistant('a1')], { excludedContextRoundIds: ['u1'] })
  const sent = await lastReplyAfter(reduced, () => store.sendMessage(reduced.id))
  assert.equal(sent.status, 'done')
  const blocks = fixture.requests[0].messages.at(-1).content
  assert.equal(blocks.length, 20)
  assert.deepEqual(blocks[0], {
    type: 'document',
    source: { type: 'file', file_id: file.serverId },
  })
})

test('DeepSeek file limits follow account and official API routing across protocols', async () => {
  const { usesDeepSeekFileLimits } = await import('../attachmentLimits.ts')
  const api = (protocol, origin) => ({
    source: 'api',
    key: 'fixture',
    config: { protocol, origin },
  })
  assert.equal(usesDeepSeekFileLimits({ source: 'account' }), true)
  assert.equal(usesDeepSeekFileLimits(api('openai', 'https://api.deepseek.com/v1')), true)
  assert.equal(usesDeepSeekFileLimits(api('deepseek', 'https://proxy.invalid')), true)
  assert.equal(usesDeepSeekFileLimits(api('openai', 'https://provider.invalid/v1')), false)
})

test('context budget reflects plain-text sizes and document-text limits count repeated references', () => {
  const file = attachment('log', 'log.txt', 4 * 1024 * 1024)
  const old = { ...user('u1'), files: [file] }
  const latest = { ...user('u2'), files: [file] }
  const round = [old, assistant('a1')]
  const index = indexRequestFiles([old, latest])
  const messages = toRequestMessages(round, latest)
  assert.equal(requestFileLimit(messages, index), null)
  assert.ok(sessionContextTokens(session([...round, latest])) > (file.size * 2) / 3)
  const extra = { ...latest, files: [file, attachment('tiny', 'tiny.md', 1)] }
  const over = toRequestMessages(round, extra)
  assert.equal(
    requestFileLimit(over, indexRequestFiles([old, extra]))?.key,
    'contextDocumentTextLimit'
  )
  assert.ok(!JSON.stringify(messages).includes('size'))
})

test('image reference bytes count towards the 200 MiB limit independently of document limits', () => {
  const image = attachment('img', 'img.png', 50 * 1024 * 1024, true)
  const doc = attachment('sheet', 'report.xlsx', 32 * 1024 * 1024)
  const latest = { ...user('u1'), files: [...Array(4).fill(image), doc] }
  const index = indexRequestFiles([latest])
  assert.equal(requestFileLimit(toRequestMessages([], latest), index), null)
  assert.equal(
    requestFileLimit(toRequestMessages([], { ...latest, files: [...latest.files, image] }), index)
      ?.key,
    'contextImageLimit'
  )
})

test('regenerating a file-only question without its original gives a local actionable error', async () => {
  const missing = { ...attachment('lost', 'lost.md', 1024), serverId: null }
  const value = session([{ ...user('u', ''), files: [missing] }, assistant('a')])
  const reply = await lastReplyAfter(value, () => store.regenerateReply(value.id))
  assert.equal(reply.error.localMessage.key, 'contextAttachmentUnavailable')
  assert.equal(fixture.requests.length, 0)
})

test('automatic summary batches respect the document cap even when repeated IDs fit the token window', async () => {
  fixture.config.protocol = 'deepseek'
  fixture.settings.apiProfiles[0].contextWindow = 1_000_000
  const doc = attachment('pdf', 'report.pdf', 42 * 1024 * 1024)
  const repeatedRound = (n) => [
    { ...user(`u${n}`), files: Array(15).fill(doc) },
    assistant(`a${n}`),
  ]
  const value = session([
    ...repeatedRound(1),
    ...repeatedRound(2),
    user('leave', 'x'.repeat(500000)),
    assistant('last'),
  ])
  mount(value)
  assert.equal((await compactSession(value.id, { automatic: true })).ok, true)
  assert.equal(fixture.requests.length, 2)
  for (const request of fixture.requests) {
    assert.equal(requestFileLimit(request.messages, indexRequestFiles(value.messages)), null)
  }
})

test('history replacement waits for pending message saves before running its snapshot callback', async () => {
  const value = session([user('u1'), assistant('a1')])
  mount(value)
  let release
  fixture.save = () =>
    new Promise((resolve) => {
      release = resolve
    })
  store.retainContextRounds(value.id, 'all')
  fixture.save = null
  let started = false
  const replace = store.replaceHistory(async () => {
    started = true
  })
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(started, false)
  release()
  await replace
  assert.equal(started, true)
})

test('failed persistence rejects history replacement before its destructive callback', async () => {
  const value = session([user('u1'), assistant('a1')])
  mount(value)
  fixture.save = async () => {
    throw new Error('quota exceeded')
  }
  store.retainContextRounds(value.id, 'all')
  const retained = useChatStore.getState().sessionCache[value.id]
  let called = false
  await assert.rejects(
    store.replaceHistory(async () => {
      called = true
    }),
    /could not be saved/
  )
  assert.equal(called, false)
  assert.equal(useChatStore.getState().sessionCache[value.id], retained)
  fixture.save = null
  await store.flushChatPersistence()
})


test('send guard and automatic/manual compaction use the independently selected model budget', async () => {
  const { setConversationMode } = await import('../conversationMode/storage.ts')
  const { profileWindowKey } = await import('../api/contextOverrides.ts')
  const origin = 'https://fixture.invalid/v1'
  const modelKey = id => profileWindowKey(origin, id, 'openai')
  fixture.settings.apiProfiles = [{ id: 'p', apiKey: 'scoped', origin, protocol: 'openai', model: 'large', contextWindows: {
    [modelKey('tiny')]: 2000, [modelKey('large')]: 20000,
  } }]
  const value = session([user('u1', 'x'.repeat(16000)), assistant('a1'), user('u2'), assistant('a2')])
  fixture.draft = { text: 'NEXT', files: [] }
  setConversationMode(value.id, { model: 'tiny' })
  const rejected = await lastReplyAfter(value, () => store.sendMessage(value.id))
  assert.equal(rejected.error.localMessage.key, 'contextRequestTooLarge')
  assert.equal(fixture.requests.length, 0)
  setConversationMode(value.id, { model: 'large' })
  assert.equal(contextWindowTokens(value.id), 20000)
  mount(value)
  assert.equal((await compactSession(value.id)).message, 'contextCompactLocked')
  const sent = await lastReplyAfter(value, () => store.sendMessage(value.id))
  assert.equal(sent.status, 'done')
  setConversationMode(value.id, { model: 'tiny' })
  assert.equal(contextWindowTokens(value.id), 2000)
  mount(value)
  assert.notEqual((await compactSession(value.id)).message, 'contextCompactLocked')
})

// No settings or catalog screen has opened. The very first request loads the provider data itself.
test('cold chat send enforces the exact provider input cap before dispatch', async () => {
  fixture.settings.apiProfiles = [{ id: 'p', apiKey: 'test', origin: 'https://spark-api-open.xf-yun.com/v1', protocol: 'openai', model: 'generalv3' }]
  fixture.draft = { text: 'z'.repeat(29000), files: [] }
  const value = session([])
  const blocked = await lastReplyAfter(value, () => store.sendMessage(value.id))
  assert.equal(contextWindowTokens(value.id), 8192)
  assert.equal(blocked.error.localMessage.key, 'contextRequestTooLarge')
  assert.equal(fixture.requests.length, 0)
})
