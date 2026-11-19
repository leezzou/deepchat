// Pass the web assets extracted from the signed APK. Normal runs use the signed-out state. Local native-bridge fixtures cover account routing and balances.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, resolve, sep } from 'node:path'
import { chromium } from 'playwright'

assert.ok(process.argv[2], 'Supply the extracted assets/public directory')
const assets = resolve(process.argv[2])
const expectedVersion = process.argv[3] ?? JSON.parse(await readFile(new URL('../chat-demo/package.json', import.meta.url), 'utf8')).version
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
const walletCopy = /Credits and usage|View on WorkBuddy|Available credits|Daily automatic check-in|My credits/i

async function assertPrivate(page) {
  assert.equal(await page.locator('[data-wb-panel],[data-wb-balance],[data-wb-auto]').count(), 0)
  assert.doesNotMatch(await page.locator('body').innerText(), walletCopy)
}

async function inspectPanel(page, fixture) {
  const panel = page.locator('[data-wb-panel]')
  await panel.waitFor()
  const row = panel.locator('[data-wb-balance]')
  await row.waitFor()
  assert.equal(await panel.locator('[data-wb-wallet-page], a[href*="workbuddy.cn"]').count(), 0)
  assert.equal(await panel.locator('[data-wb-auto]').isDisabled(), true)
  assert.equal(await panel.locator('[data-wb-auto]').isChecked(), false)
  if (fixture) {
    await page.waitForFunction(() => document.querySelector('[data-wb-balance] output')?.textContent === '0')
    const quota = panel.locator('[data-wb-flash-quota]')
    await quota.waitFor()
    assert.match(await quota.innerText(), /has not reported the remaining allowance/)
    assert.doesNotMatch(await quota.innerText(), /Recorded on this device today|Daily quota reached/)
    // Seed a local observation for this test account only and simulate returning to the app.
    await page.evaluate(() => {
      const now = Date.now()
      const day = 86_400_000
      const offset = 8 * 3_600_000
      const dayEnd = (Math.floor((now + offset) / day) + 1) * day - offset
      localStorage.setItem('chat-demo:workbuddy-flash-meter:v1:00000000-0000-4000-8000-000000000001', JSON.stringify({
        dayEnd, tokens: 432, limit: { at: now, resetAt: now + 3_600_000, localTime: null, daily: true },
      }))
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await quota.getByText(/Daily quota reached/).waitFor()
    assert.match(await quota.innerText(), /WorkBuddy reset time:/)
    assert.match(await quota.innerText(), /Recorded on this device today:\s+432 tokens \(UTC\+8\)/)
    assert.equal(await row.locator('output').innerText(), '0', 'Daily token usage must stay separate from credits')
    console.log('PASS local Flash fixture: unknown allowance, 432 device-recorded tokens, daily limit and reset time')
    const refresh = row.getByRole('button', { name: 'Refresh credits' })
    await page.evaluate(() => { window.fixtureState.balance = 127.5 })
    await refresh.click()
    await page.waitForFunction(() => document.querySelector('[data-wb-balance] output')?.textContent === '127.5')
    await page.evaluate(() => { window.fixtureState.balance = null })
    await refresh.click()
    await page.waitForFunction(() => document.querySelector('[data-wb-balance] output')?.textContent === '—')
    assert.match(await panel.innerText(), /could not|unavailable|couldn.t|try again/i)
  } else {
    await row.getByText('Sign in to view', { exact: true }).waitFor()
    assert.equal(await row.locator('output').innerText(), '—')
    assert.equal(await row.getByRole('button', { name: 'Refresh credits' }).count(), 0)
  }
  assert.equal(await panel.locator('#wb-channel-heading, [data-wb-account-page]').count(), 0, 'Private wallet must contain wallet controls only')
  const text = await panel.innerText()
  assert.doesNotMatch(text, /checked in today|available today/i)
  assert.doesNotMatch(text, /API[\s_-]*key|access token|secret key/i, 'account login must be the only WorkBuddy credential flow')
  assert.equal(await panel.locator('input[type="password"],input[name*="key" i],input[placeholder*="key" i],input[aria-label*="key" i]').count(), 0)
  assert.equal(await page.locator('[data-wb-balance], [data-wb-auto]').count(), 2)
  assert.equal(await panel.locator('[data-wb-balance], [data-wb-auto]').count(), 2)
}

// Simulate only account metadata and wallet status/refresh in a separate localhost context.
function installWalletFixture(mode) {
  const signedIn = mode === 'signed-in'
  let pending = false
  window.fixtureState = { balance: signedIn ? 0 : null }
  window.DshNative = { postMessage(raw) {
    if (JSON.parse(raw).op !== 'status') throw Error('Unexpected DeepSeek fixture operation')
    queueMicrotask(() => this.onmessage({ data: JSON.stringify({ type: 'account', signedIn: false }) }))
  } }
  window.CapacitorPlatforms = { currentPlatform: { getPlatform: () => 'android', isNativePlatform: () => false } }
  window.Capacitor = {
    PluginHeaders: [{ name: 'WorkBuddyWallet', methods: ['status', 'refresh'].map(name => ({ name, rtype: 'promise' })) }],
    async nativePromise(plugin, method) {
      if (plugin !== 'WorkBuddyWallet' || !['status', 'refresh'].includes(method)) throw Error('Unexpected wallet fixture operation')
      const { balance } = window.fixtureState
      const metadata = signedIn ? { model: 'deepseek-v4.1-flash', revision: '00000000-0000-4000-8000-000000000001' } : {}
      return { ...metadata, source: signedIn ? 'account' : 'signed-out', state: !signedIn ? 'login-required' : balance === null ? 'unavailable' : 'account-page', balance, checkIn: 'unknown',
        canAutoCheckIn: false, autoCheckIn: false, observedAt: balance === null ? null : Date.now() }
    },
  }
  window.WorkBuddyChat = { postMessage(raw) {
    const { id, op } = JSON.parse(raw)
    if (op === 'begin') pending = true
    else if (op === 'cancelLogin') pending = false
    else if (op !== 'status' && op !== 'poll') throw Error('Unexpected account fixture operation')
    const metadata = signedIn ? { model: 'deepseek-v4.1-flash',
      revision: '00000000-0000-4000-8000-000000000001', name: 'Local fixture' } : {}
    queueMicrotask(() => this.onmessage({ data: JSON.stringify({ id, type: 'status', pending, ...metadata }) }))
  } }
}

async function publicAccount(page, mode, desktop) {
  const entry = page.locator('[data-wb-account-entry]')
  if (!mode) {
    assert.equal(await entry.count(), 0, 'Web browsers without the Android bridge must hide account entry')
    return
  }
  await entry.waitFor()
  await entry.scrollIntoViewIfNeeded()
  const order = await entry.evaluate((button, desktop) => {
    const dshButton = document.querySelector('[data-dsh-account]')
    const dsh = desktop ? dshButton?.parentElement : dshButton
    const row = desktop ? button.parentElement : button
    if (!dsh || !row) return false
    return dsh.nextElementSibling === row && dsh.getBoundingClientRect().bottom <= row.getBoundingClientRect().top + 2
  }, desktop)
  assert.ok(order, 'WorkBuddy entry must appear immediately below DeepSeek account')
  const size = await entry.boundingBox()
  assert.ok(size.width > 40 && size.height >= (desktop ? 28 : 40), 'Account action must be readable and tappable')
  const readable = await entry.evaluate(button => {
    const bounds = button.getBoundingClientRect()
    const text = document.createTreeWalker(button, NodeFilter.SHOW_TEXT)
    let labels = 0
    while (text.nextNode()) {
      if (!text.currentNode.textContent.trim()) continue
      labels++
      const range = document.createRange()
      range.selectNodeContents(text.currentNode)
      const rect = range.getBoundingClientRect()
      const fontSize = parseFloat(getComputedStyle(text.currentNode.parentElement).fontSize)
      if (fontSize < 12 || rect.width < 1 || rect.height < 1 || rect.left < bounds.left - 1 ||
          rect.right > bounds.right + 1 || rect.top < bounds.top - 1 || rect.bottom > bounds.bottom + 1) return false
    }
    return labels > 0
  })
  assert.ok(readable, 'Account entry text must fit the button at a legible size')
  if (mode === 'signed-out') assert.match(await entry.innerText(), /Sign in to WorkBuddy/)
  else {
    await entry.getByText('Manage account', { exact: true }).waitFor()
    assert.match(await entry.innerText(), /WorkBuddy account/)
  }
  await entry.click()
  const account = page.locator('[data-wb-account-page]')
  await account.waitFor()
  if (desktop) await page.getByRole('dialog', { name: 'WorkBuddy account', exact: true }).waitFor()
  else await page.locator('[data-settings-route="workbuddyAccount"][data-route-position="front"]').waitFor()
  await assertPrivate(page)
  if (mode === 'signed-in') {
    await account.getByText('Local fixture', { exact: true }).waitFor()
    await account.getByRole('button', { name: 'Sign out', exact: true }).waitFor()
  } else {
    await account.getByText('Signed out', { exact: true }).waitFor()
    await account.getByRole('button', { name: 'Desktop sign-in', exact: true }).click()
    await account.getByText('Waiting for Tencent approval', { exact: true }).waitFor()
    await account.getByRole('button', { name: 'Cancel', exact: true }).click()
    await account.getByText('Signed out', { exact: true }).waitFor()
  }
  if (desktop) await page.keyboard.press('Escape')
  else await page.evaluate(() => history.back())
  await account.waitFor({ state: 'detached' })
  const after = await entry.boundingBox()
  assert.ok(after && Math.abs(size.y - after.y) <= 2, 'Returning from the public account must restore Settings')
  await assertPrivate(page)
}

async function run(colorScheme, reducedMotion, desktop = false, mode = null) {
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
    if (mode) await context.addInitScript(installWalletFixture, mode)
    const page = await context.newPage()
    page.setDefaultTimeout(6000)
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(origin)
    assert.equal(await page.locator('meta[name="application-version"]').getAttribute('content'), expectedVersion)
    await page.locator(`body.${colorScheme}`).waitFor()
    assert.equal(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), reducedMotion === 'reduce')
    // A clean browser has no chat credentials, so the app opens its ordinary API settings on startup.
    const onboarding = page.getByRole('dialog', { name: 'Settings', exact: true })
    if (!mode) {
      await onboarding.waitFor()
      await assertPrivate(page)
      await page.keyboard.press('Escape')
      await onboarding.waitFor({ state: 'detached' })
    }
    const settingsButton = page.getByRole('button', { name: 'Settings', exact: true })
    const sidebarButton = page.getByRole('button', { name: 'Open sidebar', exact: true })
    await settingsButton.or(sidebarButton).first().waitFor()
    if (!(await settingsButton.isVisible())) await sidebarButton.click()
    await assertPrivate(page)
    await settingsButton.click()
    if (desktop) await page.getByRole('tab').first().click()
    await publicAccount(page, mode, desktop)
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
    assert.equal((await version.innerText()).trim(), `Version ${expectedVersion}`)
    await version.scrollIntoViewIfNeeded()
    await assertPrivate(page)
    const before = await version.boundingBox()
    const footer = await version.locator('..').boundingBox()
    assert.ok(Math.abs((before.x + before.width / 2) - (footer.x + footer.width / 2)) <= 1, 'Version must be centered in the footer')
    const hit = () => desktop ? version.click() : version.tap()
    for (let i = 0; i < 6; i++) {
      await hit()
      assert.equal(await page.locator('[data-wb-panel]').count(), 0, `opened on tap ${i + 1}`)
    }
    await hit()
    await inspectPanel(page, mode === 'signed-in')
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
    if (mode) console.log(`PASS ${desktop ? 'desktop' : 'mobile'} public WorkBuddy account below DeepSeek (${mode}), private credits inaccessible, Back restores Settings`)
    if (mode === 'signed-in') console.log('PASS local account fixture: in-app zero → 127.5 → unavailable, refresh stays in WorkBuddy')
    console.log(`PASS ${desktop ? 'desktop' : 'mobile'} ${colorScheme}/${reducedMotion}: six taps hidden; seventh opens private wallet, unknown balance, check-in off; Back restores ${originalSection || 'Settings at version footer'}`)
  } finally { await context.close() }
}

try {
  await run('dark', 'reduce', true, 'signed-out')
  for (const colorScheme of ['light', 'dark']) {
    for (const reducedMotion of ['no-preference', 'reduce']) await run(colorScheme, reducedMotion, false, reducedMotion === 'reduce' ? 'signed-out' : null)
  }
  await run('light', 'reduce', false, 'signed-in')
} finally {
  await browser.close()
  await new Promise(done => server.close(done))
}
