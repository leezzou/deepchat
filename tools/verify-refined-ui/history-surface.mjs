// Verify the production history surfaces under long-list scrolling and route transitions.
import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { chromium } from 'playwright'

const [assets, output] = process.argv.slice(2)
assert(assets && output, 'Pass an extracted assets/public directory and an output directory')
await mkdir(output, { recursive: true })
const root = resolve(assets)
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' })
const result = []
try {
  for (const dark of [false, true]) {
    const theme = dark ? 'dark' : 'light'
    const ink = dark ? 'rgb(15, 15, 15)' : 'rgb(255, 255, 255)'
    const ctx = await browser.newContext({ viewport: { width: dark ? 320 : 390, height: 780 }, hasTouch: true, isMobile: true, locale: 'zh-CN', colorScheme: theme })
    const page = await ctx.newPage()
    const errors = []
    page.on('pageerror', e => errors.push(e.message))
    await page.route('**/*', async r => {
      const url = new URL(r.request().url())
      if (url.origin !== 'https://local3.test') return r.abort()
      const path = resolve(root, '.' + (url.pathname === '/' ? '/index.html' : url.pathname))
      assert(path.startsWith(root + sep))
      try {
        const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' }
        await r.fulfill({ body: await readFile(path), contentType: types[extname(path)] || 'application/octet-stream' })
      } catch { await r.fulfill({ status: 404 }) }
    })
    await page.addInitScript(theme => {
      localStorage.setItem('chat-demo:theme-preference', theme)
      localStorage.setItem('chat-demo:locale', 'zh-CN')
      window.recordedOps = []
      window.DshNative = { postMessage(raw) { const data = JSON.parse(raw); window.recordedOps.push(data.op) } }
    }, theme)
    await page.goto('https://local3.test')
    await page.getByRole('button', { name: '打开边栏', exact: true }).waitFor()
    await page.waitForFunction(async () => (await indexedDB.databases()).some(db => db.name === 'chat-demo' && db.version >= 12))
    await page.evaluate(async () => {
      const db = await new Promise(resolve => { const req = indexedDB.open('chat-demo'); req.onsuccess = () => resolve(req.result) })
      const tx = db.transaction(['sessionSummaries', 'sessions'], 'readwrite')
      for (let i = 0; i < 60; i++) {
        const at = Date.now() - Math.floor(i / 20) * 86400000 - i * 1000
        const item = { id: 'history-' + i, title: ['行程记录', '购物清单', '读书笔记'][i % 3] + ' ' + (i + 1), createdAt: at, updatedAt: at, fileIds: [] }
        tx.objectStore('sessionSummaries').put(item)
        tx.objectStore('sessions').put({ ...item, messages: [] })
      }
      await new Promise((ok, fail) => { tx.oncomplete = ok; tx.onerror = fail }); db.close()
    })
    await page.reload()
    await page.getByRole('button', { name: '打开边栏', exact: true }).click()
    const drawer = page.getByRole('dialog').first()
    const footer = drawer.getByRole('button', { name: /DeepSeek 账号/ })
    await footer.click()
    assert.equal(await page.evaluate(() => window.recordedOps.filter(op => op === 'account').length), 1)
    assert.equal(await page.locator('[data-settings-shell]').count(), 0)
    const list = drawer.locator('h3').first().locator('../..')
    const surfaces = await list.evaluate(el => {
      el.scrollTop = 500
      return { scrollTop: el.scrollTop, list: getComputedStyle(el).backgroundColor, section: getComputedStyle(el.querySelector('h3')).backgroundColor, panel: getComputedStyle(el.parentElement.parentElement).backgroundColor, listBottom: el.getBoundingClientRect().bottom, footerTop: el.parentElement.nextElementSibling.getBoundingClientRect().top }
    })
    assert(surfaces.scrollTop > 400)
    for (const slot of ['list', 'section', 'panel']) assert.equal(surfaces[slot], ink)
    assert(surfaces.listBottom <= surfaces.footerTop + 1)
    await page.screenshot({ path: resolve(output, `history-${theme}.png`) })
    await drawer.getByRole('button', { name: /搜索历史对话/ }).click()
    const search = page.locator('dialog[open]').last()
    const style = await search.evaluate(el => ({ bg: getComputedStyle(el).backgroundColor, opacity: getComputedStyle(el).opacity, frames: el.getAnimations().flatMap(a => a.effect.getKeyframes().map(f => f.opacity ?? 1)) }))
    assert.equal(style.bg, ink)
    assert.equal(style.opacity, '1')
    assert(style.frames.every(a => Number(a) === 1))
    await page.keyboard.press('Escape')
    await search.waitFor({ state: 'detached' })
    await drawer.getByRole('button', { name: '设置', exact: true }).click()
    await page.locator('[data-settings-shell]').waitFor()
    assert.deepEqual(errors, [])
    result.push({ theme, surfaces, search: style, accountAndSettingsSeparate: true })
    await ctx.close()
  }
  await writeFile(resolve(output,'history-checks.json'),JSON.stringify(result,null,2))
} finally { await browser.close() }
