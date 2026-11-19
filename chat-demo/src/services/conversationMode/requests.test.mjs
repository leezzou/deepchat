// Real store, drafts, protocol adapters and memory library; only disk and network are isolated.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { experiments } from '@rspack/core'
import { registerHooks } from 'node:module'
import test from 'node:test'
const disk = new Map()
globalThis.localStorage = {
  getItem: (k) => disk.get(k) ?? null,
  setItem: (k, v) => disk.set(k, v),
  removeItem: (k) => disk.delete(k),
}
globalThis.__API_ORIGIN__ = 'https://api.deepseek.com'
const saved = (globalThis.__modelTestSessions = new Map())
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
    if (url.endsWith('/services/chat/db.ts')) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
      export const loadSessionSummaries=async()=>[], saveSession=async(s)=>{globalThis.__modelTestSessions.set(s.id,s)}, loadFile=async()=>null, reportStorageError=()=>()=>{};
    `,
      }
    }
    if (url.endsWith('.ts')) {
      const path = fileURLToPath(url)
      const { code } = experiments.swc.transformSync(readFileSync(path, 'utf8'), {
        filename: path,
        jsc: { parser: { syntax: 'typescript' }, target: 'es2022' },
        module: { type: 'es6' },
      })
      return { format: 'module', shortCircuit: true, source: code }
    }
    return next(url, ctx)
  },
})
const settings = await import('../settings.ts')
const store = await import('../chat/store.ts')
const drafts = await import('../chat/drafts.ts')
const library = await import('../library/index.ts')
const mode = await import('./storage.ts')
const { getConversationRoute, getChatAccess } = await import('../api/access.ts')
const a = {
  id: 'a',
  name: 'Alpha',
  apiKey: 'key-a-fixture',
  origin: 'https://api.deepseek.com',
  protocol: 'deepseek',
  model: 'deepseek-flash',
}
const b = {
  id: 'b',
  name: 'Beta',
  apiKey: 'key-b-fixture',
  origin: 'https://beta.invalid/v1',
  protocol: 'openai',
  model: 'beta-text',
}
const calls = []
globalThis.fetch = async (url, init) => {
  const file = init.body instanceof FormData
  calls.push({
    url,
    headers: new Headers(init.headers),
    body: file ? init.body : JSON.parse(init.body),
  })
  if (file) {
    return Response.json({ id: 'file-synthetic' })
  }
  const openai = url.endsWith('/chat/completions')
  const events = openai
    ? 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'
    : 'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"ok"}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n'
  return new Response(events, { headers: { 'content-type': 'text/event-stream' } })
}
const idle = async (id) => {
  if (!store.useChatStore.getState().streaming[id]) {
    return
  }
  await new Promise((resolve) => {
    const unsub = store.useChatStore.subscribe((s) => {
      if (!s.streaming[id]) {
        unsub()
        resolve()
      }
    })
  })
}
function enter(id, text) {
  drafts.setDraftText(id, text)
  assert.equal(store.sendMessage(id), true)
  return store.useChatStore.getState().activeId
}
test('first-send promotion and repeat A → B → A requests retain their own draft, model, key and system instructions', async () => {
  settings.useSettings.setState({
    apiProfiles: [a, b],
    activeProfileId: b.id,
    apiKey: b.apiKey,
    chatSource: 'api',
  })
  settings.setThinking(true)
  settings.setSearch(true)
  await store.initChat()
  assert.deepEqual(mode.allTemplates(), [])
  assert.equal(mode.getConversationMode(null).templateId, undefined)
  const custom = mode.savePromptTemplate('Custom', 'TEMPLATE_ALPHA')
  library.addMemory('MEMORY_ALPHA')
  library.setMemoryEnabled(null, true)
  store.applyConversationMode(null, {
    profileId: a.id,
    model: 'deepseek-v4-pro',
    templateId: custom,
  })
  const first = enter(null, 'A-one')
  await idle(first)
  assert.equal(mode.getConversationMode(null).templateId, undefined)
  assert.equal(library.getSessionMemoryTexts(null).length, 0)
  assert.equal(getConversationRoute(first).files, false)
  drafts.setDraftText(first, 'A-two')
  store.newChat()
  store.applyConversationMode(null, { profileId: b.id })
  const second = enter(null, 'B-one')
  await idle(second)
  drafts.setDraftText(second, 'B-unfinished')
  store.selectSession(first)
  assert.equal(drafts.getDraft(first).text, 'A-two')
  assert.equal(store.sendMessage(first), true)
  await idle(first)
  store.selectSession(second)
  assert.equal(drafts.getDraft(second).text, 'B-unfinished')
  assert.deepEqual(
    calls.map((c) => c.url),
    [
      'https://api.deepseek.com/anthropic/v1/messages',
      'https://beta.invalid/v1/chat/completions',
      'https://api.deepseek.com/anthropic/v1/messages',
    ]
  )
  for (const c of [calls[0], calls[2]]) {
    assert.equal(c.headers.get('x-api-key'), a.apiKey)
    assert.equal(c.body.model, 'deepseek-v4-pro')
    assert.equal(c.body.system, 'TEMPLATE_ALPHA\n\n用户选用的本地记忆：\n- MEMORY_ALPHA')
    assert.equal(c.body.thinking.type, 'enabled')
    assert.ok(c.body.tools.some((t) => t.type === 'deepseek_web_search'))
    assert.doesNotMatch(JSON.stringify(c.body), /B-one/)
  }
  const c = calls[1]
  assert.equal(c.headers.get('authorization'), 'Bearer ' + b.apiKey)
  assert.equal(c.body.model, 'beta-text')
  assert.ok(c.body.messages.every((message) => message.role !== 'system'))
  assert.doesNotMatch(
    JSON.stringify(c.body),
    /MEMORY_ALPHA|TEMPLATE_ALPHA|A-one|deepseek_web_search|thinking/
  )
  assert.match(JSON.stringify(calls[2].body), /A-one/)
  assert.match(JSON.stringify(calls[2].body), /A-two/)
  assert.equal(saved.has(first) && saved.has(second), true)
  assert.deepEqual(saved.get(first).messages.at(-1).lastRequestMemories, ['MEMORY_ALPHA'])
  assert.deepEqual(saved.get(second).messages.at(-1).lastRequestMemories, [])
  // Editing a profile's endpoint invalidates the approval even when its id stays the same.
  settings.useSettings.setState({ apiProfiles: [{ ...a, origin: 'https://new-alpha.invalid' }, b] })
  assert.equal(getChatAccess(first), null)
  drafts.setDraftText(first, 'preserved')
  assert.equal(store.sendMessage(first), false)
  assert.equal(calls.length, 3)
  assert.equal(drafts.getDraft(first).text, 'preserved')
  store.applyConversationMode(first, mode.getConversationMode(first))
  assert.equal(getChatAccess(first).config.origin, 'https://new-alpha.invalid')
  // An inactive profile with missing fields can never borrow the active provider's address.
  settings.useSettings.setState({ apiProfiles: [a, { ...b, origin: '', model: '' }] })
  const fallback = getConversationRoute(second)
  assert.equal(fallback.origin, globalThis.__API_ORIGIN__)
  assert.equal(fallback.model, 'deepseek-flash')
})

test('two conversations sharing one compatible profile accept independent model IDs and keep the profile default', async () => {
  settings.useSettings.setState({ apiProfiles: [a, b], activeProfileId: b.id, apiKey: b.apiKey })
  const before = calls.length
  const ids = []
  for (const model of ['vendor/model-a:fast', 'model-b']) {
    store.newChat()
    assert.equal(store.applyConversationMode(null, { profileId: b.id, model }), true)
    const id = enter(null, model)
    ids.push(id)
    await idle(id)
  }
  store.selectSession(ids[0])
  enter(ids[0], 'use the first model again')
  await idle(ids[0])
  assert.deepEqual(
    calls.slice(before).map((c) => c.body.model),
    ['vendor/model-a:fast', 'model-b', 'vendor/model-a:fast']
  )
  assert.equal(settings.useSettings.getState().apiProfiles[1].model, 'beta-text')
})

test('the first request in a folder includes only its shared memories, and the next request respects disabling sharing', async () => {
  settings.useSettings.setState({ apiProfiles: [a, b], activeProfileId: b.id, apiKey: b.apiKey })
  const group = library.createFolder('Project', 'source-in-folder', true)
  library.createFolder('Other', 'outside-folder', true)
  library.addMemory('INSIDE_FOLDER', 'source-in-folder')
  library.addMemory('OUTSIDE_FOLDER', 'outside-folder')
  store.newChat(group)
  store.applyConversationMode(null, { profileId: b.id })
  const id = enter(null, 'first request in folder')
  await idle(id)
  assert.equal(library.getSessionFolderId(id), group)
  assert.deepEqual(saved.get(id).messages.at(-1).lastRequestMemories, ['INSIDE_FOLDER'])
  assert.match(JSON.stringify(calls.at(-1).body), /INSIDE_FOLDER/)
  assert.doesNotMatch(JSON.stringify(calls.at(-1).body), /OUTSIDE_FOLDER/)
  library.updateFolder(group, 'Project', false)
  enter(id, 'next request')
  await idle(id)
  assert.deepEqual(saved.get(id).messages.at(-1).lastRequestMemories, [])
  assert.doesNotMatch(JSON.stringify(calls.at(-1).body), /INSIDE_FOLDER|OUTSIDE_FOLDER/)
})

test('incoming image stays local until first send and uploads the original through the selected route', async () => {
  store.newChat()
  store.applyConversationMode(null, { profileId: b.id, model: 'with-vision' })
  drafts.useDrafts.setState({ ready: true })
  const image = new File([Uint8Array.of(0xff, 0xd8, 0xff)], 'sample.jpg', { type: 'image/jpeg' })
  const before = calls.length
  assert.equal(drafts.putIncomingDraft(null, 'share-fixture', '', image), true)
  assert.equal(calls.length, before)
  assert.equal(store.sendMessage(null), true)
  await idle(store.useChatStore.getState().activeId)
  const [upload, chat] = calls.slice(before)
  assert.equal(upload.url, b.origin + '/files')
  assert.equal(upload.body.get('file').size, image.size)
  assert.equal(chat.body.messages.at(-1).content[0].file.file_id, 'file-synthetic')
})

test('template operations and backup validate the full whitelist before replacing one local key', () => {
  const ids = store.useChatStore.getState().sessions.map((s) => s.id)
  const backup = mode.exportConversationModes(ids)
  assert.doesNotMatch(JSON.stringify(backup), /\.invalid|apiKey|key-[ab]-fixture|MEMORY_ALPHA/)
  for (const bad of [
    { ...backup, apiKey: 'extra' },
    { ...backup, templates: [{ id: 'x', name: 'n', prompt: 'p', origin: 'extra' }] },
    { ...backup, sessions: [{ sessionId: 'absent' }] },
    { ...backup, sessions: [{ sessionId: ids[0], templateId: 'unknown' }] },
  ]) {
    assert.throws(() => mode.importConversationModes(bad, ids))
    assert.deepEqual(mode.exportConversationModes(ids), backup)
  }
  const old = globalThis.localStorage.setItem
  globalThis.localStorage.setItem = () => {
    throw new Error('QuotaExceeded')
  }
  assert.throws(() =>
    mode.importConversationModes({ version: 1, sessions: [], templates: [] }, ids)
  )
  globalThis.localStorage.setItem = old
  assert.deepEqual(mode.exportConversationModes(ids), backup)
  mode.importConversationModes(backup, ids)
  assert.deepEqual(mode.exportConversationModes(ids), backup)
  assert.ok(ids.every((id) => getChatAccess(id) === null))
  const original = backup.templates[0]
  mode.savePromptTemplate('edited name', 'edited prompt', original.id)
  assert.equal(mode.allTemplates().find((t) => t.id === original.id).prompt, 'edited prompt')
  mode.deletePromptTemplate(original.id)
  assert.ok(mode.exportConversationModes(ids).sessions.every((s) => s.templateId !== original.id))
})

test('plain messages omit system instructions on both protocols, and only an explicit custom selection adds them', async () => {
  settings.useSettings.setState({ apiProfiles: [a, b], activeProfileId: a.id, apiKey: a.apiKey })
  const custom = mode.savePromptTemplate('User template', 'Only this user instruction.')
  for (const profile of [a, b]) {
    store.newChat()
    store.applyConversationMode(null, { profileId: profile.id })
    const id = enter(null, 'plain')
    await idle(id)
    const verifySystem = (expected) => {
      const { body } = calls.at(-1)
      if (profile === a) {
        assert.equal(Object.hasOwn(body, 'system'), expected !== undefined)
        assert.equal(body.system, expected)
      } else {
        assert.deepEqual(
          body.messages
            .filter((message) => message.role === 'system')
            .map((message) => message.content),
          expected === undefined ? [] : [expected]
        )
      }
    }
    verifySystem(undefined)
    store.applyConversationMode(id, { profileId: profile.id, templateId: custom })
    enter(id, 'selected')
    await idle(id)
    verifySystem('Only this user instruction.')
    store.applyConversationMode(id, { profileId: profile.id })
    enter(id, 'deselected')
    await idle(id)
    verifySystem(undefined)
  }
})

test('old presets migrate out of local welcome drafts, stored conversations and portable metadata', async () => {
  const templates = [{ id: 'user-1', name: 'My own', prompt: 'Keep my prompt' }]
  const old = {
    version: 1,
    templates,
    sessions: ['translation', 'speaking', 'weekly-report', 'user-1'].map((templateId, i) => ({
      sessionId: `old-${i}`,
      profileId: a.id,
      model: 'deepseek-flash',
      templateId,
    })),
  }
  const destinations = [
    [null, 'local-approval'],
    ['old-0', 'session-approval'],
  ]
  disk.set(
    'chat-demo:conversation-modes:v1',
    JSON.stringify({
      data: old,
      draft: { templateId: 'weekly-report', profileId: a.id },
      destinations,
    })
  )
  const reloaded = await import('./storage.ts?legacy-local-reload')
  assert.deepEqual(reloaded.getConversationMode(null), { profileId: a.id })
  assert.deepEqual([...reloaded.useConversationModes.getState().destinations], destinations)
  const ids = old.sessions.map((row) => row.sessionId)
  mode.importConversationModes(old, ids)
  for (const loaded of [reloaded, mode]) {
    assert.deepEqual(loaded.allTemplates(), templates)
    const exported = loaded.exportConversationModes(ids)
    assert.deepEqual(
      exported.sessions,
      old.sessions.map(({ templateId, ...row }) =>
        templateId === 'user-1' ? { ...row, templateId } : row
      )
    )
  }
  // Updating an upgraded session leaves only portable, normalized references on disk.
  const { conversationInstructions } = await import('./prompt.ts')
  assert.deepEqual(conversationInstructions('old-0'), { system: undefined, memories: [] })
  assert.equal(conversationInstructions('old-3').system, 'Keep my prompt')
})
