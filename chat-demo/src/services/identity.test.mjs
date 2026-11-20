import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

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
})

const a = '12345678-1234-4123-8123-123456789abc'
const b = '22345678-1234-4123-8123-123456789abc'
const c = '32345678-1234-4123-8123-123456789abc'
const model = 'deepseek-v4.1-flash'
const cache = 'chat-demo:workbuddy-route:v1'
const storage = new Map([
  ['chat-demo:display-name', 'Old local user'],
  ['chat-demo:avatar', 'data:image/png;base64,old'],
  [cache, JSON.stringify({ revision: a, model })],
  ['chat-demo:chat-source', 'api'],
])
globalThis.localStorage = {
  getItem: (k) => storage.get(k) ?? null,
  setItem: (k, v) => storage.set(k, v),
  removeItem: (k) => storage.delete(k),
}
const requests = []
const wb = { postMessage: (raw) => requests.push(JSON.parse(raw)) }
const dsh = { postMessage: () => {} }
globalThis.window = { WorkBuddyChat: wb, DshNative: dsh }
globalThis.__API_ORIGIN__ = 'https://api.deepseek.com'
const { useSettings, applyAccountProfile } = await import('./settings.ts')
const { initializeAccount } = await import('../shell/account.ts')
const { refreshWorkBuddy, disconnectWorkBuddy } = await import('./workbuddy/provider.ts')
const { useAccountIdentity, setIdentityPreference } = await import('./identity.ts')
initializeAccount(applyAccountProfile)
function identity() {
  let value
  function Consumer() {
    value = useAccountIdentity()
    return null
  }
  renderToStaticMarkup(React.createElement(Consumer))
  return value
}
function dshStatus(fields) {
  dsh.onmessage({ data: JSON.stringify({ type: 'account', ...fields }) })
}
function reply(request, fields) {
  wb.onmessage({ data: JSON.stringify({ type: 'status', id: request.id, ...fields }) })
}
async function wbStatus(fields, op = refreshWorkBuddy) {
  const pending = op()
  reply(requests.shift(), fields)
  await pending
}

test('cold start discards the retired local identity and waits for native account confirmation', () => {
  assert.equal(storage.has('chat-demo:display-name'), false)
  assert.equal(storage.has('chat-demo:avatar'), false)
  assert.ok(storage.has(cache))
  assert.deepEqual(identity(), { dsh: null, workbuddy: null, selected: null, canChoose: false })
})

test('single and dual login select live profiles independently from the chat channel', async () => {
  const image = 'https://images.example.com/ada.jpg'
  dshStatus({ signedIn: true, revision: a, name: '  Ada  ', avatar: image, token: 'private' })
  assert.deepEqual(identity().selected, { source: 'dsh', name: 'Ada', avatar: image, revision: a })
  setIdentityPreference('workbuddy')
  assert.equal(storage.has('chat-demo:identity-source'), false)
  await wbStatus({
    revision: b,
    model,
    name: ' WB ',
    avatar: 'https://images.example.com/wb.png',
    uid: 'private',
  })
  assert.equal(identity().canChoose, true)
  assert.equal(identity().selected.source, 'dsh')
  setIdentityPreference('workbuddy')
  assert.equal(identity().selected.name, 'WB')
  assert.equal(storage.get('chat-demo:identity-source'), 'workbuddy')
  assert.equal(useSettings.getState().chatSource, 'api')
  assert.deepEqual(JSON.parse(storage.get(cache)), { model, revision: b })
  for (const value of storage.values()) {
    assert.doesNotMatch(value, /Ada|images\.example|private/)
  }
  await wbStatus({ name: 'leaked old name', avatar: image }, disconnectWorkBuddy)
  assert.equal(identity().workbuddy, null)
  assert.equal(identity().selected.source, 'dsh')
  dshStatus({ signedIn: false, revision: a, name: 'old', avatar: image })
  assert.equal(identity().selected, null)
  await wbStatus({ revision: c, model, name: 'Jo' })
  assert.deepEqual(identity().selected, {
    source: 'workbuddy',
    name: 'Jo',
    avatar: null,
    revision: c,
  })
  dshStatus({ signedIn: true, revision: a, name: '', avatar: 'file:///secret' })
  assert.equal(identity().dsh.name, 'DSH')
  assert.equal(identity().dsh.avatar, null)
  assert.equal(identity().selected.name, 'Jo')
})

