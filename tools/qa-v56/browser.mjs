import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

const origin = 'https://v56-qa.localhost'
const mime = {
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.html': 'text/html',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.webp': 'image/webp',
}
export const button = (scope, name) =>
  scope.getByRole('button', { name, exact: typeof name === 'string' })
export const front = (page, route) =>
  page.locator(`[data-settings-route="${route}"][data-route-position="front"]:not([inert])`)
export async function openSettings(page) {
  await page.locator('textarea:visible').first().waitFor()
  const entry = button(page, '设置')
  if (!(await entry.isVisible())) await button(page, /^打开边栏/).click()
  await entry.click()
  await page.locator('[data-theme-picker]:visible').waitFor()
}
export function seedSession() {
  if (sessionStorage.getItem('v56-init')) return
  sessionStorage.setItem('v56-init', '1')
  localStorage.setItem('chat-demo:locale', 'zh-CN')
  localStorage.setItem('chat-demo:api-key', 'qa-offline-fixture-only')
}
export async function screenshot(page, out, name) {
  await page.evaluate(async () => {
    await document.fonts.ready
    await Promise.allSettled([...document.images].filter((image) => image.getClientRects().length).map((image) => image.decode()))
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    await Promise.allSettled(
      document
        .getAnimations()
        .filter((a) => Number.isFinite(a.effect?.getComputedTiming().endTime))
        .map((a) => a.finished)
    )
  })
  await page.screenshot({
    path: path.join(out, `${name}.png`),
    animations: 'disabled',
    caret: 'hide',
  })
}
export async function runner(args) {
  assert.equal(args.length, 2, 'Pass a built assets directory and a fresh evidence directory')
  const [assets, out] = args.map((s) => path.resolve(s))
  const html = await readFile(path.join(assets, 'index.html'), 'utf8')
  const entry = html.match(/<script[^>]*src="([^"]*main\.[^"]+\.js)"/)?.[1]
  const version =
    html.match(/<meta content="([^"]+)" name="application-version"/)?.[1] ??
    html.match(/<meta name="application-version" content="([^"]+)"/)?.[1]
  assert.ok(version && entry, 'Versioned bundle required')
  await mkdir(path.dirname(out), { recursive: true })
  await mkdir(out)
  const digest = createHash('sha256')
    .update(await readFile(path.join(assets, entry)))
    .digest('hex')
  const browser = await chromium.launch({
    executablePath:
      process.env.CHROME_EXECUTABLE_PATH ||
      (process.platform === 'darwin'
        ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
        : undefined),
  })
  const report = {
    version,
    entry,
    sha256: digest,
    browser: browser.version(),
    assets,
    started: new Date().toISOString(),
    cases: [],
  }
  async function visit(width, theme, label, fixture, action) {
    const viewport = { width, height: width < 768 ? 800 : 900 }
    const record = { label, width, theme, checks: [], errors: [], shots: [] }
    report.cases.push(record)
    const ctx = await browser.newContext({
      viewport,
      deviceScaleFactor: 1,
      colorScheme: theme,
      reducedMotion: 'reduce',
      locale: 'zh-CN',
      isMobile: width < 768,
      hasTouch: width < 768,
      serviceWorkers: 'block',
    })
    try {
      await ctx.addInitScript(seedSession)
      if (fixture) await ctx.addInitScript(fixture)
      await ctx.route('**/*', async (route) => {
        const url = new URL(route.request().url())
        if (route.request().method() !== 'GET') return route.abort()
        const photo = /^\/__v56_qa__\/([0-9a-f]{6})\.svg$/.exec(url.pathname)
        if (photo && url.origin === 'https://avatars.qa.example')
          return route.fulfill({
            contentType: 'image/svg+xml',
            body: `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect fill="#${photo[1]}" width="32" height="32"/><circle cx="16" cy="13" r="6" fill="white"/><path fill="white" d="M5 32a11 11 0 0122 0z"/></svg>`,
          })
        if (url.origin !== origin) return route.abort()
        const file = path.resolve(
          assets,
          '.' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname))
        )
        assert.ok(file.startsWith(assets + path.sep))
        try {
          await route.fulfill({
            body: await readFile(file),
            contentType: mime[path.extname(file)] || 'application/octet-stream',
          })
        } catch {
          await route.fulfill({ status: 404, body: '' })
        }
      })
      const page = await ctx.newPage()
      page.setDefaultTimeout(10000)
      page.setDefaultNavigationTimeout(30000)
      page.on('pageerror', (e) => record.errors.push(e.message))
      await page.goto(origin)
      await page.locator(`body.${theme}`).waitFor({ state: 'attached' })
      const shot = async (name) => {
        const file = `${width}-${theme}-${label}-${name}`
        await screenshot(page, out, file)
        record.shots.push(file + '.png')
      }
      try {
        await action({ page, shot, record, phone: width < 768, version })
        assert.deepEqual(record.errors, [])
      } catch (e) {
        record.visible = (
          await page
            .locator('body')
            .innerText({ timeout: 1500 })
            .catch(() => '')
        ).slice(-3000)
        await shot('failure').catch(() => {})
        throw e
      }
    } catch (error) {
      record.failure = String(error.stack || error)
    } finally {
      await ctx.close()
    }
    console.log(
      `${record.failure ? 'FAIL' : 'PASS'} ${width} ${theme} ${label} ${record.checks.length} ${record.failure?.split('\n')[0] || ''}`
    )
  }
  const finish = async () => {
    await browser.close()
    await writeFile(path.join(out, 'results.json'), JSON.stringify(report, null, 2) + '\n')
    if (!report.cases.length || report.cases.some((c) => c.failure)) process.exitCode = 1
  }
  return { visit, finish, report, out }
}
