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
      const external = []
      await context.route('**/*', async (route) => {
        const url = new URL(route.request().url())
        if (url.origin !== origin) {
          external.push(url.origin)
          return route.abort()
        }
        const filename = path.join(
          dist,
          url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
        )
        const ext = path.extname(filename)
        let body = await readFile(filename)
        // Disabling the unrelated release watcher keeps this report-only test completely offline.
        if (ext === '.html') {
          body = body.toString().replace(/<meta\b[^>]*name="application-version"[^>]*>/gi, '')
        }
        return route.fulfill({ contentType: contentTypes[ext], body })
      })
      const page = await context.newPage()
      page.setDefaultTimeout(5000)
      await page.goto(origin)
      const entry = page.locator('[data-api-usage-entry]')
      await entry.click()
      await page.locator('[data-usage-loaded]').waitFor()
      const reportDialog = page.getByRole('dialog', {
        name: locale === 'en-US' ? 'API usage' : 'API 使用情况',
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
        const get = IDBObjectStore.prototype.get
        window.detailReads = []
        IDBObjectStore.prototype.get = function (key) {
          if (['files', 'filesStaging', 'sessions', 'sessionsStaging'].includes(this.name)) {
            window.detailReads.push([this.name, key])
          }
          return get.call(this, key)
        }
        window.open = (url, target, options) => {
          window.openedReport = [url, target, options]
          return null
        }
        window.dispatchEvent(new Event('deepchat:open-api-usage'))
      })
      await page.locator('[data-usage-total="100"]').waitFor()
      assert.deepEqual(await page.evaluate(() => window.detailReads), [
        ['sessionsStaging', 'legacy'],
      ])
      const report = page.locator('[data-api-usage]')
      await report.locator('[data-usage-days="30"]').click()
      await report.locator('[data-usage-total="120"]').waitFor()
      assert.equal(
        await report.locator('[data-usage-days="30"]').getAttribute('aria-pressed'),
        'true'
      )
      assert.deepEqual(await report.locator('dl dd').allTextContents(), ['108', '2', '4', '6'])
      if (process.env.API_USAGE_SHOTS)
        await page.screenshot({
          path: path.join(process.env.API_USAGE_SHOTS, `usage-${width}-recorded.png`),
        })
      const refresh = report.getByRole('button', {
        name: locale === 'zh-CN' ? '刷新统计' : 'Refresh usage',
      })
      await refresh.focus()
      await page.keyboard.press('Tab')
      assert.equal(await page.evaluate(() => document.activeElement.tagName), 'SUMMARY')
      await page.keyboard.press('Enter')
      assert.equal(await report.locator('tbody tr').count(), 30)
      assert.equal(await report.locator('tbody tr').first().locator('td').innerText(), '100')
      assert.equal(
        await report.locator('tbody tr').nth(1).locator('td').innerText(),
        locale === 'zh-CN' ? '无记录' : 'No record'
      )
      assert.ok(await report.evaluate((el) => el.scrollWidth <= el.clientWidth))
      await report.locator('[data-api-usage-official]').click()
      assert.deepEqual(await page.evaluate(() => window.openedReport), [
        'https://platform.deepseek.com/usage',
        '_blank',
        'noopener',
      ])
      await refresh.click()
      await page.waitForFunction(() => window.detailReads.length === 2)
      await report.locator('[data-usage-total="120"]').waitFor()
      await page.keyboard.press('Escape')
      await report.waitFor({ state: 'detached' })
      if (width === 390) {
        // The account panel sends a source marker. A normal Settings entry must not reopen it.
        await page.addInitScript(() => {
          window.bridgeOps = []
          window.DshNative = { postMessage: (frame) => window.bridgeOps.push(JSON.parse(frame).op) }
        })
        await page.reload()
        await page.waitForFunction(() => window.bridgeOps.includes('status'))
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
          assert.equal(
            await page.evaluate(() => window.bridgeOps.filter((op) => op === 'account').length),
            Number(fromAccount)
          )
        }
      }
      assert.deepEqual(external, [])
    } finally {
      await browser.close()
    }
  })
}
