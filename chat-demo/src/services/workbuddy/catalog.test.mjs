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
const { refreshWorkBuddy, selectWorkBuddyModel, useWorkBuddyState } = await import('./provider.ts')
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
  assert.deepEqual(getWorkBuddyModel('kimi-k3-2'), { ...catalog[0], source: 'account' })
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
