import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

registerHooks({
  resolve(id, ctx, next) {
    if (id.startsWith('.') && id.endsWith('.js') && ctx.parentURL) {
      const url = new URL(id.replace(/\.js$/, '.ts'), ctx.parentURL)
      if (existsSync(url)) {
        return next(url.href, ctx)
      }
    }
    return next(id, ctx)
  },
})
const data = new Map()
globalThis.localStorage = {
  getItem: (key) => data.get(key) ?? null,
  setItem: (key, v) => data.set(key, v),
}
globalThis.__API_ORIGIN__ = 'https://api.deepseek.com'
const {
  getModelWindow,
  parseWindow,
  fallbackWindow,
  endpointProvider,
  allowsKeylessLocal,
  warmModelWindows,
  catalogWindow,
} = await import('./modelWindows.ts')
const { providerPresets } = await import('./providerPresets.ts')
const { loadCatalogModels } = await import('./modelCatalog.ts')
const { profileWindowKey, resolveWindow, withProfileWindow, saveBuiltinWindow } =
  await import('./contextOverrides.ts')
const { setWorkBuddyCatalog } = await import('../workbuddy/models.ts')
const { decodeLegacy } = await import('../security/profiles.ts')

test('every bundled ID has a finite budget, with a distinct input, output, upstream reference or fallback', async () => {
  for (const p of providerPresets) {
    const rows = await loadCatalogModels(p.value)
    assert.equal(p.value === 'custom' ? undefined : p.value, endpointProvider(p.origin))
    for (const row of rows) {
      const actual = getModelWindow(p.value, row.id)
      const label = `${p.value}/${row.id}`
      assert.ok(Number.isSafeInteger(actual.window) && actual.window > 0, label)
      if (row.scope === 'local-reference') {
        if (row.contextWindow) {
          assert.equal(actual.modelWindow, row.contextWindow, label)
        }
      } else if (
        row.contextWindow &&
        p.value !== 'deepseek' &&
        label !== 'openrouter/z-ai/glm-4.6'
      ) {
        assert.equal(actual.window, row.contextWindow, label)
      } else if (!row.contextWindow && row.inputLimit) {
        assert.equal(actual.window, row.inputLimit, label)
        assert.equal(actual.basis, 'input', label)
      }
      if (actual.basis === 'catalog') {
        assert.ok(actual.urls.includes(row.sourceUrl), label)
      }
    }
  }
  const out = catalogWindow({
    id: 'output-only',
    outputLimit: 32_000,
    sourceUrl: 'https://example.invalid',
  })
  assert.equal(out.window, fallbackWindow)
  assert.equal(out.output, 32_000)
  assert.equal(out.basis, 'fallback')
  assert.equal(getModelWindow('opencode', 'big-pickle').window, 200000)
  assert.equal(getModelWindow('opencode', 'big-pickle').input, 160000)
  assert.equal(getModelWindow('opencode', 'big-pickle').output, 32000)
  assert.equal(getModelWindow('spark', 'generalv3').window, 8192)
  assert.equal(getModelWindow('spark', 'generalv3').basis, 'input')
  assert.equal(getModelWindow('deepseek', 'deepseek-flash').window, 1048576)
  assert.equal(getModelWindow('deepseek', 'deepseek-flash').output, 393216)
  assert.equal(getModelWindow('opencode-go', 'deepseek-v4.1-flash').window, 1000000)
  assert.equal(endpointProvider('https://api.hunyuan.cloud.tencent.com/v1'), undefined)
  assert.equal(endpointProvider('https://api.sensenova.cn/compatible-mode/v1'), undefined)
  assert.equal(getModelWindow('private', 'deepseek-flash').basis, 'fallback')
  assert.equal(getModelWindow('OPENAI', 'gpt-4.1').basis, 'fallback')
})

test('local and enterprise discovery preserves the type of the limit through a vault roundtrip', () => {
  const base = {
    id: 'private',
    origin: 'http://10.0.2.2:11434/v1',
    protocol: 'openai',
    providerId: 'ollama',
    model: 'Llama',
    apiKey: '',
  }
  const key = profileWindowKey(base.origin, base.model, base.protocol)
  for (const kind of ['input', 'instance', 'endpoint', 'model']) {
    const [profile] = decodeLegacy(
      JSON.stringify([
        { ...base, discoveredWindows: { [key]: 8192 }, discoveredWindowKinds: { [key]: kind } },
      ]),
      null
    )
    const actual = resolveWindow({ profile, model: base.model })
    if (kind === 'model') {
      assert.equal(actual.spec.modelWindow, 8192)
      assert.equal(actual.window, 4096)
    } else {
      assert.equal(actual.window, 8192)
      assert.equal(actual.spec.basis, kind === 'input' ? 'input' : 'discovered')
    }
    assert.equal(resolveWindow({ profile, model: 'llama' }).window, 4096)
  }
  for (const origin of [
    'https://api.example.com',
    'http://localhost.example.com',
    'http://10.0.2.2@remote.example',
    'ftp://localhost',
  ]) {
    assert.equal(allowsKeylessLocal(origin, 'openai'), false, origin)
  }
  assert.equal(allowsKeylessLocal(base.origin, 'deepseek'), false)
})