test('delayed profile enrichment updates the same revision and cannot resurrect another login', async () => {
  await wbStatus({ revision: a, model, profileRefresh: true })
  const first = requests.shift()
  assert.deepEqual({ op: first.op, revision: first.revision }, { op: 'profile', revision: a })
  assert.equal(identity().selected.name, 'WorkBuddy')
  reply(first, {
    type: 'profile',
    revision: a,
    profileVersion: 2,
    name: 'Late name',
    avatar: 'https://images.example.com/p.png',
  })
  await new Promise(setImmediate)
  assert.equal(identity().selected.name, 'Late name')
  assert.equal(identity().selected.avatar, 'https://images.example.com/p.png')
  await wbStatus({ revision: a, model, profileVersion: 1, name: 'Older name', avatar: '' })
  assert.equal(identity().selected.name, 'Late name')
  await wbStatus({ revision: a, model, profileVersion: 3, avatar: '' })
  assert.equal(identity().selected.avatar, null)
  await wbStatus({ revision: b, model, profileRefresh: true })
  const stale = requests.shift()
  await wbStatus({}, disconnectWorkBuddy)
  await wbStatus({
    revision: c,
    model,
    name: 'Replacement',
    avatar: 'https://user:password@example.com/',
  })
  reply(stale, {
    type: 'profile',
    revision: b,
    name: 'Previous user',
    avatar: 'https://images.example.com/previous.png',
  })
  await new Promise(setImmediate)
  assert.deepEqual(identity().selected, {
    source: 'workbuddy',
    revision: c,
    name: 'Replacement',
    avatar: null,
  })
  const pending = refreshWorkBuddy(),
    staleStatus = requests.shift()
  await wbStatus({}, disconnectWorkBuddy)
  reply(staleStatus, { revision: c, model, name: 'Previous login' })
  await pending
  assert.equal(identity().workbuddy, null)
})

test('a confirmed identity can precede chat model data and older hosts have a display-only lifetime', async () => {
  dshStatus({ signedIn: false })
  await wbStatus({
    revision: a,
    name: 'Account only',
    avatar: 'https://images.example.com/p?access_token=secret',
  })
  assert.equal(identity().selected.name, 'Account only')
  assert.equal(identity().selected.avatar, null)
  assert.equal(storage.has(cache), false)
  await wbStatus({}, disconnectWorkBuddy)
  dshStatus({ signedIn: true, name: 'Mac user' })
  const first = identity().selected.revision
  assert.equal(identity().selected.name, 'Mac user')
  assert.equal(useSettings.getState().accountRevision, null)
  dshStatus({ signedIn: false })
  dshStatus({ signedIn: true, name: 'Other Mac user' })
  assert.notEqual(identity().selected.revision, first)
  assert.equal(identity().selected.name, 'Other Mac user')
})

test('a rejected enrichment rechecks native sign-in and clears the expired identity', async () => {
  await wbStatus({ revision: b, model, name: 'Before expiry', profileRefresh: true })
  const pending = requests.shift()
  reply(pending, { type: 'error', code: 'sign_in_expired' })
  await new Promise(setImmediate)
  const status = requests.shift()
  assert.equal(status.op, 'status')
  reply(status, {})
  await new Promise(setImmediate)
  assert.equal(identity().workbuddy, null)
  assert.equal(identity().selected.name, 'Other Mac user')
})
