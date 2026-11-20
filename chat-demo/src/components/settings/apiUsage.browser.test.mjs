// Build chat-demo first. API_USAGE_DIST can point at an isolated build directory.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { chromium } from '../../../../tools/node_modules/playwright/index.mjs'

const dist = process.env.API_USAGE_DIST ?? fileURLToPath(new URL('../../../dist', import.meta.url))
const origin = 'https://usage.test'
const contentTypes = {
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.html': 'text/html',
  '.png': 'image/png',
  '.webp': 'image/webp',
}

async function serveOffline(context) {
  const external = []
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.origin !== origin) {
      external.push(url.origin)
      return route.abort()
    }
    const filename = path.join(dist, url.pathname === '/' ? 'index.html' : url.pathname.slice(1))
    const ext = path.extname(filename)
    let body = await readFile(filename)
    // Disabling the unrelated release watcher keeps this report-only test completely offline.
    if (ext === '.html') {
      body = body.toString().replace(/<meta\b[^>]*name="application-version"[^>]*>/gi, '')
    }
    return route.fulfill({ contentType: contentTypes[ext], body })
  })
  return external
}

for (const [locale, width, dark] of [
  ['en-US', 320, true],
  ['zh-CN', 390, false],
  ['zh-CN', 1024, false],
]) {
  test(`Settings usage report at ${width}px in ${locale}`, async () => {
    const browser = await chromium.launch({
      executablePath:
        process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    })
    try {
      const context = await browser.newContext({
        viewport: { width, height: 760 },
        locale,
        hasTouch: width < 500,
        timezoneId: 'America/Havana',
        colorScheme: dark ? 'dark' : 'light',
        reducedMotion: 'reduce',
      })
      const external = await serveOffline(context)
      const page = await context.newPage()
      page.setDefaultTimeout(5000)
      await page.goto(origin)
      const entry = page.locator('[data-api-usage-entry]')
      await entry.click()
      await page.locator('[data-usage-loaded]').waitFor()
      const reportDialog = page.getByRole('dialog', {
        name: locale === 'en-US' ? 'Model usage' : '模型用量',
        exact: true,
      })
      assert.equal(await page.locator('[data-usage-total]').count(), 0)
      if (process.env.API_USAGE_SHOTS)
        await page.screenshot({
          path: path.join(process.env.API_USAGE_SHOTS, `usage-${width}-empty.png`),
        })
      if (width < 500) {
        assert.equal(
          await reportDialog.evaluate(
            (el) => el.matches(':modal') && el === document.activeElement
          ),
          true
        )
        await page.keyboard.press('Tab')
        assert.ok(
          await reportDialog.locator('header button').evaluate((el) => el.matches(':focus-visible'))
        )
        const header = reportDialog.locator('header')
        const box = await header.boundingBox()
        assert.equal(box.y, 0)
        assert.equal(box.height, 56)
        for (const control of await reportDialog.locator('button,summary').all()) {
          const target = await control.boundingBox()
          assert.ok(
            target.width >= 44 && target.height >= 44,
            `Small target: ${await control.innerText()}`
          )
        }
        await header.getByRole('button', { name: locale === 'en-US' ? 'Back' : '返回' }).click()
      } else {
        await page.keyboard.press('Escape')
      }
      await reportDialog.waitFor({ state: 'detached' })
      assert.ok(await entry.evaluate((el) => el === document.activeElement))
      await page.evaluate(async () => {
        const raw = await new Promise((resolve, reject) => {
          const req = indexedDB.open('chat-demo')
          req.onsuccess = () => resolve(req.result)
          req.onerror = () => reject(req.error)
        })
        const tx = raw.transaction(
          [
            'sessions',
            'sessionsStaging',
            'sessionSummaries',
            'sessionSummariesStaging',
            'historyMeta',
          ],
          'readwrite'
        )
        tx.objectStore('historyMeta').put(1, 'active')
        const now = Date.now() - 100
        const older = new Date(now)
        older.setDate(older.getDate() - 15)
        const reply = (at, input) => ({
          role: 'assistant',
          id: String(at),
          createdAt: at,
          blocks: [],
          usage: {
            input_tokens: input,
            cache_creation_input_tokens: 1,
            cache_read_input_tokens: 2,
            output_tokens: 3,
          },
        })
        const save = (id, at, messages, hint, suffix = 'Staging') => {
          const summary = { id, title: id, createdAt: at, updatedAt: at, fileIds: [], ...hint }
          tx.objectStore('sessionSummaries' + suffix).put(summary)
          tx.objectStore('sessions' + suffix).put({ ...summary, messages })
        }
        save('legacy', 1, [reply(now, 94), reply(+older, 14)], {})
        save('imported', now, [], { latestUsageAt: null })
        save('old', 1, [reply(1, 8)], { latestUsageAt: 1 })
        save('inactive', now, [reply(now, 99999)], {}, '')
        await new Promise((resolve, reject) => {
          tx.oncomplete = resolve
          tx.onabort = () => reject(tx.error)
        })
        raw.close()
        const ledger = await new Promise((resolve, reject) => {
          const req = indexedDB.open('deepchat-usage')
          req.onsuccess = () => resolve(req.result)
          req.onerror = () => reject(req.error)
        })
        const seed = ledger.transaction(['meta', 'requests'], 'readwrite')
        seed.objectStore('meta').delete('legacy') // Simulate the first open after upgrading a v53 device.
        const rows = seed.objectStore('requests')
        const base = { provider: 'QA API', model: 'qa-model', purpose: 'chat', status: 'done' }
        rows.put({
          ...base,
          id: 'paired',
          at: now,
          input: 100,
          output: 20,
          inputHit: 50,
          outputHit: 0,
        })
        rows.put({ ...base, id: 'unpaired', at: now - 1, input: 900, output: 80 })
        rows.put({ ...base, id: 'hit-only', at: now - 2, inputHit: 9, outputHit: 1 })
        rows.put({
          ...base,
          id: 'other',
          at: now - 3,
          provider: 'Local',
          model: 'local:model',
          input: 10,
          output: 10,
          outputHit: 5,
        })
        for (let index = 0; index < 11; index++)
          rows.put({ ...base, id: 'missing' + index, at: now - index - 10, status: 'failed' })
        await new Promise((resolve, reject) => {
          seed.oncomplete = resolve
          seed.onabort = () => reject(seed.error)
        })
        ledger.close()
        window.open = (url, target, options) => {
          window.openedReport = [url, target, options]
          return null
        }
        window.dispatchEvent(new Event('deepchat:open-api-usage'))
      })
      const report = page.locator('[data-api-usage]')
      await report.locator('[data-usage-total="1220"]').waitFor()
      const summary = report.locator('[data-usage-summary]')
      const metric = (el, key) =>
        el.locator(`[data-usage-metric="${key}"]`).getAttribute('data-value')
      await report.locator('[data-usage-filter="provider"]').selectOption('QA API')
      await report.locator('[data-usage-filter="model"]').selectOption('qa-model')
      await report.locator('[data-usage-total="1100"]').waitFor()
      assert.equal(await metric(summary, 'input'), '1000')
      assert.equal(await metric(summary, 'inputHit'), '59')
      assert.equal(await metric(summary, 'inputRate'), '50')
      assert.equal(await metric(summary, 'outputHit'), '1')
      assert.equal(await metric(summary, 'outputRate'), '0')
      assert.equal(await metric(summary, 'cacheWrite'), 'missing')
      assert.match(await summary.locator('[data-usage-metric="inputRate"]').innerText(), /1.*14/)
      const daily = report
        .locator('details')
        .filter({
          has: page.locator('summary', { hasText: locale === 'en-US' ? 'By date' : '按日期查看' }),
        })
        .first()
      await daily.locator(':scope > summary').click()
      const day = daily.locator('details').first()
      await day.locator('summary').click()
      assert.equal(await metric(day, 'inputRate'), '50')
      await daily.locator(':scope > summary').click()
      const requests = report.locator('[data-usage-requests]')
      await requests.locator(':scope > summary').click()
      assert.equal(await requests.locator('[data-usage-row]').count(), 10)
      const paired = requests.locator('[data-usage-row]').first()
      await paired.locator('summary').click()
      assert.equal(await metric(paired, 'outputHit'), '0')
      const next = requests.getByRole('button', { name: locale === 'en-US' ? 'Next' : '下一页' })
      await next.click()
      const missing = requests.locator('[data-usage-row]').first()
      await missing.locator('summary').click()
      assert.equal(await metric(missing, 'outputHit'), 'missing')
      await report.locator('[data-usage-filter="provider"]').selectOption('legacy')
      await report.locator('[data-usage-days="1"]').click()
      await report.locator('[data-usage-total="100"]').waitFor()
      await report.locator('[data-usage-days="30"]').click()
      await report.locator('[data-usage-total="120"]').waitFor()
      await report.locator('[data-usage-days="all"]').click()
      await report.locator('[data-usage-total="134"]').waitFor()
      if (process.env.API_USAGE_SHOTS)
        await page.screenshot({
          path: path.join(process.env.API_USAGE_SHOTS, `usage-${width}-recorded.png`),
        })
      assert.ok(await report.evaluate((el) => el.scrollWidth <= el.clientWidth))
      await report.locator('[data-api-usage-official]').click()
      assert.deepEqual(await page.evaluate(() => window.openedReport), [
        'https://platform.deepseek.com/usage',
        '_blank',
        'noopener',
      ])
      const refresh = report.getByRole('button', {
        name: locale === 'en-US' ? 'Refresh usage' : '刷新统计',
      })
      await refresh.click()
      await report.locator('[data-usage-total="134"]').waitFor()
      await page.keyboard.press('Escape')
      await report.waitFor({ state: 'detached' })
      if (width === 390) {
        // The account panel sends a source marker. A normal Settings entry must not reopen it.
        await page.addInitScript(() => {
          window.bridgeOps = []
          window.DshNative = { postMessage: (frame) => window.bridgeOps.push(JSON.parse(frame)) }
        })
        await page.reload()
        await page.waitForFunction(() => window.bridgeOps.some((frame) => frame.op === 'status'))
        for (const fromAccount of [false, true]) {
          await page.evaluate(
            (account) =>
              window.dispatchEvent(
                account
                  ? new CustomEvent('deepchat:open-api-usage', { detail: { fromAccount: true } })
                  : new Event('deepchat:open-api-usage')
              ),
            fromAccount
          )
          await reportDialog.getByRole('button', { name: '返回' }).click()
          await reportDialog.waitFor({ state: 'detached' })
          assert.deepEqual(
            await page.evaluate(() => window.bridgeOps.filter((frame) => frame.op === 'account')),
            fromAccount ? [{ op: 'account', fromUsage: true }] : []
          )
        }
      }
      assert.deepEqual(external, [])
    } finally {
      await browser.close()
    }
  })
}

