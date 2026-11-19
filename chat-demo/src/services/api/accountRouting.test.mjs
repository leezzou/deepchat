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
      if (existsSync(typed)) { return next(typed.href, ctx) }
    }
    return next(id, ctx)
  },
  load(url, ctx, next) {
    if (!url.endsWith('.ts')) { return next(url, ctx) }
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
const { deleteFile, streamMessage, uploadFile, verifyApiKey } = await import('./client.ts')
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
  for await (const ignored of events) { void ignored }
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
      for await (const event of streamMessage(access, { messages }, new AbortController().signal)) { void event }
    }
  } finally { globalThis.fetch = originalFetch }
})

const signal = () => new AbortController().signal
const finish = async (events) => {
  for await (const event of events) { void event }
}
const streamEnd = (openAi) => new Response(
  openAi ? 'data: [DONE]\n\n' : 'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  { headers: { 'Content-Type': 'text/event-stream' } }
)
const officialOrigin = 'https://api.deepseek.com'
const api = (protocol, model = 'deepseek-flash', origin = officialOrigin) => ({
  source: 'api', key: 'fixture', config: { origin, protocol, model },
})

// Exercise both supported PDF/Word purposes using the actual question → message builder.
// The mocked upload describes a 23 MiB original, with no server-side parse metrics.
test('large documents with a question send only the ready ID and text in both official protocols', async (t) => {
  const { toRequestMessages } = await import('../chat/reply.ts')
  const bytes = new Uint8Array(23 * 1024 * 1024)
  for (const protocol of ['deepseek', 'openai']) {
    const openAi = protocol === 'openai'
    const base = `${officialOrigin}${openAi ? '' : '/anthropic/v1'}`
    const access = api(protocol)
    for (const [name, purpose] of [['report.pdf', 'text_recognition'], ['report.docx', 'rich_layout_recognition']]) {
      const id = 'file-api-opaque-fixture'
      const file = new File([bytes], name)
      const metadata = openAi
        ? { id, filename: name, object: 'file', created_at: 1762790000, bytes: file.size, purpose }
        : { id, filename: name, type: 'file', created_at: '2026-11-18T00:00:00Z', size_bytes: file.size, mime_type: 'application/octet-stream' }
      const fetch = t.mock.method(globalThis, 'fetch', async (url) => url === `${base}/files`
        ? Response.json(metadata) : streamEnd(openAi))
      const { id: serverId } = await uploadFile(access, file, purpose, signal())
      const question = { role: 'user', content: '列出主要结论', files: [{ isImage: false, serverId }] }
      await finish(streamMessage(access, { model: 'deepseek-flash', messages: toRequestMessages([], question) }, signal()))
      const [[uploadUrl, upload], [messageUrl, message]] = fetch.mock.calls.map(({ arguments: args }) => args)
      assert.equal(fetch.mock.callCount(), 2)
      fetch.mock.restore()
      assert.equal(uploadUrl, `${base}/files`)
      assert.equal(upload.method, 'POST')
      assert.deepEqual([...upload.body.keys()], ['purpose', 'file'])
      assert.equal(upload.body.get('purpose'), purpose)
      assert.equal(upload.body.get('file').size, bytes.length)
      assert.equal(upload.body.get('file').name, name)
      assert.equal(messageUrl, `${base}/${openAi ? 'chat/completions' : 'messages'}`)
      assert.equal(message.method, 'POST')
      for (const { headers } of [upload, message]) {
        const h = new Headers(headers)
        assert.equal(h.get('anthropic-beta'), openAi ? null : 'files-api-2025-04-14')
        assert.equal(h.get(openAi ? 'authorization' : 'x-api-key'), openAi ? 'Bearer fixture' : 'fixture')
      }
      assert.deepEqual(JSON.parse(message.body), {
        model: 'deepseek-flash', stream: true,
        messages: [{ role: 'user', content: [
          openAi ? { type: 'file', file_id: id } : { type: 'document', source: { type: 'file', file_id: id } },
          { type: 'text', text: question.content },
        ] }],
      })
    }
  }
})

test('first question with three documents, thinking and search preserves every reference and the prompt', async (t) => {
  const { toRequestMessages } = await import('../chat/reply.ts')
  const fetch = t.mock.method(globalThis, 'fetch', async () => streamEnd(false))
  const ids = ['doc-56k', 'doc-24k', 'pdf-21m']
  const question = { role: 'user', content: '请比较这三个文档。', files: ids.map((serverId) => ({ serverId, isImage: false })) }
  const request = {
    model: 'deepseek-flash',
    thinking: { type: 'enabled' },
    tools: ['deepseek_read_url', 'deepseek_web_search'].map((name) => ({ name, type: name })),
    safety_check: { level: 'high' },
    title: { enabled: true },
    messages: toRequestMessages([], question, undefined, true, '2026-11-19,星期四,,Web,中文'),
  }
  await finish(streamMessage(api('deepseek'), request, signal()))
  const [url, init] = fetch.mock.calls[0].arguments
  assert.equal(url, `${officialOrigin}/anthropic/v1/messages`)
  assert.equal(init.headers['anthropic-beta'], 'files-api-2025-04-14')
  assert.deepEqual(JSON.parse(init.body), {
    ...request,
    stream: true,
    messages: [
      { role: 'latest_reminder', content: '2026-11-19,星期四,,Web,中文' },
      { role: 'user', content: [
        ...ids.map((file_id) => ({ type: 'document', source: { type: 'file', file_id } })),
        { type: 'text', text: question.content },
      ] },
    ],
  })
})

