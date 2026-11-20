// Pass the web assets extracted from the signed APK. Local fixtures cover account and update states on both viewports.
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
const oldQuotaCopy = /Flash daily quota|Recorded on this device today|Daily quota reached|remaining allowance|reset time|432 tokens/i
const nextVersion = expectedVersion.replace(/\d+$/, n => String(Number(n) + 1))
const updateFixture = { version: nextVersion, notes: 'Local regression release notes',
  apkUrl: `https://github.com/leezzou/deepchat/releases/download/v${nextVersion}/app.apk`,
  pageUrl: `https://github.com/leezzou/deepchat/releases/tag/v${nextVersion}` }

async function assertPrivate(page) {
  assert.equal(await page.locator('[data-wb-panel],[data-wb-wallet],[data-wb-balance],[data-wb-auto]').count(), 0)
  assert.doesNotMatch(await page.locator('body').innerText(), walletCopy)
}

async function inspectCredits(page, account, signedIn) {
  const panel = account.locator('[data-wb-wallet]')
  const row = panel.locator('[data-wb-balance]')
  await row.waitFor()
  assert.equal(await panel.locator('[data-wb-wallet-page], a[href*="workbuddy.cn"]').count(), 0)
  assert.equal(await panel.locator('[data-wb-auto]').isDisabled(), true)
  assert.equal(await panel.locator('[data-wb-auto]').isChecked(), false)
  const note = account.locator('[data-wb-daily-limit-note]')
  assert.equal((await note.innerText()).trim(), 'DeepSeek has a daily usage limit.')
  assert.doesNotMatch(await account.innerText(), oldQuotaCopy)
  assert.equal(await account.locator('[data-wb-flash-quota]').count(), 0)
  if (signedIn) {
    await page.waitForFunction(() => document.querySelector('[data-wb-balance] output')?.textContent === '0')
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
  const text = await account.innerText()
  assert.doesNotMatch(text, /checked in today|available today/i)
  assert.doesNotMatch(text, /API[\s_-]*key|access token|secret key/i, 'account login must be the only WorkBuddy credential flow')
  assert.equal(await panel.locator('input[type="password"],input[name*="key" i],input[placeholder*="key" i],input[aria-label*="key" i]').count(), 0)
  assert.equal(await page.locator('[data-wb-balance], [data-wb-auto]').count(), 2)
  assert.equal(await panel.locator('[data-wb-balance], [data-wb-auto]').count(), 2)
}

// Local metadata, wallet observations and the native download bridge. No real auth or install.
function installWalletFixture({ mode, version }) {
  const signedIn = mode === 'signed-in'
  let pending = false
  window.fixtureState = { balance: signedIn ? 0 : null, version, downloads: [], ready: false, installs: 0 }
  window.AndroidUpdater = {
    getInstalledVersion: () => window.fixtureState.version,
    isDownloadedUpdateReady: () => window.fixtureState.ready,
    getDownloadedVersion: () => window.fixtureState.ready ? window.fixtureState.downloadedVersion : '',
    installApkForVersion: (url, fallback, target) => {
      window.fixtureState.downloads.push(url)
      window.fixtureState.downloadedVersion = target
    },
    installApkWithFallback: () => { throw Error('Expected a versioned Android download') },
    installDownloadedApk: () => { window.fixtureState.installs++ },
  }
  // Existing users can have detailed legacy quota observations stored on the device.
  const now = Date.now()
  const day = 86_400_000
  const offset = 8 * 3_600_000
  const dayEnd = (Math.floor((now + offset) / day) + 1) * day - offset
  localStorage.setItem('chat-demo:workbuddy-flash-meter:v1:00000000-0000-4000-8000-000000000001', JSON.stringify({
    dayEnd, tokens: 432, limit: { at: now, resetAt: now + 3_600_000, localTime: null, daily: true },
  }))
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
    assert.match(await (desktop ? entry.locator('..') : entry).innerText(), /WorkBuddy account/i)
  }
  await entry.click()
  const account = page.locator('[data-wb-account-page]')
  await account.waitFor()
  if (desktop) await page.getByRole('dialog', { name: 'WorkBuddy account', exact: true }).waitFor()
  else await page.locator('[data-settings-route="workbuddyAccount"][data-route-position="front"]').waitFor()
  await inspectCredits(page, account, mode === 'signed-in')
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

// Visibility alone is insufficient: a native <dialog> in the top layer can cover a portalled panel.
async function assertForeground(locator) {
  await locator.scrollIntoViewIfNeeded()
  await locator.page().waitForFunction(el => {
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0 && el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
  }, await locator.elementHandle())
}

async function checkUpdates(page, desktop, available) {
  const row = page.locator('[data-update-entry]')
  const state = name => page.locator(`[data-update-panel][data-update-state="${name}"]`)
  const action = page.locator('[data-update-action]')
  const backToSettings = async () => {
    if (desktop) await page.keyboard.press('Escape')
    else await page.evaluate(() => history.back())
    await page.locator('[data-update-panel]').waitFor({ state: 'detached' })
    await assertForeground(row)
  }
  await assertForeground(row)
  const dot = row.locator('[data-update-dot]')
  if (!available) {
    assert.equal(await dot.count(), 0)
    await row.click()
    await assertForeground(state('check-error'))
    assert.match(await state('check-error').innerText(), /could not|failed|unable/i)
    await backToSettings()
    return
  }
  await dot.waitFor()
  assert.match(await row.innerText(), /available/i)
  assert.ok((await row.innerText()).includes(`v${nextVersion}`))
  const isRed = await dot.evaluate(el => {
    const [r, g, b] = getComputedStyle(el).backgroundColor.match(/[\d.]+/g).map(Number)
    return r > g && r > b
  })
  assert.ok(isRed, 'The new-version dot must render red')
  await row.click()
  await assertForeground(state('available'))
  assert.ok((await state('available').innerText()).includes(updateFixture.notes))
  assert.ok((await state('available').innerText()).includes(nextVersion))
  await backToSettings()
  await row.click()
  await action.click()
  await assertForeground(state('downloading'))
  assert.deepEqual(await page.evaluate(() => window.fixtureState.downloads), [updateFixture.apkUrl])
  await page.evaluate(() => dispatchEvent(new CustomEvent('deepchat:update-progress', { detail: { received: 3, total: 8 } })))
  await page.waitForFunction(() => {
    const progress = document.querySelector('[data-update-panel] progress')
    return progress && Math.abs(progress.value / progress.max - 3 / 8) < 0.01
  })
  await backToSettings()
  await row.click()
  await assertForeground(state('downloading'))
  await page.evaluate(() => dispatchEvent(new Event('deepchat:update-failed')))
  await assertForeground(state('failed'))
  assert.match(await state('failed').innerText(), /could not|failed|retry/i)
  await backToSettings()
  await row.click()
  await action.click()
  await state('downloading').waitFor()
  await page.evaluate(() => { window.fixtureState.ready = true; dispatchEvent(new Event('deepchat:update-ready')) })
  await assertForeground(state('ready'))
  await action.click()
  await state('installing').waitFor()
  await page.evaluate(() => dispatchEvent(new Event('focus'))) // Installer cancelled.
  await assertForeground(state('ready'))
  await action.click()
  await state('installing').waitFor()
  await page.evaluate(version => {
    window.fixtureState.version = version
    window.fixtureState.ready = false
    document.dispatchEvent(new Event('visibilitychange'))
  }, nextVersion)
  await assertForeground(state('latest'))
  assert.equal(await page.evaluate(() => window.fixtureState.installs), 2)
  await backToSettings()
  assert.equal(await dot.count(), 0, 'Installed version must clear the update badge')
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
      if (mode === 'signed-in' && req.method() === 'GET' && url.origin === 'https://gitee.com' &&
          url.pathname === '/api/v5/repos/yllzz/deepchat/contents/update.json') {
        return route.fulfill({ json: { encoding: 'base64', content: Buffer.from(JSON.stringify(updateFixture)).toString('base64') } })
      }
      return url.origin === origin && req.method() === 'GET' ? route.continue() : route.abort()
    })
    await context.addInitScript(() => localStorage.setItem('chat-demo:locale', 'en-US'))
    if (mode) await context.addInitScript(installWalletFixture, { mode, version: expectedVersion })
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
    const sidebarButton = page.getByRole('button', { name: /^Open sidebar\b/ })
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
    const version = page.locator('[data-app-version]')
    await version.waitFor()
    assert.ok(await version.evaluate(el => !el.closest('button, a, [role="button"], [tabindex]:not([tabindex="-1"])')), 'Version must be static text')
    assert.equal((await version.innerText()).trim(), `Version ${expectedVersion}`)
    await version.scrollIntoViewIfNeeded()
    await assertPrivate(page)
    const before = await version.boundingBox()
    const footer = await version.locator('..').boundingBox()
    const textCenter = await version.evaluate(el => {
      const range = document.createRange()
      range.selectNodeContents(el)
      const text = range.getBoundingClientRect()
      return { x: text.left + text.width / 2, y: text.top + text.height / 2 }
    })
    assert.ok(Math.abs(textCenter.x - (footer.x + footer.width / 2)) <= 1, 'Version text must be centered in the footer')
    const navSnapshot = () => page.evaluate(() => JSON.stringify([
      location.href, history.state, document.querySelectorAll('[role="dialog"], dialog[open]').length,
      [...document.querySelectorAll('[data-settings-route][data-route-position="front"]')].map(el => el.dataset.settingsRoute),
    ]))
    const originalNav = await navSnapshot()
    // Tap real screen coordinates: the text may intentionally have pointer-events:none.
    const { x, y } = textCenter
    for (let i = 0; i < 7; i++) {
      if (desktop) await page.mouse.click(x, y)
      else await page.touchscreen.tap(x, y)
    }
    await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
    assert.equal(await navSnapshot(), originalNav, 'Seven taps changed the Settings route or dialog stack')
    if (desktop) assert.equal(await page.locator('[role="tab"][aria-selected="true"]').innerText(), originalSection)
    else await page.locator('[data-settings-route="root"][data-route-position="front"]:not([inert])').waitFor()
    const after = await version.boundingBox()
    assert.ok(before && after && Math.abs(after.y - before.y) <= 2, `version moved from ${before?.y} to ${after?.y}`)
    await assertPrivate(page)
    if (desktop) await page.getByRole('tab').first().click()
    if (mode) await checkUpdates(page, desktop, mode === 'signed-in')
    assert.deepEqual(errors, [])
    assert.deepEqual(keyRequests, [], 'Unexpected credential request during WorkBuddy navigation')
    const view = desktop ? 'desktop' : 'mobile'
    console.log(`PASS ${view} ${colorScheme}/${reducedMotion}: seven taps on centered version leave Settings unchanged`)
    if (mode) console.log(`PASS ${view} ${mode} account: inline credits, single daily-limit reminder, Back restores Settings`)
    if (mode === 'signed-in') console.log(`PASS ${view} local fixtures: balance 0 → 127.5 → unavailable; update badge → foreground notes → progress → failed/retry → ready/install → latest, Back to Settings`)
    if (mode === 'signed-out') console.log(`PASS ${view} failed manifest: visible error and Back to Settings`)
  } finally { await context.close() }
}

try {
  await run('dark', 'reduce', true, 'signed-out')
  await run('light', 'no-preference', true, 'signed-in')
  for (const colorScheme of ['light', 'dark']) {
    for (const reducedMotion of ['no-preference', 'reduce']) await run(colorScheme, reducedMotion, false, reducedMotion === 'reduce' ? 'signed-out' : null)
  }
  await run('light', 'reduce', false, 'signed-in')
} finally {
  await browser.close()
  await new Promise(done => server.close(done))
}
