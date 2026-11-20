// Offline WebView port for the real TypeScript bridge. Node 24+ strips TS types.
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

registerHooks({
  resolve(id, context, next) {
    if (id === '../../utils/id.js' && context.parentURL?.endsWith('/workbuddy/bridge.ts')) {
      return next('../../utils/id.ts', context)
    }
    return next(id, context)
  },
})
const sent = []
const port = { postMessage: (message) => sent.push(JSON.parse(message)) }
globalThis.window = { WorkBuddyChat: port }
globalThis.fetch = () => assert.fail('a page read must use the native port')
const { workBuddyFetch } = await import('./bridge.ts')
const model = 'deepseek-v4-pro'
const revision = 'revision-fixture'
const readKey = '5e3a88d7-3a3d-42e8-9aa9-9db9006e2bc3'
const read = (signal, extra) =>
  workBuddyFetch(model, revision, { op: 'read', readKey, ...extra }, signal)
const receive = (id, fields) => port.onmessage({ data: JSON.stringify({ id, ...fields }) })

test('sends only scoped readKey and receives JSON page text', async () => {
  const result = read(new AbortController().signal, {
    url: 'https://example.org/',
    headers: {},
    prompt: 'ignored',
  })
  const { id } = sent.at(-1)
  assert.deepEqual(sent.at(-1), { op: 'read', readKey, id, model, revision })
  receive(id, { type: 'headers', status: 200, contentType: 'application/json' })
  receive(id, { type: 'data', data: Buffer.from('{"text":"原文🙂"}').toString('base64') })
  receive(id, { type: 'end' })
  assert.deepEqual(await (await result).json(), { text: '原文🙂' })
})

test('propagates native refusal and drops late frames after cancellation', async () => {
  const denied = read(new AbortController().signal)
  receive(sent.at(-1).id, { type: 'error', code: 'page_unavailable' })
  await assert.rejects(denied, /page_unavailable/)
  const controller = new AbortController()
  const result = read(controller.signal)
  const { id } = sent.at(-1)
  receive(id, { type: 'headers', status: 200, contentType: 'application/json' })
  const text = (await result).text()
  controller.abort()
  assert.deepEqual(sent.at(-1), { op: 'cancel', id })
  receive(id, { type: 'data', data: Buffer.from('late').toString('base64') })
  receive(id, { type: 'end' })
  await assert.rejects(text, { name: 'AbortError' })
  const count = sent.length
  await assert.rejects(read(controller.signal), { name: 'AbortError' })
  assert.equal(sent.length, count)
})
