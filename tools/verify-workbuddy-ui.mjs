// Pass the web assets extracted from the v1.0.48 APK. No wallet, account or network mocks.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, resolve, sep } from 'node:path'
import { chromium } from 'playwright'

assert.ok(process.argv[2], 'Supply the extracted assets/public directory')
const assets = resolve(process.argv[2])
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webp': 'image/webp', '.woff2': 'font/woff2' }
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost')
    const file = resolve(assets, `.${url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)}`)
    assert.ok(req.method === 'GET' && file.startsWith(assets + sep))
    const body = await readFile(file)
    res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' }).end(body)
  } catch { res.writeHead(404).end() }
})
await new Promise(done => server.listen(0, '127.0.0.1', done))
const origin = `http://127.0.0.1:${server.address().port}`
const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' })
const walletCopy = /Credits and usage|View on WorkBuddy|Available credits|Daily automatic check-in|My credits|WorkBuddy account|Sign in to WorkBuddy/i

async function assertPrivate(page) {
  assert.equal(await page.locator('[data-wb-panel],[data-wb-balance],[data-wb-auto]').count(), 0)
  assert.doesNotMatch(await page.locator('body').innerText(), walletCopy)
}

async function inspectPanel(page) {
  const panel = page.locator('[data-wb-panel]')
  await panel.waitFor()
  await panel.getByRole('button', { name: /Credits and usage.*View on WorkBuddy/i }).waitFor()
  await panel.getByText(/Buddy Gas Station/i).waitFor()
  assert.equal(await panel.locator('[data-wb-balance] output').count(), 0, 'website-only wallet cannot supply a numeric balance')
  assert.equal(await panel.locator('[data-wb-auto]').isDisabled(), true, 'check-in must be disabled without an authorized connector')
  assert.equal(await panel.locator('[data-wb-auto]').isChecked(), false)
  await panel.getByRole('button', { name: 'Sign in', exact: true }).waitFor()
  await panel.getByText('Signed out', { exact: true }).waitFor()
  const text = await panel.innerText()
  assert.doesNotMatch(text, /checked in today|available today/i)
  assert.doesNotMatch(text, /API[\s_-]*key|access token|secret key/i, 'account login must be the only WorkBuddy credential flow')
  assert.equal(await panel.locator('input[type="password"],input[name*="key" i],input[placeholder*="key" i],input[aria-label*="key" i]').count(), 0)
  assert.equal(await page.locator('[data-wb-wallet-page], [data-wb-auto]').count(), 2)
  assert.equal(await panel.locator('[data-wb-wallet-page], [data-wb-auto]').count(), 2)
}

async function run(colorScheme, reducedMotion, desktop = false) {
  const context = await browser.newContext({ locale: 'en-US', colorScheme, reducedMotion,
    hasTouch: !desktop, viewport: desktop ? { width: 1280, height: 900 } : { width: 390, height: 730 }, serviceWorkers: 'block' })
  try {
    const errors = []
    const keyRequests = []
    await context.route('**/*', route => {
      const req = route.request()
      const url = new URL(req.url())
      const credentialHeader = ['authorization', 'x-api-key', 'api-key'].some(key => key in req.headers())
      if (credentialHeader || /(?:api[-_]?keys?|access[-_]?token|workbuddy.*credential)/i.test(url.pathname + url.search + (req.postData() || ''))) {
        keyRequests.push(`${req.method()} ${url.origin}`) // Keep query strings, headers and bodies out of test output.
      }
      return url.origin === origin && req.method() === 'GET' ? route.continue() : route.abort()
    })
    await context.addInitScript(() => localStorage.setItem('chat-demo:locale', 'en-US'))
    const page = await context.newPage()
    page.setDefaultTimeout(6000)
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(origin)
    assert.equal(await page.locator('meta[name="application-version"]').getAttribute('content'), '1.0.48')
    await page.locator(`body.${colorScheme}`).waitFor()
    assert.equal(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), reducedMotion === 'reduce')
    // A clean browser has no chat credentials, so the app opens its ordinary API settings on startup.
    const onboarding = page.getByRole('dialog', { name: 'Settings', exact: true })
    await onboarding.waitFor()
    await assertPrivate(page)
    await page.keyboard.press('Escape')
    await onboarding.waitFor({ state: 'detached' })
    const settingsButton = page.getByRole('button', { name: 'Settings', exact: true })
    if (!(await settingsButton.isVisible())) await page.getByRole('button', { name: 'Open sidebar', exact: true }).click()
    await assertPrivate(page)
    await settingsButton.click()
    let originalSection
    if (desktop) {
      const tabs = page.getByRole('tab')
      await tabs.nth(1).click() // Use a nondefault section to detect accidental returns to General.
      originalSection = await tabs.nth(1).innerText()
    } else {
      const root = page.locator('[data-settings-route="root"]')
      await root.getByRole('button', { name: /API Key/i }).click()
      const keys = page.locator('[data-settings-route="apiKey"]')
      await keys.waitFor()
      await assertPrivate(page)
      await keys.locator('header button').click()
      await keys.waitFor({ state: 'detached' })
    }
    const version = page.locator('button[data-wb-version]')
    await version.waitFor()
    assert.equal((await version.innerText()).trim(), 'Version 1.0.48')
    await version.scrollIntoViewIfNeeded()
    await assertPrivate(page)
    const before = await version.boundingBox()
    const hit = () => desktop ? version.click() : version.tap()
    for (let i = 0; i < 6; i++) {
      await hit()
      assert.equal(await page.locator('[data-wb-panel]').count(), 0, `opened on tap ${i + 1}`)
    }
    await hit()
    await inspectPanel(page)
    if (desktop) await page.keyboard.press('Escape')
    else await page.evaluate(() => history.back())
    await page.locator('[data-wb-panel]').waitFor({ state: 'detached' })
    if (desktop) assert.equal(await page.locator('[role="tab"][aria-selected="true"]').innerText(), originalSection)
    else await page.locator('[data-settings-route="root"][data-route-position="front"]:not([inert])').waitFor()
    const after = await version.boundingBox()
    assert.ok(before && after && Math.abs(after.y - before.y) <= 2, `version moved from ${before?.y} to ${after?.y}`)
    await assertPrivate(page)
    assert.deepEqual(errors, [])
    assert.deepEqual(keyRequests, [], 'Unexpected credential request during WorkBuddy navigation')
    console.log(`PASS ${desktop ? 'desktop' : 'mobile'} ${colorScheme}/${reducedMotion}: six taps hidden; seventh opens private wallet, unknown balance, check-in off; Back restores ${originalSection || 'Settings at version footer'}`)
  } finally { await context.close() }
}

try {
  for (const colorScheme of ['light', 'dark']) {
    for (const reducedMotion of ['no-preference', 'reduce']) await run(colorScheme, reducedMotion)
  }
  await run('dark', 'reduce', true)
} finally {
  await browser.close()
  await new Promise(done => server.close(done))
}
