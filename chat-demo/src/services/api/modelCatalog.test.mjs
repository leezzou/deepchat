import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

// Node strips TypeScript and reads the same provider JSON as Rspack.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === './providerPresets.js' && context.parentURL?.endsWith('/modelCatalog.ts')) {
      return next('./providerPresets.ts', context)
    }
    return next(specifier, context)
  },
})
const { loadCatalogModels, resolveCatalogModel } = await import('./modelCatalog.ts')

test('cold lookup parses no model list and concurrent loads share an immutable result', async () => {
  assert.equal(resolveCatalogModel('opencode', 'big-pickle'), undefined)
  const first = loadCatalogModels('opencode')
  assert.equal(first, loadCatalogModels('opencode'))
  const rows = await first
  const entry = resolveCatalogModel('opencode', 'big-pickle')
  assert.ok(Object.isFrozen(rows) && Object.isFrozen(entry))
  assert.ok(rows.includes(entry))
  assert.deepEqual(
    [entry.contextWindow, entry.inputLimit, entry.outputLimit],
    [200000, 160000, 32000]
  )
  assert.equal(entry.sourceUrl, 'https://opencode.ai/inference/openai/v1/models')
  assert.equal(resolveCatalogModel('opencode-go', 'big-pickle'), undefined)
  assert.equal(resolveCatalogModel('opencode', 'BIG-PICKLE'), undefined)
})

test('official input limits do not become invented total windows', async () => {
  await loadCatalogModels('spark')
  const entry = resolveCatalogModel('spark', '4.0Ultra')
  assert.equal(entry?.contextWindow, undefined)
  assert.equal(entry?.inputLimit, 32768)
})

test('custom servers and unknown provider IDs do not load a catalog', async () => {
  for (const id of ['custom', '__proto__', '../api', 'OPENAI']) {
    assert.deepEqual(await loadCatalogModels(id), [])
  }
})

test('published local model examples carry their local scope', async () => {
  const rows = await loadCatalogModels('lmstudio')
  assert.ok(rows.length > 0 && rows.every((row) => row.scope === 'local-reference'))
  assert.equal(resolveCatalogModel('lmstudio', 'local-model'), undefined)
})
