import { chromium } from 'playwright'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'

const origin = 'http://127.0.0.1:8090'
const output = new URL('../artifacts/feature-validation/', import.meta.url)
await mkdir(output, { recursive: true })
const keyword = '定位锚点'
const title = '合成历史 · 分支与图片'
const targetId = 'alternate-a10'
const fixture = () => {
  const messages = []
  const time = Date.UTC(2026, 10, 16)
  const add = (id, parentId, selectedChildId, role, content) => {
    const common = { id, parentId, selectedChildId, role, createdAt: time + messages.length * 1000 }
    messages.push(role === 'user' ? { ...common, content, files: [] } : { ...common, model: 'deepseek-chat', prefix: false, status: 'done', blocks: [{ type: 'text', text: content }] })
  }
  for (let n = 0; n < 30; n++) {
    add(`main-u${n}`, n === 0 ? null : `main-a${n - 1}`, `main-a${n}`, 'user', `原始分支第 ${n + 1} 轮提问。共同关键词。`)
    add(`main-a${n}`, `main-u${n}`, n < 29 ? `main-u${n + 1}` : undefined, 'assistant', `原始分支第 ${n + 1} 轮回复。\n\n这是用于隔离界面验收的合成记录，没有真实历史。`.repeat(3))
  }
  add('alternate-a0', 'main-u0', 'alternate-u1', 'assistant', '另一版本的回答。')
  for (let n = 1; n <= 26; n++) {
    add(`alternate-u${n}`, `alternate-a${n - 1}`, `alternate-a${n}`, 'user', `另一版本第 ${n + 1} 轮提问。`)
    add(`alternate-a${n}`, `alternate-u${n}`, n < 26 ? `alternate-u${n + 1}` : undefined, 'assistant', n === 10 ? `这里有 **${keyword}**，用于验证跨分支搜索以及中文关键词高亮。\n\n目标消息完整正文。` : `另一版本第 ${n + 1} 轮回复。\n\n图片、字体或布局变化后仍应保持目标消息的位置。`.repeat(4))
  }
  return { id: 'feature-fixture', title, createdAt: time, updatedAt: time + 200000, rootMessageId: 'main-u0', messages }
}
const scenarios = [
  { name: 'phone-light', width: 390, height: 844, theme: 'light' },
  { name: 'phone-dark', width: 390, height: 844, theme: 'dark' },
  { name: 'tablet-light', width: 820, height: 1180, theme: 'light' },
  { name: 'tablet-dark', width: 820, height: 1180, theme: 'dark' },
  { name: 'landscape-light', width: 1180, height: 820, theme: 'light' },
  { name: 'landscape-dark', width: 1180, height: 820, theme: 'dark' },
].filter((scenario) => !process.env.FEATURE_SCENARIO || scenario.name === process.env.FEATURE_SCENARIO)
const priorResults = process.env.FEATURE_SCENARIO ? await readFile(new URL('results.json', output), 'utf8').then(JSON.parse).catch(() => []) : []
const results = priorResults.filter((result) => result.scenario.name !== process.env.FEATURE_SCENARIO)
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const image = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="240"><rect width="300" height="240" fill="#8ca9d8"/><text x="20" y="100" font-size="20">Synthetic image</text></svg>')
try {
  for (const scenario of scenarios) {
    const context = await browser.newContext({ viewport: { width: scenario.width, height: scenario.height }, hasTouch: true, colorScheme: scenario.theme, locale: 'zh-CN', reducedMotion: 'reduce' })
    const page = await context.newPage()
    page.setDefaultTimeout(7000)
    const report = { scenario, checks: [], pageErrors: [], blockedRequests: [] }
    results.push(report)
    page.on('pageerror', (error) => report.pageErrors.push(error.message))
    await context.route('**/*', (route) => {
      const url = route.request().url()
      if ((url.startsWith(origin + '/') && route.request().method() === 'GET' && !/\/(?:api|v1)\//.test(url)) || url.startsWith('data:') || url.startsWith('blob:')) return route.continue()
      report.blockedRequests.push({ method: route.request().method(), url })
      return route.abort('blockedbyclient')
    })
    await context.addInitScript(({ theme }) => {
      localStorage.setItem('chat-demo:api-key', 'synthetic-ui-test-key-never-use')
      localStorage.setItem('chat-demo:locale', 'zh-CN')
      localStorage.setItem('chat-demo:theme-preference', theme)
    }, scenario)
    const check = async (name, run) => {
      try { const evidence = await run(); report.checks.push({ name, pass: true, evidence }); console.log(`${scenario.name}: PASS ${name}`); return true }
      catch (error) { report.checks.push({ name, pass: false, error: error.message }); console.log(`${scenario.name}: FAIL ${name}: ${error.message}`); return false }
    }
    const shot = async (name) => {
      const filename = `${scenario.name}-${name}.png`
      await page.screenshot({ path: new URL(filename, output).pathname, fullPage: false })
      return filename
    }
    const noHorizontalOverflow = async (scope = 'body') => page.locator(scope).first().evaluate((element) => {
      const viewport = window.innerWidth
      const visible = [element, ...element.querySelectorAll('*')].filter((item) => {
        const style = getComputedStyle(item)
        const rect = item.getBoundingClientRect()
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0
      })
      return { viewport, documentWidth: document.documentElement.scrollWidth, overflowing: visible.filter((item) => { const rect = item.getBoundingClientRect(); return rect.left < -2 || rect.right > viewport + 2 }).slice(0, 8).map((item) => ({ tag: item.tagName, text: item.textContent?.slice(0, 70), left: item.getBoundingClientRect().left, right: item.getBoundingClientRect().right })) }
    })
    const openSearch = async () => {
      if (page.viewportSize().width < 768) await page.getByRole('button', { name: '打开边栏', exact: true }).click()
      await page.getByRole('button', { name: '搜索历史对话', exact: true }).click()
      await page.getByRole('dialog', { name: '搜索历史对话' }).waitFor()
    }
    try {
      await page.goto(origin, { waitUntil: 'networkidle' })
      await page.evaluate(async (session) => {
        const db = await new Promise((resolve, reject) => { const request = indexedDB.open('chat-demo'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
        await new Promise((resolve, reject) => {
          const tx = db.transaction(['sessions', 'sessionSummaries'], 'readwrite')
          tx.objectStore('sessions').put(session)
          tx.objectStore('sessionSummaries').put({ id: session.id, title: session.title, createdAt: session.createdAt, updatedAt: session.updatedAt, fileIds: [] })
          tx.oncomplete = resolve; tx.onerror = () => reject(tx.error)
        })
        db.close()
      }, fixture())
      await page.reload({ waitUntil: 'networkidle' })
      if (scenario.width >= 768) await check('collapsed sidebar search entry', async () => {
        await page.getByRole('button', { name: '收起边栏', exact: true }).click()
        await page.getByRole('button', { name: '搜索历史对话', exact: true }).click()
        await page.getByRole('dialog', { name: '搜索历史对话' }).waitFor()
        await page.keyboard.press('Escape')
        await page.getByRole('button', { name: '打开边栏', exact: true }).click()
        return { accessible: true }
      })
      await check('global search entry, all-branch result, literal keyword highlight', async () => {
        await openSearch()
        await page.getByRole('searchbox', { name: '搜索历史对话' }).fill(keyword)
        const result = page.getByRole('dialog').getByRole('button').filter({ hasText: '其他版本' })
        await result.waitFor()
        assert.equal(await result.count(), 1)
        assert.equal(await result.locator('mark').count(), 1)
        const layout = await noHorizontalOverflow('dialog')
        assert.deepEqual(layout.overflowing, [])
        return { result: await result.innerText(), layout, screenshot: await shot('search') }
      })
      const located = await check('cross-branch target restoration and body highlight', async () => {
        await page.getByRole('dialog').getByRole('button').filter({ hasText: '其他版本' }).click()
        await page.locator(`[data-message-id="${targetId}"]`).waitFor()
        await page.getByText('已定位搜索结果', { exact: true }).waitFor()
        assert.equal(await page.locator('[data-message-id="main-a0"]').count(), 0)
        const details = await page.locator(`[data-message-id="${targetId}"]`).evaluate((target) => {
          let scroll = target.parentElement
          while (scroll && !['auto', 'scroll'].includes(getComputedStyle(scroll).overflowY)) scroll = scroll.parentElement
          return { targetTop: target.getBoundingClientRect().top, scrollTop: scroll?.getBoundingClientRect().top, highlightRanges: CSS.highlights?.get('history-search')?.size ?? 0, focused: document.activeElement === target }
        })
        assert.ok(details.highlightRanges > 0)
        assert.ok(Math.abs(details.targetTop - details.scrollTop - 24) <= 3)
        assert.equal(details.focused, true)
        return { ...details, screenshot: await shot('located') }
      })
      if (located) {
        await check('late image loading preserves target position', async () => {
          const topBefore = await page.locator(`[data-message-id="${targetId}"]`).evaluate((element) => element.getBoundingClientRect().top)
          await page.locator('[data-message-id="alternate-a8"]').evaluate((element, source) => {
            const img = document.createElement('img'); img.dataset.validationImage = 'true'; img.alt = 'Synthetic delayed layout image'; img.style.display = 'block'; img.style.maxWidth = '100%'; element.append(img); img.src = source
            return img.decode()
          }, image)
          await page.waitForTimeout(100)
          const topAfter = await page.locator(`[data-message-id="${targetId}"]`).evaluate((element) => element.getBoundingClientRect().top)
          assert.ok(Math.abs(topBefore - topAfter) <= 3)
          return { topBefore, topAfter, note: 'Controlled late-decoding image injected into prior message; product source unchanged.' }
        })
        await check('resize keeps target anchored and touch immediately releases', async () => {
          const newWidth = scenario.width < 768 ? 430 : scenario.width - 60
          await page.setViewportSize({ width: newWidth, height: scenario.height - 80 })
          await page.waitForTimeout(100)
          const info = await page.locator(`[data-message-id="${targetId}"]`).evaluate((target) => {
            let scroll = target.parentElement
            while (scroll && !['auto', 'scroll'].includes(getComputedStyle(scroll).overflowY)) scroll = scroll.parentElement
            const anchoredOffset = target.getBoundingClientRect().top - scroll.getBoundingClientRect().top
            scroll.style.overflowAnchor = 'none'
            const touch = new Touch({ identifier: 1, target: scroll, clientX: 200, clientY: 300 })
            scroll.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [touch], targetTouches: [touch], changedTouches: [touch] }))
            scroll.dispatchEvent(new TouchEvent('touchend', { bubbles: true, touches: [], targetTouches: [], changedTouches: [touch] }))
            const before = scroll.scrollTop
            const previous = document.querySelector('[data-message-id="alternate-a8"]')
            previous.style.paddingBottom = '170px'
            return { anchoredOffset, before }
          })
          await page.waitForTimeout(100)
          const after = await page.locator(`[data-message-id="${targetId}"]`).evaluate((target) => {
            let scroll = target.parentElement
            while (scroll && !['auto', 'scroll'].includes(getComputedStyle(scroll).overflowY)) scroll = scroll.parentElement
            return { scrollTop: scroll.scrollTop, offset: target.getBoundingClientRect().top - scroll.getBoundingClientRect().top }
          })
          assert.ok(Math.abs(info.anchoredOffset - 24) <= 3)
          assert.ok(Math.abs(after.scrollTop - info.before) <= 3)
          assert.ok(Math.abs(after.offset - 24) > 100)
          return { ...info, after, released: true }
        })
        await page.setViewportSize({ width: scenario.width, height: scenario.height })
        await check('context presets, expandable long list and accessible scrolling', async () => {
          await page.getByRole('button', { name: /^管理上下文:/ }).click()
          const dialog = page.getByRole('dialog', { name: '上下文额度' })
          await dialog.getByRole('button', { name: '最近 5 轮', exact: true }).click()
          await dialog.getByText('当前分支 27 轮，已选择 5 轮', { exact: true }).waitFor()
          await dialog.getByRole('button', { name: '最近 10 轮', exact: true }).click()
          await dialog.getByText('当前分支 27 轮，已选择 10 轮', { exact: true }).waitFor()
          await dialog.getByRole('button', { name: '显示更早轮次', exact: true }).click()
          assert.equal(await dialog.locator('details').count(), 27)
          const scrolling = await dialog.evaluate((element) => [...element.querySelectorAll('*')].filter((item) => ['auto', 'scroll'].includes(getComputedStyle(item).overflowY) && item.scrollHeight > item.clientHeight + 5).map((item) => { item.scrollTop = item.scrollHeight; return { tag: item.tagName, clientHeight: item.clientHeight, scrollHeight: item.scrollHeight, scrollTop: item.scrollTop } }))
          assert.ok(scrolling.some((entry) => entry.scrollTop > 0))
          const bounds = await dialog.boundingBox()
          assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= scenario.height + 1)
          const layout = await noHorizontalOverflow('[role="dialog"]')
          assert.deepEqual(layout.overflowing, [])
          const screenshot = await shot('context')
          await dialog.getByRole('button', { name: '关闭', exact: true }).click()
          return { scrolling, bounds, layout, screenshot }
        })
      }
      const readIds = () => page.evaluate(async () => {
        const db = await new Promise((resolve, reject) => { const request = indexedDB.open('chat-demo'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
        const value = await new Promise((resolve, reject) => { const request = db.transaction('sessions').objectStore('sessions').get('feature-fixture'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
        db.close(); return value.messages.map((message) => message.id)
      })
      const openDelete = async (id) => {
        const message = page.locator(`[data-message-id="${id}"]`)
        await message.scrollIntoViewIfNeeded()
        await message.hover()
        await message.getByRole('button', { name: '删除消息', exact: true }).click()
        return page.getByRole('dialog', { name: /^删除消息/ })
      }
      if (located) await check('three deletion confirmations, cancellation, single and following scopes', async () => {
        const initial = await readIds()
        for (const cancelAt of [1, 2, 3]) {
          const dialog = await openDelete('alternate-u26')
          assert.equal(await dialog.getByRole('radio', { name: /^仅删除单条/ }).isChecked(), true)
          if (cancelAt > 1) await dialog.getByRole('button', { name: '确认范围（1/3）', exact: true }).click()
          if (cancelAt > 2) await dialog.getByRole('button', { name: '确认消息（2/3）', exact: true }).click()
          assert.deepEqual(await readIds(), initial)
          if (cancelAt === 3) await page.keyboard.press('Escape')
          else await dialog.getByRole('button', { name: '取消', exact: true }).click()
          await dialog.waitFor({ state: 'detached' })
          assert.deepEqual(await readIds(), initial)
        }
        const single = await openDelete('alternate-u26')
        await single.getByRole('button', { name: '确认范围（1/3）', exact: true }).click()
        await single.getByRole('button', { name: '确认消息（2/3）', exact: true }).dispatchEvent('click', { detail: 2 })
        assert.equal(await single.getByRole('button', { name: '永久删除（3/3）', exact: true }).count(), 0)
        assert.deepEqual(await readIds(), initial)
        await single.getByRole('button', { name: '确认消息（2/3）', exact: true }).click()
        const singleShot = await shot('delete-single-third')
        assert.deepEqual(await readIds(), initial)
        await single.getByRole('button', { name: '永久删除（3/3）', exact: true }).click()
        await page.locator('[data-message-id="alternate-u26"]').waitFor({ state: 'detached' })
        assert.equal(await page.locator('[data-message-id="alternate-a26"]').count(), 1)
        assert.equal(await page.locator('[data-message-id="alternate-a26"]').getByRole('button', { name: '重新生成', exact: true }).isDisabled(), true)
        const afterSingle = await readIds()
        assert.equal(afterSingle.length, initial.length - 1)
        const following = await openDelete('alternate-u25')
        await following.getByRole('radio', { name: /^包括后面的所有消息/ }).check()
        await following.getByText('将删除 3 条消息', { exact: true }).waitFor()
        await following.getByRole('button', { name: '确认范围（1/3）', exact: true }).click()
        assert.deepEqual(await readIds(), afterSingle)
        await following.getByRole('button', { name: '确认消息（2/3）', exact: true }).click()
        const followingShot = await shot('delete-following-third')
        const layout = await noHorizontalOverflow('[role="dialog"]')
        assert.deepEqual(layout.overflowing, [])
        assert.deepEqual(await readIds(), afterSingle)
        await following.getByRole('button', { name: '永久删除（3/3）', exact: true }).click()
        await page.locator('[data-message-id="alternate-u25"]').waitFor({ state: 'detached' })
        const afterFollowing = await readIds()
        assert.equal(afterFollowing.length, afterSingle.length - 3)
        assert.ok(['alternate-u25', 'alternate-a25', 'alternate-a26'].every((id) => !afterFollowing.includes(id)))
        return { initial: initial.length, afterSingle: afterSingle.length, afterFollowing: afterFollowing.length, cancellationStages: [1, 2, 3], doubleClickBlocked: true, singleShot, followingShot, layout }
      })
      await check('search system back closes overlay without leaving app', async () => {
        await openSearch()
        await page.goBack()
        await page.getByRole('dialog', { name: '搜索历史对话' }).waitFor({ state: 'detached' })
        assert.ok(page.url().startsWith(origin))
        return { url: page.url() }
      })
      await check('backup settings stay within viewport and can scroll', async () => {
        if (scenario.width < 768) await page.getByRole('button', { name: '打开边栏', exact: true }).click()
        await page.getByRole('button', { name: '设置', exact: true }).click()
        const dataTab = page.getByRole('tab', { name: '数据管理', exact: true })
        if (await dataTab.count()) await dataTab.click()
        else await page.getByText('数据管理', { exact: true }).click()
        const backup = page.getByRole('region', { name: '历史备份', exact: true })
        await backup.waitFor()
        await backup.scrollIntoViewIfNeeded()
        const layout = await noHorizontalOverflow('section[aria-label="历史备份"]')
        assert.deepEqual(layout.overflowing, [])
        const bounds = await backup.boundingBox()
        assert.ok(bounds.width <= scenario.width)
        return { layout, bounds, screenshot: await shot('backup') }
      })
    } catch (error) {
      report.checks.push({ name: 'scenario setup/unhandled', pass: false, error: error.stack })
    }
    await check('no uncaught runtime errors or model requests', async () => {
      assert.deepEqual(report.pageErrors, [])
      const modelRequests = report.blockedRequests.filter((request) => /chat\/completions|\/v1\/messages|api\.deepseek\.com/.test(request.url))
      assert.deepEqual(modelRequests, [])
      return { blockedExternalRequests: report.blockedRequests.length, modelRequests: 0 }
    })
    await shot('final').catch(() => {})
    report.pageText = (await page.locator('body').innerText()).slice(0, 16000)
    await context.close()
    await writeFile(new URL('results.json', output), JSON.stringify(results, null, 2))
  }
} finally { await browser.close() }
const failed = results.flatMap((result) => result.checks.filter((check) => !check.pass).map((check) => `${result.scenario.name}: ${check.name}: ${check.error}`))
console.log(JSON.stringify({ scenarios: results.length, checks: results.reduce((sum, result) => sum + result.checks.length, 0), failures: failed }, null, 2))
if (failed.length) process.exitCode = 1
