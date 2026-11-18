// Requires the isolated validation APK and the synthetic fixture from verify-large-import.mjs.
// Put the fixture in Downloads under the exact name below, then start the validation activity.
import { chromium } from 'playwright'
import { execFile } from 'node:child_process'
import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createServer } from 'node:http'
import { promisify } from 'node:util'

const run = promisify(execFile)
const adb = (...args) => run(process.env.ADB ?? '/Users/lizhongzhou/Library/Android/sdk/platform-tools/adb', ['-s', process.env.ANDROID_SERIAL ?? 'emulator-5554', ...args])
const pkg = 'ai.deepseek.demo.shell.validation'
const filename = 'deepchat-validation-75m-nov18.zip'
const pid = (await adb('shell', 'pidof', '-s', pkg)).stdout.trim()
assert.match(pid, /^\d+$/)
const port = (await adb('forward', 'tcp:0', `localabstract:webview_devtools_remote_${pid}`)).stdout.trim()
assert.match(port, /^\d+$/)
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
let fixtureServer
let fixturePort
try {
  const page = browser.contexts()[0].pages()[0]
  page.setDefaultTimeout(20000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.evaluate(() => { localStorage.setItem('chat-demo:locale', 'zh-CN'); localStorage.setItem('chat-demo:api-key', 'synthetic-test-only') })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: '打开边栏', exact: true }).click()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByText('数据管理', { exact: true }).click()
  if (process.argv.includes('--link')) {
    const zip = process.env.FIXTURE_ZIP
    const { size } = await stat(zip)
    fixtureServer = createServer((req, res) => {
      if (req.url !== '/fixture.zip') { res.writeHead(404).end(); return }
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': size })
      createReadStream(zip).pipe(res)
    })
    await new Promise(resolve => fixtureServer.listen(0, '127.0.0.1', resolve))
    fixturePort = fixtureServer.address().port
    await adb('reverse', `tcp:${fixturePort}`, `tcp:${fixturePort}`)
    await page.locator('input[inputmode="url"]').fill(`http://127.0.0.1:${fixturePort}/fixture.zip`)
    await page.getByRole('button', { name: /下载并导入/ }).click()
    await page.locator('[data-import-stage="downloading"] [role="progressbar"], [data-import-stage="downloading"] progress').first().waitFor()
  } else {
    if (process.argv.includes('--measure-read')) {
      await page.evaluate(() => document.addEventListener('change', e => { if (e.target.files?.[0]) window.syntheticTimingFile = e.target.files[0] }, true))
    }
    await page.getByRole('button', { name: /导入历史对话/ }).click()
    // Use the Android document picker, so reading exercises the real content URI.
    const dump = async () => (await adb('exec-out', 'uiautomator', 'dump', '/dev/tty')).stdout
    const tap = async (predicate, hierarchy) => {
      const node = (hierarchy.match(/<node\b[^>]*>/g) ?? []).find(predicate)
      if (!node) return false
      const [, x1, y1, x2, y2] = node.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/)
      await adb('shell', 'input', 'tap', String((+x1 + +x2) >> 1), String((+y1 + +y2) >> 1))
      return true
    }
    let picked = false
    for (let i = 0; i < 5 && !picked; i++) {
      const tree = await dump()
      picked = await tap(n => n.includes(filename), tree)
      if (picked) break
      if (!await tap(n => /text="(Downloads|下载)"/.test(n), tree)) {
        await tap(n => /content-desc="(Show roots|Open navigation drawer|显示根目录|打开导航抽屉)"/.test(n), tree)
      }
    }
    assert.ok(picked, 'find synthetic ZIP in Android document picker')
  }
  const confirm = page.getByRole('button', { name: '确认导入', exact: true })
  await confirm.waitFor()
  if (process.argv.includes('--measure-read')) {
    console.log(await page.evaluate(async () => {
      const file = window.syntheticTimingFile
      const timing = async f => {
        const t = performance.now()
        for (let i = 0; i < 12; i++) await f.slice(Math.floor(i * f.size / 12), Math.floor(i * f.size / 12) + 100).arrayBuffer()
        return Math.round(performance.now() - t)
      }
      const raw = await timing(file), start = performance.now()
      const copy = await new Response(file.stream()).blob()
      return { raw, copy: Math.round(performance.now() - start), cached: await timing(copy), size: copy.size }
    }))
  }
  await page.evaluate(() => {
    window.syntheticAborts = []
    const transaction = IDBDatabase.prototype.transaction
    IDBDatabase.prototype.transaction = function (...args) {
      const tx = transaction.apply(this, args)
      tx.addEventListener('abort', () => window.syntheticAborts.push({ db: this.name, stores: [...tx.objectStoreNames], cause: String(tx.error) }))
      return tx
    }
  })
  const abort = process.argv.includes('--abort')
  await page.evaluate(abort => {
    window.testProgress = { events: [], portions: [] }
    const observer = new MutationObserver(() => {
      for (const el of document.querySelectorAll('progress, [role="progressbar"]')) {
        const stage = el.closest('[data-import-stage]')?.dataset.importStage || el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || 'progress'
        if (!window.testProgress.events.includes(stage)) window.testProgress.events.push(stage)
        const value = el.getAttribute('value') ?? el.getAttribute('aria-valuenow')
        if (value !== null && Number(value) > 0 && window.testProgress.portions.length < 8) window.testProgress.portions.push(value)
      }
    })
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true })
    if (abort) {
      const put = IDBObjectStore.prototype.put
      IDBObjectStore.prototype.put = function (...args) {
        if (this.name === 'historyMeta' && args[1] === 'active') throw new DOMException('Validation quota injection', 'QuotaExceededError')
        return put.apply(this, args)
      }
    }
  }, abort)
  const started = Date.now()
  await confirm.click()
  if (process.argv.includes('--baseline')) {
    const failure = page.getByText(/^导入失败/)
    await failure.waitFor()
    console.log(JSON.stringify({ failure: await failure.textContent(), elapsedMs: Date.now() - started, errors }))
  } else {
    await page.waitForFunction(() => /已导入 32 个对话/.test(document.body.innerText) || document.querySelector('[role="alert"]')?.textContent?.trim() || /^导入失败/m.test(document.body.innerText), undefined, { timeout: 180000 })
    const elapsedMs = Date.now() - started
    if (process.env.UI_SCREENSHOT) await page.locator('[data-import-state]').last().screenshot({path: process.env.UI_SCREENSHOT})
    const failure = await page.locator('[data-import-state="failed"]').allTextContents()
    const status = await page.evaluate(() => ({ progress: window.testProgress, aborts: window.syntheticAborts }))
    if (!process.argv.includes('--core')) assert.ok(status.progress.events.length && status.progress.portions.length, JSON.stringify(status))
    if (abort) {
      assert.match(failure.join(' '), /空间|存储/)
      assert.match(failure.join(' '), /写入|保存|提交|替换/)
    } else {
      assert.equal(failure.join('').trim(), '', JSON.stringify({ failure, ...status }))
      await page.getByText('已导入 32 个对话', { exact: true }).waitFor()
    }
    const expected = JSON.parse(await readFile(process.env.FIXTURE_MANIFEST, 'utf8'))
    const dbState = await page.evaluate(async expected => {
      const req = request => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
      const db = await req(indexedDB.open('chat-demo'))
      const read = (name, fn) => req(fn(db.transaction(name).objectStore(name)))
      const active = await read('historyMeta', store => store.get('active'))
      const current = name => name + (active ? 'Staging' : '')
      const inactive = name => name + (active ? '' : 'Staging')
      const hash = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2,'0')).join('')
      let messages = 0, files = 0
      for (const target of expected.sessions) {
        const { messages: rows } = await read(current('sessions'), store => store.get(target.id))
        const texts = rows.map(m => m.role === 'user' ? m.content : m.blocks[0].text)
        if (await hash(new TextEncoder().encode(JSON.stringify(texts))) !== target.textHash) throw Error('text hash mismatch ' + target.id)
        messages += rows.length
      }
      for (const target of expected.files) {
        const { blob } = await read(current('files'), store => store.get(target.id))
        if (await hash(await blob.arrayBuffer()) !== target.sha256) throw Error('image hash mismatch ' + target.id)
        files++
      }
      const staged = await read(inactive('sessions'), s => s.count()) + await read(inactive('files'), s => s.count())
      db.close()
      return { messages, files, staged }
    }, expected)
    assert.deepEqual(dbState, { messages: 2080, files: 10, staged: 0 })
    console.log(JSON.stringify({ elapsedMs, ...dbState, errors, ...status, failure }))
  }
  assert.deepEqual(errors, [])
} finally {
  if (fixturePort) await adb('reverse', '--remove', `tcp:${fixturePort}`)
  fixtureServer?.close()
  await browser.close()
  await adb('forward', '--remove', `tcp:${port}`)
}
