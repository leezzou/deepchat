// node tools/qa-v55/settings.mjs <production dist directory> <new evidence directory>
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'
import { installFixture } from '../qa-v54/fixture.mjs'
import { androidFixture, appearance, desktopRoutes, phoneRoutes } from './settings-routes.mjs'

assert.equal(process.argv.length, 4, 'Pass dist and a fresh evidence directory')
const assets = path.resolve(process.argv[2]),
  out = path.resolve(process.argv[3])
const html = await readFile(path.join(assets, 'index.html'), 'utf8')
const entry = html.match(/<script[^>]*src="([^"]*main\.[^"]+\.js)"/)?.[1]
assert.ok(entry, 'Production bundle required')
const digest = createHash('sha256')
  .update(await readFile(path.join(assets, entry)))
  .digest('hex')
await mkdir(path.dirname(out), { recursive: true })
await mkdir(out)
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_EXECUTABLE_PATH ||
    (process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : undefined),
})
const report = { assets, bundleSha256: digest, browser: browser.version(), cases: [] }
const origin = 'https://settings-test.localhost'
const contentTypes = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.webp': 'image/webp',
}
async function inspect(width, osTheme, motion) {
  const phone = width < 768
  const variant = `${width}-${osTheme}-${motion}`
  if (process.env.QA_CASE && !process.env.QA_CASE.split(',').includes(variant)) return
  const result = { variant, checks: [], shots: [], pageErrors: [] }
  report.cases.push(result)
  const context = await browser.newContext({
    viewport: { width, height: phone ? 800 : 900 },
    deviceScaleFactor: 1,
    isMobile: phone,
    hasTouch: phone,
    serviceWorkers: 'block',
    locale: 'zh-CN',
    colorScheme: osTheme,
    reducedMotion: motion,
  })
  // Native handling is exercised via the App plugin callback on the 390px case.
  const native = width === 390
  await context.addInitScript(installFixture)
  await context.addInitScript(androidFixture, native)
  async function serve(route) {
    const url = new URL(route.request().url())
    if (url.origin !== origin || route.request().method() !== 'GET')
      return route.abort('blockedbyclient')
    const file = path.resolve(
      assets,
      '.' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname))
    )
    assert.ok(file.startsWith(assets + path.sep))
    try {
      await route.fulfill({
        body: await readFile(file),
        contentType: contentTypes[path.extname(file)] || 'application/octet-stream',
      })
    } catch {
      await route.fulfill({ status: 404, body: '' })
    }
  }
  await context.route('**/*', serve)
  const page = await context.newPage()
  page.setDefaultTimeout(5000)
  page.on('pageerror', (e) => result.pageErrors.push(e.message))
  const note = (text) => result.checks.push(text)
  async function shot(name) {
    const file = `${variant}-${name}.png`
    await page.evaluate(async () => {
      await document.fonts.ready
      await new Promise((resolve) => requestAnimationFrame(resolve))
      await Promise.allSettled(
        document
          .getAnimations()
          .filter((a) => Number.isFinite(a.effect?.getComputedTiming().endTime))
          .map((a) => a.finished)
      )
    })
    await page.screenshot({ path: path.join(out, file) })
    result.shots.push(file)
  }
  try {
    await page.goto(origin)
    await appearance({ page, osTheme, phone, note, shot })
    if (phone) await phoneRoutes({ page, native, motion, note, shot })
    else await desktopRoutes({ page, note, shot })
    if (!native && osTheme === 'dark' && motion === 'reduce') {
      const guest = await browser.newContext({
        viewport: page.viewportSize(),
        locale: 'zh-CN',
        reducedMotion: motion,
        serviceWorkers: 'block',
      })
      try {
        await guest.route('**/*', serve)
        const plain = await guest.newPage()
        plain.setDefaultTimeout(5000)
        await plain.goto(origin)
        const target = phone
          ? '[data-settings-route=apiKey]'
          : '[data-settings-tab=apiKey][aria-selected=true]'
        await plain.locator(target).waitFor()
        if (phone) assert.equal(await plain.locator('[data-settings-route]').count(), 1)
        await plain.keyboard.press('Escape')
        await plain.locator(target).waitFor({ state: 'detached' })
        await plain.locator('textarea:visible').first().waitFor()
        note(
          'A fresh browser without an API key opens its configuration directly and returns to chat in one dismissal'
        )
      } finally {
        await guest.close()
      }
    }
    assert.deepEqual(result.pageErrors, [])
    result.passed = true
  } catch (e) {
    result.passed = false
    result.failure = String(e.stack || e)
    result.text = (
      await page
        .locator('body')
        .innerText()
        .catch(() => '')
    ).slice(-1800)
    await shot('failure').catch(() => {})
  } finally {
    await context.close()
    console.log(
      `${result.passed ? 'PASS' : 'FAIL'} ${variant} ${result.failure?.split('\n')[0] || ''}`
    )
  }
}
try {
  for (const width of [320, 390, 1280]) {
    await Promise.all(
      ['light', 'dark'].flatMap((theme) =>
        ['no-preference', 'reduce'].map((motion) => inspect(width, theme, motion))
      )
    )
  }
  assert.ok(report.cases.length)
} finally {
  await browser.close()
  await writeFile(path.join(out, 'results.json'), JSON.stringify(report, null, 2) + '\n')
}
if (report.cases.some((c) => !c.passed)) process.exitCode = 1
