// Run after building chat-demo. Serves only the local build into an isolated browser context.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const dist = fileURLToPath(new URL('../chat-demo/dist/', import.meta.url))
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' })
try {
  for (const [width, height] of [[390, 844], [820, 1180]]) {
    const context = await browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/*', async route => {
      const url = new URL(route.request().url())
      if (url.pathname === '/expired.zip') return route.fulfill({ status: 403, body: 'Expired' })
      if (url.origin !== 'http://localhost') return route.abort()
      const relative = decodeURIComponent(url.pathname.slice(1)) || 'index.html'
      const asset = path.resolve(dist, relative)
      if (!asset.startsWith(dist)) return route.abort()
      try { await route.fulfill({ path: asset }) } catch { await route.fulfill({ status: 404, body: '' }) }
    })
    await page.addInitScript(() => { localStorage.setItem('chat-demo:locale', 'zh-CN'); localStorage.setItem('chat-demo:api-key', 'synthetic-only') })
    await page.goto('http://localhost/')
    if (width < 768) await page.getByRole('button', { name: '打开边栏', exact: true }).click()
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('button', { name: '数据管理', exact: true }).click()
    await page.locator('input[type="file"][accept*="zip"]').setInputFiles({ name: 'bad.zip', mimeType: 'application/zip', buffer: Buffer.from('synthetic invalid archive') })
    await page.getByRole('button', { name: '确认导入', exact: true }).click()
    const first = page.locator('[data-import-state="failed"][data-import-stage="validating"]')
    await first.waitFor()
    assert.match(await first.textContent(), /ZIP/)
    assert.match(await first.textContent(), /重新下载|导出/)
    await page.locator('input[inputmode="url"]').fill('http://localhost/expired.zip?signature=synthetic-private')
    await page.getByRole('button', { name: /下载并导入/ }).click()
    const linkError = page.locator('[data-import-state="failed"][data-import-stage="downloading"]')
    await linkError.waitFor()
    const text = await linkError.textContent()
    assert.match(text, /403/)
    assert.match(text, /新的导出链接/)
    assert.ok(!text.includes('signature'))
    const bounds = await linkError.boundingBox()
    assert.ok(bounds.width > 0 && bounds.x >= 0 && bounds.x + bounds.width <= width + 1)
    const overflow = await linkError.evaluate(el => el.scrollWidth > el.clientWidth + 1)
    assert.equal(overflow, false)
    assert.deepEqual(errors, [])
    console.log(JSON.stringify({ width, height, badZip: true, expiredLink: text, fits: true }))
    await context.close()
  }
} finally { await browser.close() }
