import { chromium } from 'playwright'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFile } from 'node:fs/promises'

const run = promisify(execFile)
const adb = process.env.ADB ?? '/Users/lizhongzhou/Library/Android/sdk/platform-tools/adb'
const serial = process.env.ANDROID_SERIAL ?? 'emulator-5554'
const packageId = 'ai.deepseek.demo.shell.validation'
const output = new URL('../artifacts/feature-validation/', import.meta.url)
const android = (...args) => run(adb, ['-s', serial, ...args])
const connect = async () => {
  const { stdout } = await android('shell', 'pidof', '-s', packageId)
  const pid = stdout.trim()
  assert.match(pid, /^\d+$/)
  await android('forward', 'tcp:9225', `localabstract:webview_devtools_remote_${pid}`)
  return chromium.connectOverCDP('http://127.0.0.1:9225')
}
const report = { packageId, checks: [], pageErrors: [], blockedRequests: [] }
const check = (condition, label) => { assert.ok(condition, label); report.checks.push(label) }
let browser
try {
  browser = await connect()
  const context = browser.contexts()[0]
  await context.route('**/*', (route) => {
    if (new URL(route.request().url()).hostname === 'localhost') return route.continue()
    report.blockedRequests.push(route.request().url())
    return route.abort()
  })
  let page = context.pages()[0]
  page.on('pageerror', (error) => report.pageErrors.push(error.message))
  page.setDefaultTimeout(8000)
  await page.waitForFunction(() => !!window.AndroidUpdater)
  await page.evaluate(async () => {
    localStorage.setItem('chat-demo:api-key', 'synthetic-native-key-never-use')
    localStorage.setItem('chat-demo:locale', 'zh-CN')
    localStorage.setItem('chat-demo:theme-preference', 'light')
    const now = Date.now()
    const common = (id, parentId, selectedChildId) => ({ id, parentId, selectedChildId, createdAt: now })
    const session = {
      id: 'native-validation', title: '原生回归 · 合成数据', createdAt: now, updatedAt: now, rootMessageId: 'native-u1',
      messages: [
        { ...common('native-u1', null, 'native-a1'), role: 'user', content: '第一轮合成提问', files: [] },
        { ...common('native-a1', 'native-u1', 'native-u2'), role: 'assistant', status: 'done', blocks: [{ type: 'text', text: '这是原生测试锚点，检查搜索定位、返回键和删除确认。' }] },
        { ...common('native-u2', 'native-a1', 'native-a2'), role: 'user', content: '保留原生后续提问', files: [] },
        { ...common('native-a2', 'native-u2', undefined), role: 'assistant', status: 'done', blocks: [{ type: 'text', text: '这是必须保留的后续回答。' }] },
      ],
    }
    const db = await new Promise((resolve, reject) => { const request = indexedDB.open('chat-demo'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
    await new Promise((resolve, reject) => {
      const tx = db.transaction(['sessions', 'sessionSummaries'], 'readwrite')
      tx.objectStore('sessions').put(session)
      tx.objectStore('sessionSummaries').put({ id: session.id, title: session.title, createdAt: now, updatedAt: now, fileIds: [] })
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error)
    })
    db.close()
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: '打开边栏', exact: true }).click()
  await page.getByRole('button', { name: '搜索历史对话', exact: true }).click()
  const search = page.getByRole('dialog', { name: '搜索历史对话' })
  await search.getByRole('searchbox').fill('原生测试锚点')
  await search.getByRole('button').filter({ hasText: '原生测试锚点' }).click()
  await page.locator('[data-message-id="native-a1"]').waitFor()
  check(await page.locator('[data-search-location-label]').count() === 1, 'packaged WebView search locates and highlights a message')
  const bridge = await page.evaluate(() => ({
    download: typeof window.AndroidUpdater.installApkWithFallback,
    install: typeof window.AndroidUpdater.installDownloadedApk,
    ready: typeof window.AndroidUpdater.isDownloadedUpdateReady,
    guard: typeof window.__deepchatCanInstallUpdate,
  }))
  check(Object.values(bridge).every((value) => value === 'function'), 'packaged native bridge exposes separate download, install and final safety check')
  const target = page.locator('[data-message-id="native-u2"]')
  await target.scrollIntoViewIfNeeded()
  await target.getByRole('button', { name: '删除消息', exact: true }).click()
  const deletion = page.getByRole('dialog', { name: /^删除消息/ })
  await deletion.getByRole('radio', { name: /^包括后面的所有消息/ }).check()
  await deletion.getByRole('button', { name: '确认范围（1/3）', exact: true }).click()
  await deletion.getByRole('button', { name: '确认消息（2/3）', exact: true }).click()
  await page.screenshot({ path: new URL('android-delete-third.png', output).pathname })
  await android('shell', 'input', 'keyevent', '4')
  await deletion.waitFor({ state: 'detached' })
  check(await page.locator('[data-message-id]').count() === 4, 'Android Back cancels third confirmation without deleting any message')
  const input = page.locator('textarea').first()
  await input.fill('Native persistent draft')
  await input.click()
  await page.waitForFunction(() => visualViewport.height < 650)
  const layout = await input.evaluate((element) => ({ top: element.getBoundingClientRect().top, bottom: element.getBoundingClientRect().bottom, viewport: visualViewport.height }))
  check(layout.top >= 0 && layout.bottom <= layout.viewport + 1, 'composer remains visible above the Android keyboard')
  check(await page.evaluate(() => !window.__deepchatCanInstallUpdate()), 'native final safety callback refuses installation while a draft exists')
  await page.screenshot({ path: new URL('android-keyboard-draft.png', output).pathname })
  await android('shell', 'input', 'keyevent', '4')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: '打开边栏', exact: true }).click()
  await page.getByText('原生回归 · 合成数据', { exact: true }).click()
  await page.locator('textarea').first().waitFor()
  check(await page.locator('textarea').first().inputValue() === 'Native persistent draft', 'packaged WebView reload restores the unsent draft')
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)
  check(overflow, 'packaged phone layout has no document horizontal overflow')
  await page.screenshot({ path: new URL('android-restored-draft.png', output).pathname })
  assert.deepEqual(report.pageErrors, [])
  report.passed = report.checks.length
  await writeFile(new URL('android-results.json', output), JSON.stringify(report, null, 2) + '\n')
  process.stdout.write(JSON.stringify(report, null, 2) + '\n')
} finally {
  if (browser) await browser.close()
}
