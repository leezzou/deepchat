// Exercises the same source choice and HTTP dispatch as the app, entirely in memory.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { experiments } from '@rspack/core'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

registerHooks({
  resolve(id, ctx, next) {
    if (id.startsWith('.') && id.endsWith('.js') && ctx.parentURL) {
      const typed = new URL(id.slice(0, -3) + '.ts', ctx.parentURL)
      if (existsSync(typed)) return next(typed.href, ctx)
    }
    return next(id, ctx)
  },
  load(url, ctx, next) {
    if (!url.endsWith('.ts')) return next(url, ctx)
    const { code: source } = experiments.swc.transformSync(readFileSync(fileURLToPath(url), 'utf8'), {
      filename: fileURLToPath(url),
      jsc: { parser: { syntax: 'typescript' }, target: 'es2022' },
      module: { type: 'es6' },
    })
    return { source, format: 'module', shortCircuit: true }
  },
})

const frames = []
const direct = []
const port = { postMessage: (message) => frames.push(JSON.parse(message)) }
const profile = { id: 'fixture', name: 'Custom', origin: 'https://fixture.invalid/v1', protocol: 'openai', model: 'test-model', apiKey: 'fixture-key' }
const saved = new Map([
  ['chat-demo:api-profiles', JSON.stringify([profile])],
  ['chat-demo:active-profile', profile.id],
])
globalThis.localStorage = { getItem: (key) => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value), removeItem: (key) => saved.delete(key) }
globalThis.window = { DshNative: port }
globalThis.__API_ORIGIN__ = 'https://api.deepseek.com'
globalThis.fetch = async (url, init) => {
  direct.push({ url, init })
  return new Response('data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
}
const { setChatSource, selectApiProfile, useSettings } = await import('../settings.ts')
const { getChatAccess } = await import('./access.ts')
const { deleteFile, streamMessage, verifyApiKey } = await import('./client.ts')
const { initializeAccount } = await import('../../shell/account.ts')
const deliver = (frame) => port.onmessage({ data: JSON.stringify(frame) })

test('existing profile retains its endpoint, model and key across account login and source changes', async () => {
  initializeAccount(({ signedIn }) => useSettings.setState({ accountSignedIn: signedIn }))
  assert.deepEqual(frames.splice(0), [{ op: 'status' }])
  deliver({ type: 'account', signedIn: true })
  const original = getChatAccess()
  assert.equal(original.source, 'api')
  setChatSource('account')
  assert.deepEqual(getChatAccess(), { source: 'account' })
  assert.equal(useSettings.getState().activeProfileId, profile.id)
  assert.equal(useSettings.getState().apiKey, profile.apiKey)

  // A queued API request keeps its original access, even after a switch to the native account.
  const events = streamMessage(original, { messages: [] }, new AbortController().signal)
  for await (const ignored of events) void ignored
  const [{ url, init }] = direct.splice(0)
  assert.equal(url, profile.origin + '/chat/completions')
  assert.equal(init.headers.Authorization, 'Bearer ' + profile.apiKey)
  assert.equal(JSON.parse(init.body).model, profile.model)
  assert.deepEqual(frames, [])

  const removal = deleteFile(getChatAccess(), 'file-fixture')
  const [frame] = frames.splice(0)
  assert.deepEqual(frame, { op: 'request', id: frame.id, path: '/anthropic/v1/files/file-fixture', method: 'DELETE', contentType: '', body: '' })
  deliver({ type: 'headers', id: frame.id, status: 204 })
  deliver({ type: 'end', id: frame.id })
  await removal
  assert.deepEqual(direct, [])
  assert.equal(saved.get('chat-demo:api-profiles'), JSON.stringify([profile]))

  // Checking a new key is always direct, including while the native source is selected.
  await verifyApiKey('new-fixture-key', 'https://second.invalid')
  assert.equal(direct[0].url, 'https://second.invalid/models')
  assert.equal(direct[0].init.headers.Authorization, 'Bearer new-fixture-key')
  assert.deepEqual(frames, [])
  deliver({ type: 'account', signedIn: false })
  assert.equal(getChatAccess(), null)
  selectApiProfile(profile.id)
  assert.deepEqual(getChatAccess(), original)
  assert.equal(saved.get('chat-demo:chat-source'), 'api')
})


test('official and compatible Chat Completions retain the uploaded ID in file-only messages', async () => {
  const { uploadFile } = await import('./client.ts')
  const originalFetch = globalThis.fetch
  try {
    for (const [origin, deepseek] of [['https://api.deepseek.com', true], ['https://fixture.invalid/v1', false]]) {
      const access = { source: 'api', key: 'fixture', config: { origin, protocol: 'openai', model: 'deepseek-flash' } }
      const fileId = 'file-fixture-id'
      globalThis.fetch = async (url, init) => {
        assert.equal(url, `${origin}/files`)
        assert.deepEqual([...init.body.keys()], ['purpose', 'file'])
        assert.equal(init.body.get('purpose'), deepseek ? 'text_recognition' : 'user_data')
        return Response.json({ id: fileId })
      }
      const { id } = await uploadFile(access, new File(['hello'], 'document.pdf'), 'text_recognition')
      globalThis.fetch = async (url, init) => {
        assert.equal(url, `${origin}/chat/completions`)
        const expected = deepseek ? { type: 'file', file_id: id } : { type: 'file', file: { file_id: id } }
        assert.deepEqual(JSON.parse(init.body).messages, [{ role: 'user', content: [expected] }])
        return new Response('data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
      }
      const messages = [{ role: 'user', content: [{ type: 'document', source: { type: 'file', file_id: id } }] }]
      for await (const event of streamMessage(access, { messages }, new AbortController().signal)) void event
    }
  } finally { globalThis.fetch = originalFetch }
})

test('picker distinguishes original document, image, and extracted text limits', async () => {
  const { validateFiles } = await import('../attachments.ts')
  const access = { source: 'account' }
  const file = (name, mib, type = '') => ({ name, size: mib * 1024 ** 2, type })
  assert.equal(validateFiles([file('large.pdf', 100)], [], access), null)
  assert.equal(validateFiles([file('large.pdf', 100.1)], [], access)?.key, 'uploadMaxMBSize')
  assert.equal(validateFiles([file('photo.jpg', 65, 'application/octet-stream')], [], access)?.params.size, 64)
  assert.equal(validateFiles([file('text.txt', 8)], [], access), null)
  assert.equal(validateFiles([file('more.txt', 1)], [file('text.txt', 8)], access)?.key, 'uploadTextLimit')
  assert.equal(validateFiles([file('a.pdf', 1)], Array(20).fill(file('file.pdf', 0.1)), access)?.key, 'uploadDocCount')
})