test('valid legacy overrides survive upgrade, independence and reset per exact model, profile and origin', async () => {
  const original = {
    id: 'p1',
    name: 'Alpha',
    origin: 'https://api.openai.com/v1',
    protocol: 'openai',
    model: 'gpt-4.1',
    apiKey: 'private',
    contextWindow: 30000,
  }
  const [profile] = decodeLegacy(JSON.stringify([original]), null)
  const key = profileWindowKey(profile.origin, profile.model, profile.protocol)
  const target = { profile, model: profile.model }
  assert.equal(resolveWindow(target).window, 30000)
  const preset = { provider: 'openai', model: profile.model }
  saveBuiltinWindow(preset, 22_000)
  const edited = withProfileWindow(profile, key, 14_000)
  assert.equal(resolveWindow({ ...target, profile: edited }).window, 14000)
  assert.equal(resolveWindow({ profile: edited, model: 'gpt-4.1-mini' }).window, 30000)
  assert.equal(
    resolveWindow({ ...target, origin: 'https://elsewhere.invalid', profile: edited }).window,
    30000
  )
  assert.equal(resolveWindow(target).window, 30000)
  const reset = withProfileWindow(edited, key)
  assert.equal(resolveWindow({ ...target, profile: reset }).window, 22000)
  saveBuiltinWindow(preset)
  await warmModelWindows('openai')
  assert.equal(resolveWindow({ ...target, profile: reset }).window, 1047576)
  assert.equal(resolveWindow({ profile: reset, model: 'gpt-4.1-mini' }).window, 30000)
  const [again] = decodeLegacy(JSON.stringify([reset]), null)
  assert.equal(again.contextWindows[key], null)
})

test('native account and WorkBuddy grant preferences cannot cross channels, accounts or models', async () => {
  const account = { channel: 'account', model: 'deepseek-v4-pro', grant: 'a' }
  const wb = { channel: 'workbuddy', model: account.model, grant: 'a' }
  assert.equal(resolveWindow(account).window, 1048576)
  assert.equal(resolveWindow(wb).window, 1000000)
  assert.equal(resolveWindow(wb).spec.basis, 'bundled')
  setWorkBuddyCatalog([
    { id: wb.model, name: 'Pro', contextWindow: 22000, contextTiers: [22000, 44000] },
    { id: 'gateway-only', name: 'Gateway' },
  ])
  try {
    assert.equal(resolveWindow(wb).window, 22000)
    assert.deepEqual(resolveWindow(wb).spec.tiers, [22000, 44000])
    assert.equal(resolveWindow({ ...wb, model: 'gateway-only' }).spec.basis, 'fallback')
    saveBuiltinWindow(wb, 12000)
    assert.equal(resolveWindow({ ...wb, grant: 'b' }).window, 22000)
    assert.equal(resolveWindow(account).window, 1048576)
    saveBuiltinWindow(account, 8_000)
    assert.equal(resolveWindow({ ...account, model: 'deepseek-flash' }).window, 1048576)
    const reloaded = await import('./contextOverrides.ts?reload=1')
    assert.equal(reloaded.resolveWindow(account).window, 8000)
    assert.equal(reloaded.resolveWindow(wb).window, 12000)
  } finally {
    setWorkBuddyCatalog(null)
    saveBuiltinWindow(wb)
    saveBuiltinWindow(account)
  }
})

test('manual editor accepts only positive safe integers', () => {
  for (const invalid of [
    '',
    ' ',
    '-1',
    '0',
    ' 12',
    '12.5',
    '12k',
    '12,000',
    'Infinity',
    '1e6',
    '9007199254740992',
  ]) {
    assert.equal(parseWindow(invalid), undefined, invalid)
  }
  assert.equal(parseWindow('1'), 1)
  assert.equal(parseWindow('1048576'), 1048576)
})
