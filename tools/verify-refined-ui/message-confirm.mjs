// Run: node tools/verify-refined-ui/message-confirm.mjs path/to/dist path/to/evidence
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, sep, extname } from 'node:path'
import { chromium } from 'playwright'

const [assets, evidence] = process.argv.slice(2)
assert(assets && evidence)
const root = resolve(assets)
const out = resolve(evidence)
await mkdir(out, { recursive: true })
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' })
const results = []
const origin = 'https://messages.test'
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' }

async function seedChats(page) {
  await page.waitForFunction(async () => (await indexedDB.databases()).some(db => db.name === 'chat-demo' && db.version >= 12))
  await page.evaluate(async () => {
    const db = await new Promise((ok, fail) => {
      const req = indexedDB.open('chat-demo')
      req.onsuccess = () => ok(req.result)
      req.onerror = () => fail(req.error)
    })
    const now = Date.now()
    const tx = db.transaction(['sessions', 'sessionSummaries'], 'readwrite')
    for (const scope of ['single', 'following']) {
      const session = { id: scope, title: scope === 'single' ? '单条消息练习' : '连续消息练习', createdAt: now, updatedAt: now, fileIds: [] }
      const text = ['周末想去哪里？', '可以去苏州。', '周六下午看什么？', '可以去苏州博物馆。', '或者沿着平江路慢慢走。']
      const messages = text.map((value, i) => ({
        id: `msg${i}`, createdAt: now + i, parentId: i === 0 ? null : `msg${i === 4 ? 2 : i-1}`,
        selectedChildId: i < 3 ? `msg${i+1}` : undefined,
        ...(i === 0 || i === 2 ? { role: 'user', files: [], content: value } : { role: 'assistant', status: 'done', blocks: [{ type: 'text', text: value }] })
      }))
      tx.objectStore('sessionSummaries').put(session)
      tx.objectStore('sessions').put({ ...session, rootMessageId: 'msg0', messages })
    }
    await new Promise((ok, fail) => { tx.oncomplete = ok; tx.onerror = () => fail(tx.error) })
    db.close()
  })
  await page.reload()
}

