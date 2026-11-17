// Run against the lead-managed preview: node src/services/backup/verify-ui.mjs
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chromium } from '../../../../tools/node_modules/playwright/index.mjs'
const artifacts = await mkdtemp(path.join(tmpdir(), 'deepchat-backup-ui-'))
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' })
const results = []
try {
  for (const device of [
    { name: 'phone', width: 390, height: 844, touch: true },
    { name: 'tablet', width: 820, height: 1180, touch: true },
    { name: 'desktop', width: 1280, height: 900, touch: false },
  ]) {
    const context = await browser.newContext({ viewport: { width: device.width, height: device.height }, hasTouch: device.touch, isMobile: device.touch, locale: 'zh-CN', acceptDownloads: true })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.addInitScript(() => { localStorage.setItem('chat-demo:locale', 'zh-CN'); localStorage.setItem('chat-demo:api-key', 'local-test-key') })
    await page.goto(process.env.PREVIEW_URL ?? 'http://127.0.0.1:8090')
    await page.waitForFunction(async () => (await indexedDB.databases()).some((db) => db.name === 'chat-demo'))
    await page.evaluate(async () => {
      const db = await new Promise((resolve, reject) => { const request = indexedDB.open('chat-demo'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
      const tx = db.transaction(['sessions', 'sessionSummaries'], 'readwrite')
      const summary = { id: 'ui-fixture', title: '备份验证对话', createdAt: 1700000000000, updatedAt: 1700000000001 }
      tx.objectStore('sessions').put({ ...summary, rootMessageId: 'u', messages: [{ id: 'u', role: 'user', content: '需要完整保留的原文', files: [], createdAt: 1700000000000, parentId: null }] })
      tx.objectStore('sessionSummaries').put({ ...summary, fileIds: [] })
      await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error) })
      db.close()
    })
    await page.reload()
    if (device.width < 768) { await page.getByRole('button', { name: '打开边栏', exact: true }).click() }
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole(device.touch ? 'button' : 'tab', { name: '数据管理', exact: true }).click()
    const section = page.locator('section[aria-label="历史备份"]')
    await section.getByRole('button', { name: '生成备份', exact: true }).click()
    await section.getByText('已生成，尚未确认保存', { exact: true }).waitFor()
    const downloadEvent = page.waitForEvent('download')
    await section.getByRole('button', { name: '保存 / 分享', exact: true }).click()
    const download = await downloadEvent
    assert.match(download.suggestedFilename(), /^deepseek_data-.+\.zip$/)
    await section.getByText('已交给浏览器下载，请检查下载文件', { exact: true }).waitFor()
    await section.getByRole('button', { name: '我已找到保存的文件', exact: true }).click()
    await section.getByText('已由你确认保存', { exact: true }).waitFor()
    await section.getByRole('checkbox').uncheck()
    assert.equal(await section.getByRole('checkbox').isChecked(), false)
    await section.getByRole('checkbox').check()
    await section.locator('h3').first().scrollIntoViewIfNeeded()
    const bounds = await section.boundingBox()
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= device.width + 1, `${device.name} section fits viewport`)
    const controls = await section.locator('button').evaluateAll((buttons) => buttons.map((button) => ({ text: button.textContent, height: button.getBoundingClientRect().height, left: button.getBoundingClientRect().left, right: button.getBoundingClientRect().right })))
    assert.ok(controls.every((button) => button.height >= 44 && button.left >= 0 && button.right <= device.width + 1), `${device.name} controls have touch size and fit`)
    await page.screenshot({ path: path.join(artifacts, `${device.name}.png`) })
    assert.deepEqual(errors, [], `${device.name} has no runtime errors`)
    results.push({ device: device.name, generated: true, downloaded: true, manuallyConfirmed: true, autoToggle: true, bounds, screenshot: path.join(artifacts, `${device.name}.png`) })
    await context.close()
  }
  process.stdout.write(JSON.stringify({ results, artifacts }, null, 2) + '\n')
} finally {
  await browser.close()
}
