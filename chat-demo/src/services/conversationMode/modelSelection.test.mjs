import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chooseEquivalentModel } from './modelSelection.ts'

const from = (provider, model) => ({ provider, model })
test('cross-provider exact IDs have precedence, including private and versioned models', () => {
  assert.equal(
    chooseEquivalentModel(from('custom', 'tenant/My-A'), 'custom', ['tenant/My-A', 'tenant/my-a']),
    'tenant/My-A'
  )
  assert.equal(
    chooseEquivalentModel(from('workbuddy', 'deepseek-v4-pro'), 'opencode', ['deepseek-v4-pro']),
    'deepseek-v4-pro'
  )
  assert.equal(
    chooseEquivalentModel(from('deepseek', 'deepseek-v4-pro'), 'openrouter', [
      'deepseek-v4-pro',
      'deepseek/deepseek-v4-pro-0813',
    ]),
    'deepseek-v4-pro'
  )
})
test('published release aliases map only when the destination reports the same release', () => {
  assert.equal(
    chooseEquivalentModel(from('deepseek', 'deepseek-flash'), 'openrouter', [
      'deepseek/deepseek-v4-flash',
      'deepseek/deepseek-v4.1-flash-1017',
    ]),
    'deepseek/deepseek-v4.1-flash-1017'
  )
  assert.equal(
    chooseEquivalentModel(from('openrouter', 'deepseek/deepseek-v4-pro-0813'), 'deepseek', [
      'deepseek-flash',
      'deepseek-v4-pro',
    ]),
    'deepseek-v4-pro'
  )
  assert.equal(
    chooseEquivalentModel(from('deepseek', 'deepseek-v4-flash-vision-exp'), 'deepseek', [
      'deepseek-flash',
    ]),
    'deepseek-flash'
  )
})
test('unknown endpoints, other snapshots, pricing tiers, quantization and spelling do not imply identity', () => {
  const canonical = from('deepseek', 'deepseek-flash')
  for (const mismatch of [
    'deepseek/deepseek-v4-flash',
    'deepseek/deepseek-v4.1-flash-1017:free',
    'deepseek/deepseek-v4.1-flash-1017:Q4_K_M',
    'DeepSeek/deepseek-v4.1-flash-1017',
  ]) {
    assert.equal(chooseEquivalentModel(canonical, 'openrouter', [mismatch]), undefined)
  }
  assert.equal(
    chooseEquivalentModel(canonical, 'custom', ['deepseek/deepseek-v4.1-flash-1017']),
    undefined
  )
  assert.equal(
    chooseEquivalentModel(from('custom', 'deepseek-flash'), 'openrouter', [
      'deepseek/deepseek-v4.1-flash-1017',
    ]),
    undefined
  )
  assert.equal(chooseEquivalentModel(canonical, 'openrouter', []), undefined)
})
