// Run against the web assets shipped in a release APK. All fixture data stays on localhost.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, resolve, sep } from 'node:path'
import { chromium } from 'playwright'

const root = resolve(process.argv[2] ?? 'chat-demo/android/app/src/main/assets/public')
const server = createServer(async (req, res) => {
  const path = resolve(root, '.' + (req.url === '/' ? '/index.html' : new URL(req.url, 'http://localhost').pathname))
  try {
    assert.ok(path.startsWith(root + sep))
    const body = await readFile(path)
    const mime = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' }
    res.writeHead(200, { 'Content-Type': mime[extname(path)] ?? 'application/octet-stream' }).end(body)
  } catch { res.writeHead(404).end() }
})
await new Promise(done => server.listen(0, '127.0.0.1', done))
const origin = `http://127.0.0.1:${server.address().port}`
const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' })
try {
  for (const reducedMotion of ['no-preference', 'reduce']) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, reducedMotion })
    page.setDefaultTimeout(4500)
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
    await page.addInitScript(() => {
      localStorage.setItem('chat-demo:locale', 'zh-CN')
      localStorage.setItem('chat-demo:api-profiles', JSON.stringify([{ id: 'offline', name: 'Offline', protocol: 'openai', model: 'fixture', origin: location.origin, apiKey: 'offline-fixture' }]))
      localStorage.setItem('chat-demo:active-profile', 'offline')
    })
    await page.goto(origin)
    const drawer = page.locator('[class^="drawer-"]')
    const front = name => page.locator(`[data-settings-route="${name}"][data-route-position="front"]`)
    const gone = sel => page.locator(sel).waitFor({ state: 'detached' })
    await page.getByRole('button', { name: '打开边栏', exact: true }).click()
    await drawer.getByRole('button', { name: '设置', exact: true }).click()
    await front('root').getByRole('button', { name: /API Key 管理/ }).click()
    const api = front('apiKey')
    await api.locator('[data-api-usage-entry]').click()
    const usage = page.locator('dialog[data-usage-source="settings"]')
    await usage.waitFor()
    await page.keyboard.press('Escape')
    if (reducedMotion === 'no-preference') {
      await usage.locator('[data-route-position="leaving"]').waitFor({ state: 'attached' })
      await page.keyboard.press('Escape')
    }
    await gone('dialog[data-usage-source]')
    await api.waitFor()
    await api.getByRole('button', { name: '申请官方 API Key' }).first().click()
    await front('guide').waitFor()
    await front('guide').getByRole('button').last().click()
    await front('apiEdit').waitFor()
    await page.evaluate(() => history.back())
    await gone('[data-settings-route="apiEdit"]')
    await front('guide').waitFor()
    await front('guide').locator('header button').click()
    await gone('[data-settings-route="guide"]')
    await api.locator('header button').click()
    await gone('[data-settings-route="apiKey"]')
    await front('root').locator('header button').click()
    await gone('[data-settings-shell]')
    assert.equal(await drawer.getAttribute('aria-hidden'), 'false')
    await drawer.getByRole('button', { name: '搜索历史对话' }).click()
    await page.locator('dialog:modal').waitFor()
    await page.keyboard.press('Escape')
    await gone('dialog:modal')
    assert.equal(await drawer.getAttribute('aria-hidden'), 'false')
    await page.evaluate(() => history.back())
    await page.waitForFunction(() => document.querySelector('[class^="drawer-"]')?.getAttribute('aria-hidden') === 'true')
    assert.equal(new URL(page.url()).origin, origin)
    assert.deepEqual(errors, [])
    console.log(`PASS (${reducedMotion}): usage → API keys, editor → guide → API keys → settings → drawer, history search → drawer → chat`)
    await page.close()
  }
} finally { await browser.close(); await new Promise(done => server.close(done)) }