test('official Pro cannot incur a document upload charge or send a historical file reference', async (t) => {
  const pro = 'deepseek-v4-pro'
  const isModelError = (error) => error.localMessage?.key === 'uploadFileModel'
  const messages = [
    { role: 'user', content: [{ type: 'image', source: { type: 'file', file_id: 'prior' } }] },
    { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] },
    { role: 'user', content: 'follow up' },
  ]
  const fetch = t.mock.method(globalThis, 'fetch', async () => streamEnd(true))
  await assert.rejects(uploadFile(api('openai', pro), new File(['fixture'], 'report.docx'), 'text_recognition'), isModelError)
  for (const access of [api('openai', pro), api('deepseek'), { source: 'account' }]) {
    await assert.rejects(finish(streamMessage(access, { model: pro, messages }, signal())), isModelError)
  }
  assert.equal(fetch.mock.callCount(), 0)
  // Plain text on Pro, and other providers' model IDs, still use the selected model.
  await finish(streamMessage(api('openai', pro), { messages: messages.slice(-1) }, signal()))
  await finish(streamMessage(api('openai', pro, 'https://fixture.invalid/v1'), { messages }, signal()))
  assert.deepEqual(fetch.mock.calls.map((call) => JSON.parse(call.arguments[1].body).model), [pro, pro])
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

test('unknown account file validations expose stage and HTTP status, with allowlisted details only', async () => {
  const { request } = await import('./client.ts')
  initializeAccount(() => {})
  frames.splice(0)
  const requestId = '979a2778-5144-48e9-92e1-3b07e9c92934'
  const accountError = async (upload, status, diagnostic) => {
    const url = `https://api.deepseek.com/anthropic/v1/${upload ? 'files' : 'messages'}`
    const pending = request(url, { method: 'POST', body: upload ? new FormData() : undefined }, { source: 'account' })
    const [{ id }] = frames.splice(0)
    const message = upload ? 'DS_FILE_UPLOAD_REJECTED' : 'DS_FILE_MESSAGE_REJECTED'
    const data = JSON.stringify({ error: { message, diagnostic } })
    deliver({ type: 'headers', id, status, contentType: 'application/json' })
    deliver({ type: 'data', id, base64: Buffer.from(data).toString('base64') })
    deliver({ type: 'end', id })
    return pending.then(() => assert.fail('expected file rejection'), (error) => error)
  }
  const unknown = await accountError(false, 422, { stage: 'messages', status: 422, type: 'invalid_request_error',
    code: 'private-code', param: 'model', message: 'fixture private user content', requestId })
  assert.equal(unknown.localMessage.key, 'replyValidationDiagnostic')
  assert.equal(unknown.status, 422)
  assert.match(unknown.message, /HTTP 422/)
  assert.match(unknown.message, /type=invalid_request_error/)
  assert.match(unknown.message, /param=model/)
  assert.ok(unknown.message.includes(`x-request-id=${requestId}`))
  assert.doesNotMatch(unknown.message, /private/)
  const traceId = 'a641f819c30240b2a9530768387983b0'
  const upload = await accountError(true, 400, { stage: 'upload', status: 400, type: 'sk-private', code: 31337,
    param: 'private@example.invalid', requestId: 'sk-private', traceId })
  assert.deepEqual(upload.localMessage, { key: 'uploadValidationDiagnostic', params: { status: 400, details: ` · x-ds-trace-id=${traceId}` } })
  for (const bad of [undefined, { stage: 'messages', status: 422, requestId },
    { stage: 'upload', status: 400, type: 'sk-private', requestId: `${requestId}\n`, traceId: 'private trace' }]) {
    assert.equal((await accountError(true, 400, bad)).localMessage.params.details, '')
  }
})

test('an expired file can be reuploaded on 422 and an unknown validation does not trigger reupload', async () => {
  const { ApiError } = await import('./client.ts')
  const { getFileErrorCode } = await import('./errors.ts')
  assert.equal(getFileErrorCode(new ApiError('http', { key: 'uploadExpiredFile' }, 422)), 'invalidFileId')
  assert.equal(getFileErrorCode(new ApiError('http', { key: 'replyValidationDiagnostic', params: { status: 422, details: '' } }, 422)), null)
  assert.equal(getFileErrorCode(new ApiError('http', { key: 'uploadExpiredFile' }, 429)), null)
})
