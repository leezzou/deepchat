import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { chromium } from 'playwright'
import { installFixture } from './fixture.mjs'
import { scenarios } from './scenarios.mjs'

assert.ok(
  process.argv[2] && process.argv[3],
  'node tools/qa-v54/browser.mjs <isolated assets> <new evidence directory>'
)
const assets = path.resolve(process.argv[2]),
  out = path.resolve(process.argv[3])
await mkdir(path.dirname(out), { recursive: true })
await mkdir(out) // Preserve earlier evidence.
const html = await readFile(path.join(assets, 'index.html'), 'utf8')
const bundle = html.match(/<script[^>]*src="([^"]+main\.[^"]+\.js)"/)?.[1]
assert.ok(bundle, 'Production entry script required')
const digest = createHash('sha256')
  .update(await readFile(path.join(assets, bundle)))
  .digest('hex')
const sourceInput = await readFile(path.join(assets, '..', 'input.json'), 'utf8').then(JSON.parse).catch(() => null)
const report = {
  stage: process.env.QA_STAGE || 'source-preflight',
  mainSha256: digest,
  ...(sourceInput?.assets === assets && { sourceSha256: sourceInput.sourceHash }),
  account: 'synthetic accounts, local transports and fresh browser storage',
  profilePorts: process.env.QA_ANDROID_ACCOUNT_BRIDGE === '1',
  started: new Date().toISOString(),
  cases: [],
}
const types = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
}
const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
    const filename = path.resolve(assets, '.' + (pathname === '/' ? '/index.html' : pathname))
    assert.ok(req.method === 'GET' && filename.startsWith(assets + path.sep))
    const data = await readFile(filename)
    res
      .writeHead(200, {
        'Content-Type': types[path.extname(filename)] || 'application/octet-stream',
      })
      .end(data)
  } catch {
    res.writeHead(404).end()
  }
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const origin = `http://127.0.0.1:${server.address().port}`
let browser
try {
  browser = await chromium.launch({
    executablePath:
      process.env.CHROME_EXECUTABLE_PATH ||
      (process.platform === 'darwin'
        ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
        : undefined),
  })
  report.chromium = browser.version()
  const cases = Object.keys(scenarios).filter(
    (name) => !process.env.QA_CASE || process.env.QA_CASE.split(',').includes(name)
  )
  assert.ok(cases.length, 'Select an existing QA_CASE')
  for (const view of ['phone', 'desktop'])
    for (const theme of ['light', 'dark'])
      for (const motion of ['no-preference', 'reduce']) {
        const variant = `${view}-${theme}-${motion}`
        if (process.env.QA_VARIANT && !process.env.QA_VARIANT.split(',').includes(variant)) continue
        const phone = view === 'phone'
        for (const name of cases) {
          if (name === 'discovery' && !phone) continue // Provider profile editor is a mobile-only route.
          const label = `${variant}-${name}`
          const result = { label, checks: [], shots: [], errors: [], blockedHosts: [] }
          report.cases.push(result)
          const context = await browser.newContext({
            viewport: phone ? { width: 390, height: 844 } : { width: 1280, height: 900 },
            hasTouch: phone,
            isMobile: phone,
            deviceScaleFactor: 1,
            locale: 'zh-CN',
            colorScheme: theme,
            reducedMotion: motion,
            serviceWorkers: 'block',
          })
          const page = await context.newPage()
          page.setDefaultTimeout(5500)
          page.on('pageerror', (e) => result.errors.push(e.message))
          try {
            await context.route('**/*', (route) => {
              const url = new URL(route.request().url())
              if (url.origin === origin && route.request().method() === 'GET')
                return route.continue()
              if (!result.blockedHosts.includes(url.hostname))
                result.blockedHosts.push(url.hostname)
              return route.abort()
            })
            if (name === 'roster' && process.env.QA_ANDROID_ACCOUNT_BRIDGE === '1') {
              await context.addInitScript(() => {
                window.DshNative = {
                  postMessage(raw) {
                    const call = JSON.parse(raw)
                    if (call.op !== 'status') throw Error('Unexpected DeepSeek account request')
                    queueMicrotask(() =>
                      window.DshNative.onmessage({
                        data: JSON.stringify({ type: 'account', signedIn: false }),
                      })
                    )
                  },
                }
              })
              result.accountBridge = 'signed-out Android account status simulation'
            }
            await context.addInitScript(installFixture)
            await page.goto(origin)
            await page.locator(`body.${theme}`).waitFor()
            const version = await page
              .locator('meta[name="application-version"]')
              .getAttribute('content')
            assert.ok(!report.version || report.version === version)
            report.version = version
            if (report.stage === 'published-apk') assert.equal(version, '1.0.54')
            assert.equal(
              await page.evaluate(() => matchMedia('(prefers-reduced-motion:reduce)').matches),
              motion === 'reduce'
            )
            const shot = async (tag, mandatory = false) => {
              if (
                !mandatory &&
                !(
                  (phone && theme === 'light' && motion === 'no-preference') ||
                  (!phone && theme === 'dark' && motion === 'reduce')
                )
              )
                return
              const file = `${label}-${tag}.png`
              await page.evaluate(async () => {
                await new Promise(resolve => requestAnimationFrame(resolve))
                const transitions = document.getAnimations().filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime))
                await Promise.allSettled(transitions.map(animation => animation.finished))
              })
              await page.screenshot({ path: path.join(out, file) })
              result.shots.push(file)
            }
            const check = (value, message) => {
              assert.ok(value, message)
              result.checks.push(message)
            }
            await scenarios[name]({ page, phone, motion, shot, check, result })
            check(
              await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
              'Document fits viewport'
            )
            assert.deepEqual(result.errors, [], 'Uncaught browser errors')
            result.status = 'pass'
          } catch (error) {
            result.status = 'fail'
            result.failure = String(error.stack || error).slice(0, 4000)
            result.screen = (
              await page
                .locator('body')
                .innerText()
                .catch(() => '')
            ).slice(-2000)
            const file = `${label}-failure.png`
            await page.screenshot({ path: path.join(out, file) }).catch(() => {})
            result.shots.push(file)
            process.exitCode = 1
          } finally {
            await context.close()
          }
          console.log(
            `${result.status.toUpperCase()} ${label} ${result.failure?.split('\n')[0] || ''}`
          )
          await writeFile(path.join(out, 'results.json'), JSON.stringify(report, null, 2) + '\n')
        }
      }
  assert.ok(report.cases.length, 'Select an existing QA_VARIANT')
  report.finished = new Date().toISOString()
  await writeFile(path.join(out, 'results.json'), JSON.stringify(report, null, 2) + '\n')
} finally {
  await browser?.close()
  server.closeAllConnections()
  await new Promise((done) => server.close(done))
}