async function verify(view) {
  const { width, theme, reduced } = view
  const prefix = `${width}-${theme}`
  const ctx = await browser.newContext({ viewport: { width, height: width > 800 ? 800 : 740 }, isMobile: width < 800, hasTouch: width < 800, locale: 'zh-CN', reducedMotion: reduced ? 'reduce' : 'no-preference', colorScheme: theme })
  const page = await ctx.newPage()
  page.setDefaultTimeout(6000)
  const errors = []
  page.on('pageerror', err => errors.push(err.message))
  const rec = { ...view, scopes: [] }
  results.push(rec)
  try {
    await page.route('**/*', async route => {
      const url = new URL(route.request().url())
      if (url.origin !== origin) return route.abort()
      const file = resolve(root, '.' + (url.pathname === '/' ? '/index.html' : url.pathname))
      assert(file.startsWith(root + sep))
      try { await route.fulfill({ body: await readFile(file), contentType: types[extname(file)] || 'application/octet-stream' }) }
      catch { await route.fulfill({ status: 404 }) }
    })
    await page.addInitScript(theme => {
      localStorage.setItem('chat-demo:locale', 'zh-CN')
      localStorage.setItem('chat-demo:theme-preference', theme)
      localStorage.setItem('chat-demo:api-profiles', JSON.stringify([{ id: 'demo', name: '测试方案', apiKey: 'fixture-only', protocol: 'deepseek', origin: 'https://api.deepseek.com', model: 'deepseek-flash' }]))
      localStorage.setItem('chat-demo:active-profile', 'demo')
    }, theme)
    await page.goto(origin)
    if (width < 800) await page.getByRole('button', { name: '打开边栏', exact: true }).waitFor()
    await seedChats(page)
    const button = (parent, name) => parent.getByRole('button', { name, exact: typeof name === 'string' })
    const surface = step => page.getByRole('dialog', { name: `删除消息 · ${step}/3`, exact: true })
    const shot = async name => { await page.waitForFunction(() => document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).every(a => a.playState !== 'running')); await page.screenshot({ path: resolve(out, `${prefix}-${name}.png`) }) }
    const selectSession = async title => {
      if (width < 800) await button(page, '打开边栏').click()
      await button(page, title).click()
      await page.locator('[data-message-id="msg2"]').waitFor()
    }
    const remove = () => button(page.locator('[data-message-id="msg2"]'), '删除消息').click()
    const safe = async step => {
      const dlg = surface(step)
      await dlg.waitFor()
      assert(await button(dlg, '取消').evaluate(el => el === document.activeElement), `Step ${step}: safe focus`)
      assert.equal(await dlg.evaluate(el => el.closest('[data-placement]').dataset.placement), width < 800 ? 'bottom' : 'center')
      assert.equal(await dlg.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true)
      return dlg
    }
    for (const mode of ['single', 'following']) {
      const title = mode === 'single' ? '单条消息练习' : '连续消息练习'
      await selectSession(title)
      await remove()
      let dlg = await safe(1)
      assert(await dlg.getByRole('radio', { name: /仅删除单条/ }).isChecked())
      await page.keyboard.press('Enter')
      await dlg.waitFor({ state: 'hidden' })
      assert(await page.locator('[data-message-id="msg2"]').isVisible(), 'Initial Enter safely cancels')
      await remove()
      dlg = await safe(1)
      if (mode === 'following') await dlg.getByRole('radio', { name: /包括后面的所有消息/ }).check()
      await dlg.getByText(`将删除 ${mode === 'single' ? 1 : 3} 条消息`).waitFor()
      if (mode === 'following') {
        await dlg.getByText('其中 1 条来自其他版本。').waitFor()
        await shot('choose-range')
      }
      await button(dlg, /确认范围/).click()
      dlg = await safe(2)
      assert(await button(dlg, /确认消息/).isDisabled(), 'Accidental immediate continuation blocked')
      assert.equal(await page.locator('[data-message-id="msg2"]').count(), 1)
      await button(dlg, /确认消息/).click()
      dlg = await safe(3)
      assert.equal(await page.locator('[data-message-id="msg2"]').count(), 1)
      if (mode === 'following') {
        await page.waitForFunction(() => !document.querySelector('[data-confirmation] [data-dialog-footer] button:last-child')?.disabled)
        await shot('final-scope')
      }
      await button(dlg, /永久删除/).click()
      await dlg.waitFor({ state: 'hidden' })
      await page.locator('[data-message-id="msg2"]').waitFor({ state: 'detached' })
      assert(await page.locator('[data-message-id="msg1"]').isVisible(), 'Previous messages preserved')
      if (mode === 'single') await page.locator('[data-message-id="msg3"]').waitFor()
      else assert.equal(await page.locator('[data-message-id="msg3"]').count(), 0)
      await page.waitForFunction(async scope => {
        const db = await new Promise((ok, fail) => {
          const open = indexedDB.open('chat-demo')
          open.onsuccess = () => ok(open.result)
          open.onerror = () => fail(open.error)
        })
        try {
          const stored = await new Promise((ok, fail) => {
            const get = db.transaction('sessions').objectStore('sessions').get(scope)
            get.onsuccess = () => ok(get.result)
            get.onerror = () => fail(get.error)
          })
          const remaining = stored.messages.map(message => message.id)
          return !remaining.includes('msg2') && ['msg0','msg1'].every(id => remaining.includes(id)) && ['msg3','msg4'].every(id => remaining.includes(id) === (scope === 'single'))
        } finally { db.close() }
      }, mode)
      rec.scopes.push(mode)
    }
    assert.deepEqual(errors, [])
    rec.safeFocusAtEachStep = true
    rec.canceledSafely = true
    rec.correctRangeApplied = true
  } catch (error) {
    await writeFile(resolve(out, `${prefix}-failure.txt`), `${error}\n${await page.locator('body').innerText().catch(() => '')}`)
    await page.screenshot({ path: resolve(out, `${prefix}-failure.png`) }).catch(() => {})
    throw error
  } finally { await ctx.close() }
}
try {
  for (const v of [{ width: 390, theme: 'light', reduced: false }, { width: 320, theme: 'dark', reduced: true }]) await verify(v)
} finally {
  await writeFile(resolve(out, 'results.json'), JSON.stringify(results, null, 2))
  await browser.close()
}
