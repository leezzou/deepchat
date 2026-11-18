// node tools/verify-motion-ui.mjs <temporary production assets> [--baseline]
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, resolve, sep } from 'node:path'
import { chromium } from 'playwright'

assert.ok(process.argv[2], 'Supply the directory of an isolated rspack --output-path build')
const assets = resolve(process.argv[2])
const baseline = process.argv.includes('--baseline')
const chunks = Array.from({ length: 30 }, (_, i) => `Part ${i + 1} of the measured reply. `)
let responseGate
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  if (url.pathname === '/chat/completions' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    res.flushHeaders()
    await responseGate
    let i = 0
    const timer = setInterval(() => {
      const chunk = chunks[i++]
      if (!chunk) {
        clearInterval(timer)
        res.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      } else {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`)
      }
    }, 50)
    res.on('close', () => clearInterval(timer))
    return
  }
  const file = resolve(assets, '.' + (url.pathname === '/' ? '/index.html' : url.pathname))
  try {
    if (!file.startsWith(assets + sep)) throw new Error('outside assets')
    const body = await readFile(file)
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png' }
    res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' }).end(body)
  } catch {
    res.writeHead(404).end()
  }
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const origin = `http://127.0.0.1:${server.address().port}`
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_EXECUTABLE_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' })
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, locale: 'en-US' })
  await context.route('**/*', (route) => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
  await context.addInitScript(() => {
    const profile = { id: 'local', name: 'Local fixture', protocol: 'openai', origin: location.origin, model: 'fixture', apiKey: 'local-synthetic-fixture' }
    localStorage.setItem('chat-demo:api-profiles', JSON.stringify([profile]))
    localStorage.setItem('chat-demo:active-profile', 'local')
    localStorage.setItem('chat-demo:locale', 'zh-CN')
    window.counts = {}
    const count = (name) => { window.counts[name] = (window.counts[name] ?? 0) + 1 }
    const originalStyle = window.getComputedStyle
    window.getComputedStyle = function (...args) {
      if (window.event?.type === 'touchmove') count('touchmoveStyleReads')
      return originalStyle.apply(this, args)
    }
    const originalSet = Map.prototype.set
    Map.prototype.set = function (key, value) {
      if (typeof key === 'string' && key.startsWith('bench-msg-')) count('historyMapWrites')
      return originalSet.call(this, key, value)
    }
    const top = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')
    Object.defineProperty(Element.prototype, 'scrollTop', { ...top, set(value) {
      if (this.matches('[class^="scroll-"]')) count('chatScrollTopWrites')
      top.set.call(this, value)
    } })
    for (const field of ['scrollHeight', 'clientHeight', 'scrollWidth', 'clientWidth']) {
      const original = Object.getOwnPropertyDescriptor(Element.prototype, field)
      Object.defineProperty(Element.prototype, field, { ...original, get() {
        if (window.event?.type === 'touchmove') count('touchmoveSizeReads')
        return original.get.call(this)
      } })
    }
  })
  const page = await context.newPage()
  page.setDefaultTimeout(7000)
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  const cdp = await context.newCDPSession(page)
  await cdp.send('Performance.enable')
  const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(({ name, value }) => [name, value]))
  const measure = async (action) => {
    await page.evaluate(() => { window.counts = {} })
    const start = await metrics()
    await action()
    const end = await metrics()
    return { ...(await page.evaluate(() => window.counts)), layouts: end.LayoutCount - start.LayoutCount, recalcs: end.RecalcStyleCount - start.RecalcStyleCount }
  }
  const touch = async (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: x === undefined ? [] : [{ id: 1, x, y }] })
  async function swipe(fromX, fromY, toX, toY, moves = 24) {
    await touch('touchStart', fromX, fromY)
    for (let i = 1; i <= moves; i++) await touch('touchMove', fromX + (toX - fromX) * i / moves, fromY + (toY - fromY) * i / moves)
    await touch('touchEnd')
    await page.waitForTimeout(320)
  }
  const drawer = page.locator('[class^="drawer-"]')
  const opener = page.getByRole('button', { name: '打开边栏', exact: true })
  const state = () => drawer.evaluate((el) => ({ hidden: el.getAttribute('aria-hidden'), visibility: getComputedStyle(el).visibility, transform: getComputedStyle(el).transform }))
  const scroll = page.locator('[class^="scroll-"]').first()
  await page.goto(origin)
  await opener.waitFor()
  await page.evaluate(async () => {
    const db = await new Promise((done, fail) => { const request = indexedDB.open('chat-demo'); request.onsuccess = () => done(request.result); request.onerror = fail })
    const tx = db.transaction(['sessions', 'sessionSummaries'], 'readwrite')
    for (const [id, rounds] of [['short', 1], ['long', 80]]) {
      const messages = Array.from({ length: rounds * 2 }, (_, n) => {
        const common = { id: `bench-msg-${id}-${n}`, parentId: n ? `bench-msg-${id}-${n - 1}` : null, selectedChildId: n < rounds * 2 - 1 ? `bench-msg-${id}-${n + 1}` : undefined, createdAt: n + 1 }
        return n % 2 ? { ...common, role: 'assistant', status: 'done', model: 'fixture', prefix: false, blocks: [{ type: 'text', text: `## Reply ${n}\n\nA **formatted** answer with inline \`code\` and a second paragraph.\n\nReading the transcript should preserve its position.` }] } : { ...common, role: 'user', content: `Question ${n}`, files: [] }
      })
      const summary = { id, title: `Fixture ${id}`, createdAt: 1, updatedAt: 1000, fileIds: [] }
      tx.objectStore('sessionSummaries').put(summary)
      tx.objectStore('sessions').put({ ...summary, rootMessageId: messages[0].id, messages })
    }
    await new Promise((done, fail) => { tx.oncomplete = done; tx.onerror = fail })
    db.close()
  })
  await page.reload()
  await opener.click()
  await page.getByText('Fixture short', { exact: true }).click()
  await page.locator('[data-message-id="bench-msg-short-1"]').waitFor()
  await opener.click()
  const openChat = await measure(async () => {
    await page.getByText('Fixture long', { exact: true }).click()
    await page.locator('[data-message-id="bench-msg-long-159"]').waitFor()
    await page.waitForTimeout(400)
  })
  const drawerDrag = await measure(async () => {
    await swipe(35, 340, 240, 344)
    assert.equal((await state()).hidden, 'false')
    await swipe(245, 340, 40, 343)
    assert.equal((await state()).hidden, 'true')
  })
  if (!baseline) {
    assert.equal(drawerDrag.touchmoveStyleReads ?? 0, 0)
    assert.equal(drawerDrag.touchmoveSizeReads ?? 0, 0)
    assert.equal(drawerDrag.historyMapWrites ?? 0, 0)
  }
  // Keep one trusted touch down through the transition. Late moves must not toggle it twice.
  await touch('touchStart', 30, 340)
  await touch('touchMove', 100, 340)
  await page.waitForTimeout(85)
  const opening = await state()
  assert.equal(opening.hidden, 'false')
  await touch('touchMove', 37, 340)
  await page.waitForTimeout(250)
  const openHeld = await state()
  await touch('touchEnd')
  assert.equal(openHeld.hidden, 'false')
  await touch('touchStart', 245, 340)
  await touch('touchMove', 165, 340)
  await page.waitForTimeout(70)
  const closing = await state()
  assert.equal(closing.hidden, 'true')
  if (!baseline) assert.equal(await drawer.evaluate((el) => el.inert), true)
  await touch('touchMove', 226, 340)
  await touch('touchEnd')
  await page.waitForTimeout(280)
  const closed = await state()
  assert.equal(closed.visibility, 'hidden')
  const touchStates = { opening, openHeld, closing, closed }
  const beforeScroll = await scroll.evaluate((el) => el.scrollTop)
  const readHistory = await measure(() => swipe(160, 250, 162, 535))
  assert.ok(await scroll.evaluate((el, before) => el.scrollTop < before, beforeScroll))
  assert.equal((await state()).hidden, 'true')
  const composer = page.locator('textarea').first()
  await composer.fill('Measure streaming')
  const streaming = await measure(async () => {
    await composer.press('Enter')
    await page.waitForFunction((final) => document.querySelector('[data-message-id]:last-child .ds-assistant-message-main-content')?.textContent.trim() === final.trim(), chunks.join(''))
    await page.locator('[data-message-id]:last-child [aria-label="删除消息"]').waitFor()
  })
  const bottomGap = await scroll.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop)
  assert.ok(bottomGap < 2, `Chat follow gap ${bottomGap}`)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await opener.focus(); await page.keyboard.press('Enter')
  const reduced = await drawer.evaluate((el) => getComputedStyle(el).transitionDuration)
  if (!baseline) {
    assert.equal(reduced, '0s')
    assert.ok(await drawer.evaluate((el) => el.contains(document.activeElement)))
    await page.keyboard.press('Shift+Tab')
    assert.ok(await drawer.evaluate((el) => document.activeElement === [...el.querySelectorAll('button')].at(-1)))
    await page.keyboard.press('Tab')
    assert.ok(await drawer.evaluate((el) => document.activeElement === el.querySelector('button')))
  }
  await page.keyboard.press('Escape')
  await page.waitForTimeout(320)
  assert.equal((await state()).hidden, 'true')
  if (!baseline) {
    assert.ok(await opener.evaluate((el) => document.activeElement === el))
    await page.evaluate(() => { document.documentElement.dir = 'rtl' })
    await swipe(360, 340, 185, 342)
    assert.equal((await state()).hidden, 'false')
    const rect = await drawer.boundingBox()
    assert.ok(rect && Math.abs(rect.x + rect.width - 390) < 1, JSON.stringify(await drawer.evaluate((el) => ({ rect: el.getBoundingClientRect().toJSON(), frame: el.parentElement.getBoundingClientRect().toJSON(), direction: getComputedStyle(el).direction, left: getComputedStyle(el).left, right: getComputedStyle(el).right, rules: [...document.styleSheets].flatMap((s) => [...s.cssRules]).filter((r) => r.selectorText && el.matches(r.selectorText)).map((r) => r.cssText) }))))
    await swipe(180, 340, 350, 342)
    assert.equal((await state()).hidden, 'true')
    await page.evaluate(() => { document.documentElement.removeAttribute('dir') })
  }
  await composer.focus()
  await page.setViewportSize({ width: 390, height: 510 })
  await page.waitForTimeout(90)
  const keyboard = await composer.evaluate((el) => ({ focused: document.activeElement === el, composerBottom: el.getBoundingClientRect().bottom, visibleHeight: visualViewport.height }))
  assert.ok(keyboard.focused && keyboard.composerBottom <= keyboard.visibleHeight)
  let thinkingPaint
  if (process.argv.includes('--paint')) {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.getByRole('button', { name: '深度思考', exact: true }).click()
    let resume
    responseGate = new Promise((done) => { resume = done })
    try {
      await composer.fill('Measure visible thinking status')
      await composer.press('Enter')
      const label = page.locator('[data-message-id]:last-child [class*="shimmer-"]')
      await label.waitFor()
      await page.waitForTimeout(350)
      await cdp.send('Tracing.start', { categories: 'devtools.timeline', transferMode: 'ReportEvents' })
      const paints = []
      cdp.on('Tracing.dataCollected', ({ value }) => paints.push(...value.filter((e) => e.name === 'Paint' && e.ph === 'X')))
      await page.waitForTimeout(800)
      const traced = new Promise((done) => cdp.once('Tracing.tracingComplete', done))
      await cdp.send('Tracing.end')
      await traced
      await page.emulateMedia({ reducedMotion: 'reduce' })
      const animation = await label.evaluate((el) => getComputedStyle(el).animationName)
      if (!baseline) assert.equal(animation, 'none')
      thinkingPaint = { traceWindowMs: 800, paintEvents: paints.length, reducedAnimation: animation }
    } finally { resume() }
    // Let the user read earlier messages during streaming without being pulled back down.
    await swipe(146, 250, 148, 565)
    const held = await scroll.evaluate((el) => el.scrollTop)
    await page.waitForFunction((final) => document.querySelector('[data-message-id]:last-child .ds-assistant-message-main-content')?.textContent.trim() === final.trim(), chunks.join(''))
    assert.ok(await scroll.evaluate((el, held) => el.scrollTop <= held + 2 && el.scrollHeight - el.clientHeight - el.scrollTop > 40, held))
  }
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ browser: browser.version(), rounds: 80, drawerMovesEachDirection: 24, streamChunks: chunks.length, openChat, drawerDrag, readHistory, streaming, bottomGap, touchStates, reducedDrawerDuration: reduced, keyboard, errors }, null, 2))
} finally {
  await browser.close()
  server.closeAllConnections()
  await new Promise((done) => server.close(done))
}
