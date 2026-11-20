import assert from 'node:assert/strict'
import test from 'node:test'
import { fetchLatestRelease } from './update.ts'

// Manual checks must see a freshly published release even during the background cache window.
test('manual check bypasses cached version and falls back when the first mirror stalls', async (t) => {
  const originalFetch = globalThis.fetch
  const versions = ['1.0.52', '1.0.53']
  const urls = []
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async (url, { signal }) => {
    urls.push(url)
    if (urls.length === 2) {
      return { ok: true, json: () => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))) }
    }
    const version = versions.shift()
    const manifest = { version, notes: '更新说明' }
    const body = url.includes('gitee.com')
      ? { content: Buffer.from(JSON.stringify(manifest)).toString('base64'), encoding: 'base64' }
      : manifest
    return { ok: true, json: async () => body }
  }
  assert.equal((await fetchLatestRelease()).version, '1.0.52')
  assert.equal((await fetchLatestRelease()).version, '1.0.52')
  const fresh = fetchLatestRelease(true)
  await Promise.resolve()
  t.mock.timers.tick(5000)
  assert.equal((await fresh).version, '1.0.53')
  assert.equal((await fetchLatestRelease()).version, '1.0.53')
  assert.equal(urls.length, 3)
})
