import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

registerHooks({
  resolve(id, context, next) {
    if (id.startsWith('.') && id.endsWith('.js') && context.parentURL) {
      const path = new URL(id.replace(/\.js$/, '.ts'), context.parentURL)
      if (existsSync(path)) {
        return next(path.href, context)
      }
    }
    return next(id, context)
  },
})

test('normal Android settings entry points verify changes in the vault and never write plaintext to Web storage', async () => {
  globalThis.__API_ORIGIN__ = 'https://api.deepseek.com'
  const profile = {
    id: 'kept-id',
    name: 'Old profile',
    model: 'sample',
    protocol: 'openai',
    origin: 'https://first.invalid',
    apiKey: 'synthetic-old',
  }
  const local = new Map([
    ['chat-demo:api-profiles', JSON.stringify([profile])],
    ['chat-demo:active-profile', profile.id],
    ['chat-demo:api-key', profile.apiKey],
  ])
  const writes = []
  globalThis.localStorage = {
    getItem: (key) => local.get(key) ?? null,
    removeItem: (key) => local.delete(key),
    setItem(key, value) {
      writes.push([key, value])
      local.set(key, value)
    },
  }
  let envelope = null
  let unlocked = false
  const port = {
    postMessage(raw) {
      const { id, op, value } = JSON.parse(raw)
      const response = { id }
      if (op === 'status') {
        response.value = { enabled: true, unlocked, vault: true, available: true }
      } else if (!unlocked) {
        response.error = 'locked'
      } else if (op === 'read') {
        response.value = envelope
      } else if (op === 'write') {
        envelope = value
        response.value = true
      }
      queueMicrotask(() => port.onmessage({ data: JSON.stringify(response) }))
    },
  }
  globalThis.window = Object.assign(new EventTarget(), {
    DeepChatSecurity: port,
    DshNative: {},
    setTimeout,
    clearTimeout,
  })
  const { refreshSecurity } = await import('./bridge.ts')
  const {
    useSettings,
    initializeCredentials,
    saveApiProfile,
    removeApiProfile,
    selectApiProfile,
    createApiProfile,
    clearApiProfiles,
    setApiKey,
    setChatSource,
  } = await import('../settings.ts')
  await refreshSecurity()
  await assert.rejects(initializeCredentials())
  assert.equal(useSettings.getState().apiKey, null)
  assert.ok(local.has('chat-demo:api-key'))
  unlocked = true
  await refreshSecurity()
  await initializeCredentials()
  assert.equal(useSettings.getState().apiKey, profile.apiKey)
  assert.ok(!local.has('chat-demo:api-key') && !local.has('chat-demo:api-profiles'))
  const added = { ...createApiProfile(), name: 'New', apiKey: 'synthetic-new' }
  await saveApiProfile(added)
  await setApiKey('synthetic-edited')
  await selectApiProfile(profile.id)
  assert.equal(useSettings.getState().apiKey, profile.apiKey)
  await removeApiProfile(profile.id)
  assert.equal(useSettings.getState().apiKey, 'synthetic-edited')
  assert.ok(!envelope.includes(profile.apiKey))
  setChatSource('account')
  await clearApiProfiles()
  assert.equal(useSettings.getState().chatSource, 'account')
  assert.deepEqual(JSON.parse(envelope).profiles, [])
  assert.doesNotMatch(JSON.stringify(writes), /synthetic-|chat-demo:api-key|chat-demo:api-profiles/)
})
