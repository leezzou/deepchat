import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerHooks } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { experiments } from '@rspack/core'
import { fileURLToPath } from 'node:url'
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
    const filename = fileURLToPath(url)
    const { code: source } = experiments.swc.transformSync(readFileSync(filename, 'utf8'), {
      filename, jsc: { parser: { syntax: 'typescript' }, target: 'es2022' }, module: { type: 'es6' },
    })
    return { source, format: 'module', shortCircuit: true }
  },
})

globalThis.window = new EventTarget()
globalThis.__API_ORIGIN__ = 'https://api.deepseek.com'
const direct = [], sent = []
let next
const port = window.DeepChatProfile = { postMessage(raw) { const frame = JSON.parse(raw); sent.push(frame); next?.(frame) } }
const reply = (id, frame) => port.onmessage({ data: JSON.stringify({ id, ...frame }) })
globalThis.fetch = async (...args) => { direct.push(args); return Response.json({ ok: true }) }
const { useSettings } = await import('../services/settings.ts')
const { getChatAccess } = await import('../services/api/access.ts')
const { request } = await import('../services/api/client.ts')
const { profileChatFetch } = await import('./profileChat.ts')
const fakeKey = 'dummy-secret', profileId = 'saved-A'
const profile = (origin, protocol) => ({ id: profileId, name: 'fixture', model: protocol === 'deepseek' ? 'deepseek-flash' : 'fixture-model', origin, protocol, apiKey: fakeKey })
function select(origin, protocol) { const p = profile(origin, protocol); useSettings.setState({ chatSource: 'api', apiProfiles: [p], activeProfileId: profileId, apiKey: fakeKey }); return getChatAccess() }
function init(body, signal) { return { method: 'POST', body, signal, headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' } } }
function server(status, response, contentType = 'text/event-stream') {
  const started = [], bytes = [], max = 48 * 1024
  let start
  next = f => {
    if (f.op === 'start') { start = f; started.push(f); queueMicrotask(() => reply(f.id, { type: 'pull', offset: 0, length: Math.min(max, f.length) })) }
    if (f.op !== 'chunk') return
    const buf = Buffer.from(f.data,'base64'); bytes.push(buf)
    const offset = f.offset + buf.length
    if (offset < start.length) return queueMicrotask(() => reply(f.id, { type: 'pull', offset, length: Math.min(max, start.length - offset) }))
    reply(f.id, { type: 'headers', status, contentType })
    const payload = Buffer.from(response)
    for (let i = 0; i < payload.length; i += 7) reply(f.id, { type: 'data', data: payload.subarray(i, i + 7).toString('base64') })
    reply(f.id, { type: 'end' })
  }
  return { started, bytes }
}

test('selected chat/messages/responses use only native route metadata and losslessly frame Unicode SSE/JSON', async () => {
  direct.length = 0
  for (const [origin, protocol, operation, path] of [
    ['https://fixture.invalid:8443/private/v1','openai','chat','/chat/completions'],
    ['https://api.anthropic.com','openai','messages','/v1/messages'], ['https://api.anthropic.com/v1','anthropic','messages','/messages'],
    ['https://api.deepseek.com','deepseek','messages','/anthropic/v1/messages'], ['https://api.openai.com/v1','openai','responses','/responses']]) {
    sent.length = 0
    const access = select(origin, protocol), input = JSON.stringify({ model: access.config.model, input: '说🙂'.repeat(18000) })
    const out = operation === 'responses' ? '{"result":"中文🙂"}' : 'data: {"text":"中文🙂"}\n\n'
    const fixture = server(200, out, operation === 'responses' ? 'application/json' : 'text/event-stream')
    const res = await request(origin + path, init(input), access)
    assert.equal(await res.text(), out); assert.equal(Buffer.concat(fixture.bytes).toString(), input); assert.ok(fixture.bytes.length > 1)
    assert.equal(fixture.started.length, 1); assert.equal(fixture.started[0].profileId, profileId); assert.equal(fixture.started[0].operation, operation)
    assert.equal(fixture.started[0].digest.length, 64); assert.ok(!JSON.stringify(fixture.started[0]).includes(fakeKey)); assert.equal(fixture.started[0].url, undefined)
    assert.equal(direct.length, 0)
  }
})

test('retains service error and HTTP code; never duplicates a failed or redirected POST', async () => {
  direct.length = 0
  const access = select('https://fixture.invalid/v1','openai'), url = access.config.origin + '/chat/completions'
  for (const status of [307, 401, 422, 429, 503]) {
    const fixture = server(status, status === 307 ? '' : '{"error":{"message":"model quota for fixture"}}', 'application/json')
    await assert.rejects(request(url, init('{}'), access), e => e.status === status && e.message === (status === 307 ? `HTTP ${status}` : 'model quota for fixture'))
    assert.equal(fixture.started.length, 1); assert.equal(direct.length, 0)
  }
})

test('abort, profile rotation, page detach and injected late frames cannot resume a request', async () => {
  direct.length = 0
  for (const reason of ['user', 'profile', 'page']) {
    const access = select('https://fixture.invalid/v1','openai'), ctrl = new AbortController(), url = access.config.origin + '/chat/completions'
    let started
    const began = new Promise(resolve => { started = resolve })
    sent.length = 0; next = f => { if (f.op === 'start') started(f) }
    const pending = profileChatFetch(access, url, init('{}',ctrl.signal))
    const f = await began
    if (reason === 'user') ctrl.abort()
    else if (reason === 'profile') useSettings.setState({ apiProfiles: [{ ...profile(access.config.origin, 'openai'), apiKey: 'rotated' }] })
    else window.dispatchEvent(new Event('pagehide'))
    await assert.rejects(pending)
    reply(f.id,{ type:'pull', offset:0, length:2 }); assert.deepEqual(sent.map(v=>v.op),['start','cancel']); assert.equal(direct.length,0)
  }
})

test('only the selected chat operations enter the profile bridge', async () => {
  const access = select('https://fixture.invalid/v1','openai'), base = access.config.origin
  for (const url of [base + '/models', base + '/files', base + '/responses', base + '/chat/completions?other=1', 'https://other.invalid/v1/chat/completions']) {
    assert.equal(profileChatFetch(access, url, init('{}')), undefined)
  }
  await assert.rejects(profileChatFetch({ ...access, profileId: 'another' }, base + '/chat/completions', init('{}')), /profile changed/)
  await assert.rejects(profileChatFetch({ ...access, key: 'stale' }, base + '/chat/completions', init('{}')), /profile changed/)
})
