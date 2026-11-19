// Run against the production web assets. All network requests stay inside the fixture.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const dist = path.resolve(process.argv[2] ?? fileURLToPath(new URL('../chat-demo/dist', import.meta.url)))
const origin = 'https://localhost'
const mime = { '.css': 'text/css', '.js': 'text/javascript', '.html': 'text/html', '.woff2': 'font/woff2' }
const browser = await chromium.launch({ channel: 'chrome' })
try {
  const page = await browser.newPage({ viewport: { width: 360, height: 760 }, locale: 'zh-CN' })
  const errors = []
  page.on('pageerror', err => errors.push(err.message))
  let blockMain = true
  await page.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.origin !== origin) return route.abort()
    if (blockMain && /\/main\.[a-f\d]+\.js$/.test(url.pathname)) return route.abort()
    const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
    const file = path.join(dist, name)
    try { return await route.fulfill({ contentType: mime[path.extname(file)], body: await readFile(file) }) }
    catch { return route.abort() }
  })
  await page.addInitScript(() => {
    // Exercise the startup path without optional region names or persisted disk data.
    delete Intl.DisplayNames
    delete Promise.allSettled
    delete window.structuredClone
    delete URL.canParse
    delete Blob.prototype.arrayBuffer
    delete Blob.prototype.stream
    localStorage.setItem('chat-demo:api-key', 'fixture')
  })
  await page.goto(origin)
  const retry = page.getByRole('button', { name: '重新加载' })
  await retry.waitFor()
  assert.match(await page.locator('[data-version]').innerText(), /Chromium \d+/)
  blockMain = false
  await retry.click()
  const composer = page.locator('main textarea')
  await composer.fill('启动检查')
  assert.deepEqual(errors, [])
  assert.equal(await composer.inputValue(), '启动检查')
  const main = await page.locator('main').first().boundingBox()
  assert.ok(main && main.height > 700 && main.width >= 350)
  assert.equal(await retry.count(), 0)
  await page.addInitScript(() => {
    IDBFactory.prototype.open = () => { throw new DOMException('Disk unavailable', 'UnknownError') }
  })
  await page.reload()
  await page.getByRole('button', { name: '重试' }).first().waitFor()
  assert.equal(await retry.count(), 0)
  assert.deepEqual(errors, [])
  console.log('PASS: failed entry → retry → usable full-height mobile composer without Intl.DisplayNames; storage failure shows retry')
} finally {
  await browser.close()
}
