import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'

registerHooks({
  resolve(id, context, next) {
    if (id.startsWith('.') && id.endsWith('.js') && context.parentURL) {
      const ts = new URL(id.replace(/\.js$/, '.ts'), context.parentURL)
      if (existsSync(ts)) {
        return next(ts.href, context)
      }
    }
    return next(id, context)
  },
})
globalThis.__API_ORIGIN__ = 'https://api.deepseek.com'
const { LEGACY_LIST, LEGACY_KEY, migrateProfiles, persistProfiles } = await import('./profiles.ts')
const original = {
  id: 'custom',
  name: 'Provider',
  protocol: 'openai',
  origin: 'https://example.invalid/v1',
  model: 'sample',
  contextWindow: 4096,
  apiKey: 'test-profile-key',
}
function fixture() {
  const items = new Map([
    [LEGACY_LIST, JSON.stringify([original])],
    [LEGACY_KEY, 'test-single-key'],
    ['account', 'independent'],
  ])
  const legacy = {
    getItem: (key) => items.get(key) ?? null,
    removeItem: (key) => items.delete(key),
  }
  const vault = {
    data: null,
    async read() {
      return this.data
    },
    async write(value) {
      this.data = value
    },
  }
  return { items, legacy, vault }
}
test('migrate every profile including a divergent single key; keep account and profile ID', async () => {
  const { legacy, items, vault } = fixture()
  const profiles = await migrateProfiles(vault, legacy)
  assert.deepEqual(profiles[0], original)
  assert.equal(profiles[1].apiKey, 'test-single-key')
  assert.deepEqual([...items], [['account', 'independent']])
  assert.deepEqual(
    (await migrateProfiles(vault, legacy)).map((p) => p.apiKey),
    profiles.map((p) => p.apiKey)
  )
  await persistProfiles(vault, profiles.slice(1))
  assert.equal(vault.data.includes(original.apiKey), false)
  await persistProfiles(vault, [])
  assert.deepEqual(await migrateProfiles(vault, legacy), [])
})
test('failed readback, malformed input or failed keystore read preserves both legacy records', async () => {
  for (const fault of ['readback', 'corrupt-list', 'corrupt-vault', 'missing-keystore', 'quota']) {
    const { legacy, items, vault } = fixture()
    if (fault === 'readback') {
      vault.write = async () => {}
    }
    if (fault === 'corrupt-list') {
      items.set(LEGACY_LIST, '{')
    }
    if (fault === 'corrupt-vault') {
      vault.data = '{'
    }
    if (fault === 'missing-keystore') {
      vault.read = async () => {
        throw new Error()
      }
    }
    if (fault === 'quota') {
      vault.write = async () => {
        throw new Error()
      }
    }
    const before = [...items]
    await assert.rejects(migrateProfiles(vault, legacy))
    assert.deepEqual([...items], before)
  }
})
test('cleanup interruption can be retried without duplicate or overwritten profile', async () => {
  const { legacy, items, vault } = fixture()
  items.set(LEGACY_LIST, JSON.stringify([original, { ...original, apiKey: 'other-key' }]))
  await assert.rejects(
    migrateProfiles(vault, {
      ...legacy,
      removeItem(key) {
        if (key === LEGACY_LIST) {
          throw new Error('interrupted')
        }
        legacy.removeItem(key)
      },
    })
  )
  const next = await migrateProfiles(vault, legacy)
  assert.deepEqual(
    next.map((p) => p.id),
    ['custom', 'custom-legacy-2', 'default']
  )
  assert.deepEqual(
    next.map((p) => p.apiKey),
    [original.apiKey, 'other-key', 'test-single-key']
  )
})
test('concurrent legacy change is never deleted', async () => {
  const { legacy, items, vault } = fixture()
  vault.write = async (text) => {
    vault.data = text
    items.set(LEGACY_KEY, 'replacement')
  }
  await assert.rejects(migrateProfiles(vault, legacy), /legacy-changed/)
  assert.ok(items.has(LEGACY_LIST))
  assert.equal(items.get(LEGACY_KEY), 'replacement')
})