for (const reducedMotion of ['no-preference', 'reduce']) {
  test(`Settings preserves each parent and consumes Back during exit (${reducedMotion})`, async () => {
    const browser = await chromium.launch({
      executablePath:
        process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    })
    try {
      const context = await browser.newContext({
        viewport: { width: 390, height: 530 },
        hasTouch: true,
        locale: 'zh-CN',
        reducedMotion,
      })
      await serveOffline(context)
      const page = await context.newPage()
      page.setDefaultTimeout(5000)
      const errors = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.goto(origin)
      const route = (name) => page.locator(`[data-settings-route="${name}"]`)
      const front = (name) =>
        page.locator(`[data-settings-route="${name}"][data-route-position="front"]:not([inert])`)
      const back = async (from, to) => {
        await route(from).getByRole('button', { name: '返回', exact: true }).click()
        await route(from).waitFor({ state: 'detached' })
        await front(to).waitFor()
      }
      const enter = async (from, name, to) => {
        await front(from).getByRole('button', { name }).click()
        await front(to).waitFor()
      }
      await front('apiKey').waitFor()
      // Usage is a top-layer dialog. Both surfaces must move, and repeated Back must stay in it.
      await front('apiKey').locator('[data-api-usage-entry]').click()
      const usage = page.locator('dialog[data-usage-source="settings"]')
      await usage.waitFor()
      const parentShift = await usage.evaluate(async (dialog) => {
        const parent = document.querySelector('[data-settings-route="apiKey"]')
        await Promise.allSettled(
          [...parent.getAnimations(), ...dialog.firstElementChild.getAnimations()].map(
            (a) => a.finished
          )
        )
        return new DOMMatrix(getComputedStyle(parent).transform).m41
      })
      assert.equal(parentShift < 0, reducedMotion === 'no-preference')
      await page.keyboard.press('Escape')
      if (reducedMotion === 'no-preference') await page.keyboard.press('Escape')
      await usage.waitFor({ state: 'detached' })
      await front('apiKey').waitFor()
      await page.evaluate(() => {
        document.documentElement.dir = 'rtl'
      })
      await enter('apiKey', /申请官方 API Key/, 'guide')
      const rtl = await front('guide').evaluate(async (el) => {
        const parent = document.querySelector('[data-settings-route="apiKey"]')
        await Promise.allSettled(parent.getAnimations().map((a) => a.finished))
        return [
          new DOMMatrix(getComputedStyle(parent).transform).m41,
          new DOMMatrix(getComputedStyle(el.querySelector('header svg')).transform).m11,
        ]
      })
      assert.equal(rtl[0] > 0, reducedMotion === 'no-preference')
      assert.equal(rtl[1], -1)
      await page.evaluate(() => {
        document.documentElement.dir = 'ltr'
      })
      await page.evaluate(() => history.back())
      await route('guide').waitFor({ state: 'detached' })
      await front('apiKey').waitFor()
      await enter('apiKey', /添加|新增/, 'apiEdit')
      await back('apiEdit', 'apiKey')
      // First launch opens the API-key route directly. Back returns to chat.
      await front('apiKey').getByRole('button', { name: '返回' }).click()
      await route('apiKey').waitFor({ state: 'detached' })
      await page.getByRole('button', { name: /^打开边栏/ }).click()
      await page.getByRole('button', { name: '设置', exact: true }).click()
      await front('root').locator('[data-usage-home-entry]').click()
      await usage.locator('[data-usage-loaded]').waitFor()
      await usage.getByRole('button', { name: '返回' }).click()
      await usage.waitFor({ state: 'detached' })
      await front('root').waitFor()
      await enter('root', /数据管理/, 'data')
      const importFromLink = front('data').getByRole('button', { name: '从 DeepSeek 链接导入' })
      await importFromLink.click()
      assert.equal(await importFromLink.getAttribute('aria-expanded'), 'true')
      const link = front('data').getByRole('textbox', { name: '导出链接', exact: true })
      await link.fill('draft')
      await enter('data', /已压缩的对话/, 'compacted')
      await back('compacted', 'data')
      assert.equal(await link.inputValue(), 'draft')
      await back('data', 'root')
      await enter('root', /账号资料/, 'profile')
      await enter('profile', /位置信息/, 'location')
      await back('location', 'profile')
      await back('profile', 'root')
      const rootScroll = route('root').locator(':scope > div').last()
      const start = await rootScroll.evaluate((el) => {
        el.scrollTop = el.scrollHeight
        return el.scrollTop
      })
      assert.ok(start > 0)
      await route('root')
        .getByRole('button', { name: /朗读音色/ })
        .click()
      const voice = page.getByRole('dialog', { name: /朗读音色$/ })
      await voice.waitFor()
      await page.keyboard.press('Escape')
      if (reducedMotion === 'no-preference') await page.keyboard.press('Escape')
      await voice.waitFor({ state: 'detached' })
      await front('root').waitFor()
      const font = route('root').getByRole('button', { name: /字体大小/ })
      await font.scrollIntoViewIfNeeded()
      const before = await rootScroll.evaluate((el) => el.scrollTop)
      await font.click()
      await front('fontSize').waitFor()
      const popObservations = await page.evaluate(async (motion) => {
        const parent = document.querySelector('[data-settings-route="root"]')
        const child = document.querySelector('[data-settings-route="fontSize"]')
        await Promise.allSettled(child.getAnimations().map((a) => a.finished))
        const parentX = new DOMMatrix(getComputedStyle(parent).transform).m41
        child.querySelector('header button').click()
        await Promise.resolve()
        const leaving = child.dataset.routePosition === 'leaving' && child.isConnected
        if (leaving && motion)
          document.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
          )
        return { parentX, leaving }
      }, reducedMotion === 'no-preference')
      assert.equal(popObservations.parentX < 0, reducedMotion === 'no-preference')
      assert.equal(popObservations.leaving, reducedMotion === 'no-preference')
      await route('fontSize').waitFor({ state: 'detached' })
      await front('root').waitFor()
      assert.equal(await rootScroll.evaluate((el) => el.scrollTop), before)
      assert.ok(await font.evaluate((el) => el === document.activeElement))
      await page.keyboard.press('Escape')
      await route('root').waitFor({ state: 'detached' })
      const drawer = page.locator('[class^="drawer-"]')
      assert.equal(await drawer.getAttribute('aria-hidden'), 'false')
      const settings = drawer.getByRole('button', { name: '设置', exact: true })
      await settings.click()
      await front('root').waitFor()
      await page.keyboard.press('Escape')
      await route('root').waitFor({ state: 'detached' })
      assert.equal(await drawer.getAttribute('aria-hidden'), 'false')
      assert.ok(await settings.evaluate((el) => el === document.activeElement))
      assert.deepEqual(errors, [])
    } finally {
      await browser.close()
    }
  })
}
