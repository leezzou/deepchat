import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import test from 'node:test'

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
const first = '12345678-1234-4abc-8abc-123456789abc'
const second = '87654321-1234-4abc-8abc-123456789abc'
const old = 'deepseek-v4-pro'
let reply
const port = { postMessage: (raw) => queueMicrotask(() => reply(JSON.parse(raw))) }
const response = (id, frame) =>
  port.onmessage({ data: JSON.stringify({ id, type: 'status', ...frame }) })
globalThis.window = { WorkBuddyChat: port }
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
globalThis.__API_ORIGIN__ = 'https://api.deepseek.com'
const {
  refreshWorkBuddy,
  refreshWorkBuddyCatalog,
  watchWorkBuddyCatalog,
  selectWorkBuddyModel,
  useWorkBuddyState,
} = await import('./provider.ts')
const { getWorkBuddyModel, isWorkBuddyModel } = await import('./models.ts')

test('account roster drives selection, context and native revision without admitting invented IDs', async () => {
  const catalog = [
    { id: 'kimi-k3-2', name: 'Kimi K3', contextWindow: 200000, contextTiers: [200000, 1000000] },
  ]
  let selected
  reply = ({ id, op, ...fields }) => {
    if (op === 'model') {
      selected = fields
    }
    response(id, { revision: first, model: selected?.model ?? old, catalog })
  }
  await refreshWorkBuddy()
  const model = getWorkBuddyModel('kimi-k3-2')
  assert.equal(model.source, 'account')
  assert.equal(model.contextWindow, 1000000)
  assert.deepEqual(model.contextTiers, [200000, 1000000])
  assert.equal(isWorkBuddyModel(old), false)
  await assert.rejects(selectWorkBuddyModel('not-in-directory'), /Unknown model/)
  await selectWorkBuddyModel('kimi-k3-2')
  assert.deepEqual(selected, { model: 'kimi-k3-2', revision: first })
})

test('a late native catalog cannot replace a different login or lift an explicit empty roster', async () => {
  let catalogCall
  const waitCatalog = new Promise((resolve) => {
    catalogCall = resolve
  })
  reply = ({ id, op, revision }) => {
    if (op === 'catalog') {
      catalogCall({ id, revision })
      return
    }
    response(id, { revision: first, model: old, catalogRefresh: true })
  }
  await refreshWorkBuddy()
  const request = await waitCatalog
  assert.equal(request.revision, first)
  reply = ({ id }) => response(id, { revision: second, model: old, catalog: [] })
  await refreshWorkBuddy()
  response(request.id, {
    revision: first,
    model: old,
    catalog: [{ id: 'unrelated', name: 'Unrelated' }],
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(useWorkBuddyState.getState().metadata.revision, second)
  assert.deepEqual(useWorkBuddyState.getState().models, [])
  // A revoked model takes the user to account settings, including on a WorkBuddy-only bridge.
  const { useSettings } = await import('../settings.ts')
  const { ensureApiKey, useSettingsDialog } =
    await import('../../components/settings/settingsDialogState.ts')
  useSettings.setState({ chatSource: 'workbuddy' })
  assert.equal(ensureApiKey(), false)
  assert.equal(useSettingsDialog.getState().visits.at(-1)?.section, 'general')
  assert.equal(isWorkBuddyModel(old), false)
  assert.equal(isWorkBuddyModel('unrelated'), false)
  reply = ({ id }) => response(id, { revision: second, model: old })
  await refreshWorkBuddy()
  assert.equal(isWorkBuddyModel(old), true)
  assert.equal(getWorkBuddyModel(old).contextWindow, 1_000_000)
})

test('fresh prices, free, unknown, retry and full roster replacement use one account snapshot', async () => {
  const updated = Date.now()
  const models = [
    { id: 'paid', name: 'Paid', rate: { multiplier: 0.79, free: true } },
    { id: 'free', name: 'Free', rate: { multiplier: 0, free: true } },
    { id: 'unknown', name: 'Unknown', rate: { free: true } },
  ]
  let status = { model: old, revision: first, catalog: models, catalogUpdatedAt: updated }
  let calls = 0,
    release
  reply = ({ id, op }) => {
    if (op === 'catalog') {
      calls++
      release = () => response(id, status)
    } else {
      response(id, status)
    }
  }
  await refreshWorkBuddy()
  await refreshWorkBuddyCatalog()
  assert.equal(calls, 0)
  assert.deepEqual(getWorkBuddyModel('paid').rate, { multiplier: 0.79 })
  assert.deepEqual(getWorkBuddyModel('free').rate, { multiplier: 0, free: true })
  assert.equal(getWorkBuddyModel('unknown').rate, undefined)
  status = { ...status, catalogError: true, catalogStale: true }
  const concurrent = [refreshWorkBuddyCatalog(true), refreshWorkBuddyCatalog(true)]
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls, 1)
  assert.equal(useWorkBuddyState.getState().catalogLoading, true)
  release()
  await Promise.all(concurrent)
  assert.equal(useWorkBuddyState.getState().catalogLoading, false)
  assert.equal(useWorkBuddyState.getState().catalogStale, true)
  assert.equal(useWorkBuddyState.getState().catalogUpdatedAt, updated)
  assert.deepEqual(getWorkBuddyModel('paid').rate, { multiplier: 0.79 })
  await refreshWorkBuddyCatalog()
  assert.equal(calls, 1)
  status = {
    model: old,
    revision: first,
    catalog: [{ id: 'paid', name: 'Paid', rate: { multiplier: 0.95 } }],
    catalogUpdatedAt: updated + 1,
  }
  const refresh = refreshWorkBuddyCatalog(true)
  await new Promise((resolve) => setImmediate(resolve))
  release()
  await refresh
  assert.equal(useWorkBuddyState.getState().catalogStale, false)
  assert.equal(getWorkBuddyModel('free'), undefined)
  assert.deepEqual(getWorkBuddyModel('paid').rate, { multiplier: 0.95 })
})

test('foreground rechecks native revision and tears down listeners on unmount', async (t) => {
  const now = Date.now()
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now })
  const events = new EventTarget()
  globalThis.document = Object.assign(events, { visibilityState: 'visible' })
  globalThis.window.addEventListener = events.addEventListener.bind(events)
  globalThis.window.removeEventListener = events.removeEventListener.bind(events)
  let calls = 0,
    revision = first
  reply = ({ id, op }) => {
    assert.equal(op, 'status')
    calls++
    const boundary = revision === first ? 1_000 : 2_000
    const catalog = [{ id: revision === first ? 'first' : 'second', name: 'Rate', rate: { multiplier: 1 }, promotions: [{ price: 0, validUntil: new Date(now + boundary).toISOString() }] }]
    response(id, { revision, model: old, catalog, catalogUpdatedAt: Date.now() })
  }
  const stop = watchWorkBuddyCatalog()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls, 1)
  document.visibilityState = 'hidden'
  events.dispatchEvent(new Event('visibilitychange'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls, 1)
  revision = second
  document.visibilityState = 'visible'
  events.dispatchEvent(new Event('visibilitychange'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(useWorkBuddyState.getState().metadata.revision, second)
  assert.equal(getWorkBuddyModel('first'), undefined)
  assert.equal(getWorkBuddyModel('second').rate.free, true)
  const current = useWorkBuddyState.getState().models
  t.mock.timers.tick(1_000)
  assert.equal(useWorkBuddyState.getState().models, current)
  stop()
  t.mock.timers.tick(1_000)
  assert.equal(useWorkBuddyState.getState().models, current)
  events.dispatchEvent(new Event('online'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls, 2)
})
