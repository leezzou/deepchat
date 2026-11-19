// Run against the frozen production dist or an APK's extracted assets/public directory.
// node tools/verify-refined-ui/folder-sharing.mjs <assets-directory> <evidence-directory>
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { chromium } from 'playwright'

const [assetDir, evidenceDir] = process.argv.slice(2)
assert(assetDir && evidenceDir, 'Pass a frozen asset directory and an evidence directory')
const root = resolve(assetDir)
const out = resolve(evidenceDir)
await mkdir(out, { recursive: true })
const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' }
const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname
    const file = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname))
    assert(file.startsWith(root + sep))
    res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' }).end(await readFile(file))
  } catch {
    if (res.headersSent) res.destroy()
    else res.writeHead(404).end()
  }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' })
const evidence = { chromium: browser.version(), entrySha256: createHash('sha256').update(await readFile(resolve(root, 'index.html'))).digest('hex'), cases: [] }

// Observe actual CSS/WAAPI animations on mobile. Capture direction, keyframes and sampled transforms.
function instrument(theme) {
  localStorage.setItem('chat-demo:locale', 'zh-CN')
  localStorage.setItem('chat-demo:theme-preference', theme)
  if (!localStorage.getItem('chat-demo:active-profile')) {
    localStorage.setItem('chat-demo:api-profiles', JSON.stringify([{ id: 'study', name: '测试方案', apiKey: 'fixture-only', protocol: 'deepseek', origin: 'https://api.deepseek.com', model: 'deepseek-flash' }]))
    localStorage.setItem('chat-demo:active-profile', 'study')
  }
  window.motionFrames = []
  window.motionLabel = ''
  const seen = new WeakMap()
  function frame() {
    if (window.motionLabel) {
      for (const animation of document.getAnimations()) {
        const effect = animation.effect
        const target = effect?.target
        if (!(target instanceof Element) || !effect.getKeyframes) continue
        const keys = effect.getKeyframes().map(({ transform, translate, opacity }) => ({ transform, translate, opacity }))
        if (!keys.some(key => Object.values(key).some(value => value !== undefined))) continue
        let record = seen.get(animation)
        if (!record) {
          const dialog = target.closest('[role="dialog"]')
          record = { action: window.motionLabel, target: target.className?.toString(), surface: dialog?.getAttribute('aria-label') || '', duration: effect.getTiming().duration, keys, samples: [] }
          window.motionFrames.push(record)
          seen.set(animation, record)
        }
        record.samples.push({ ms: Math.round(Number(animation.currentTime) || 0), transform: getComputedStyle(target).transform })
      }
    }
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}

// Seed only chat history so move actions have existing conversations. Folder data always starts empty.
async function seedChats(page) {
  await page.waitForFunction(async () => (await indexedDB.databases()).some(row => row.name === 'chat-demo' && row.version >= 12))
  await page.evaluate(async () => {
    const db = await new Promise((ok, fail) => {
      const open = indexedDB.open('chat-demo')
      open.onsuccess = () => ok(open.result)
      open.onerror = () => fail(open.error)
    })
    const tx = db.transaction(['sessions', 'sessionSummaries'], 'readwrite')
    for (const [id, title] of [['project', '河西走廊行程'], ['standalone', '读书笔记']]) {
      const now = Date.now()
      const entry = { id, title, createdAt: now, updatedAt: now, fileIds: [] }
      tx.objectStore('sessionSummaries').put(entry)
      tx.objectStore('sessions').put({ ...entry, messages: [] })
    }
    await new Promise((ok, fail) => { tx.oncomplete = ok; tx.onerror = () => fail(tx.error) })
    db.close()
  })
  await page.reload()
}

async function verify(view) {
  const { width, theme, motion } = view
  const id = `${width}-${theme}-${motion}`
  const context = await browser.newContext({ viewport: { width, height: 780 }, isMobile: true, hasTouch: true, locale: 'zh-CN', colorScheme: theme, reducedMotion: motion, serviceWorkers: 'block' })
  const page = await context.newPage()
  page.setDefaultTimeout(6500)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
  await page.addInitScript(instrument, theme)
  const record = { width, theme, motionPreference: motion, checks: [], motion: [] }
  evidence.cases.push(record)
  const check = (ok, label) => { assert.ok(ok, `${id}: ${label}`); record.checks.push(label) }
  const button = (name, parent = page) => parent.getByRole('button', { name, exact: typeof name === 'string' })
  const dialog = name => page.getByRole('dialog', { name, exact: typeof name === 'string' })
  const picker = dialog('文件夹')
  const menu = name => page.getByRole('menuitem', { name })
  const back = () => page.keyboard.press('Escape')
  const settled = async () => {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await page.waitForFunction(() => document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).every(a => a.playState !== 'running'), undefined, { timeout: 3000 })
  }
  const shot = async name => { await settled(); await page.screenshot({ path: resolve(out, `${id}-${name}.png`) }) }
  const motionStep = async (label, action) => {
    await settled()
    await page.evaluate(value => window.motionLabel = value, label)
    await action()
    await settled()
    await page.evaluate(() => window.motionLabel = '')
  }
  const openDrawer = async () => { await button('打开边栏').click() }
  const openFolders = async () => { await button(/^文件夹(?: ·|$)/).click(); await picker.waitFor() }
  const edit = async name => {
    await button(`编辑文件夹 · ${name}`, picker).click()
    return dialog('编辑文件夹')
  }
  try {
    await page.goto(origin)
    await button('打开边栏').waitFor()
    await seedChats(page)
    await openDrawer()
    await motionStep('open-folders', openFolders)
    const list = picker.getByRole('list')
    await list.waitFor()
    await button('全部对话', picker).waitFor()
    const guideRow = list.getByRole('listitem').filter({ has: button(/^编辑文件夹 · /) })
    const guideName = (await guideRow.getByRole('button', { name: /^编辑文件夹 · / }).getAttribute('aria-label')).replace(/^编辑文件夹 · /, '')
    check(guideName === '示例文件夹' && (await picker.innerText()).includes('移至文件夹'), '首次浏览显示可管理的示例文件夹和操作指引')
    check(await list.getByRole('listitem').count() === 2, '初始列表为全部对话和示例文件夹')
    check(!(await picker.innerText()).includes('未分组'), '文件夹列表没有未分组项')
    await shot('guide')
    await button('新建文件夹', picker).click()
    let editor = dialog('新建文件夹')
    const name = '西北周末行程'
    const renamed = '西北周末出游'
    await editor.getByRole('textbox', { name: '文件夹名称' }).fill(name)
    const share = editor.getByRole('switch')
    check(!(await share.isChecked()), '新建文件夹共享初始关闭')
    await share.click()
    check(await share.isChecked(), '创建时能选择开启共享')
    await shot('create-sharing')
    await button('保存', editor).click()
    await editor.waitFor({ state: 'hidden' })
    if (!(await picker.isVisible())) await openFolders()
    await button(new RegExp(`^${name}`), picker).waitFor()
    await button('全部对话', picker).click()
    await picker.waitFor({ state: 'hidden' })
    const project = button('河西走廊行程')
    const chooseMove = async () => {
      await project.locator('..').getByRole('button', { name: '更多' }).click()
      await menu('移至文件夹').click()
      return dialog('移至文件夹')
    }
    const moving = await chooseMove()
    check(!(await moving.innerText()).includes('未分组'), '移动对话界面不显示未分组')
    await button(new RegExp(`^${name}`), moving).click()
    await moving.waitFor({ state: 'hidden' })
    await openFolders()
    await button(new RegExp(`^${guideName}`), picker).click()
    await picker.waitFor({ state: 'hidden' })
    await openFolders()
    await motionStep('switch-folder', async () => { await button(new RegExp(`^${name}`), picker).click(); await picker.waitFor({ state: 'hidden' }) })
    await project.waitFor()
    check(await button('读书笔记').count() === 0, '切换文件夹只显示移入的会话')
    await shot('selected')
    await openFolders()
    editor = await edit(name)
    check(await editor.getByRole('switch').isChecked(), '编辑页保留创建时的共享状态')
    await editor.getByRole('textbox').fill(renamed)
    await editor.getByRole('switch').click()
    await shot('edit-disabled')
    await button('保存', editor).click()
    await editor.waitFor({ state: 'hidden' })
    if (!(await picker.isVisible())) await openFolders()
    editor = await edit(renamed)
    check(!(await editor.getByRole('switch').isChecked()), '重命名和手动关闭均已保存')
    await motionStep('back-to-folder-list', async () => { await back(); await editor.waitFor({ state: 'hidden' }); await picker.waitFor() })
    await button(new RegExp(`^${renamed}`), picker).click()
    await picker.waitFor({ state: 'hidden' })
    const removal = await chooseMove()
    await button('移出文件夹', removal).click()
    await removal.waitFor({ state: 'hidden' })
    check(await project.count() === 0, '移出后会话立即从文件夹隐藏')
    await openFolders()
    await button('全部对话', picker).click()
    await picker.waitFor({ state: 'hidden' })
    await project.waitFor()
    check(await button('读书笔记').isVisible(), '全部对话保留移出后的会话和其他会话')
    const moveToGuide = await chooseMove()
    await button(guideName, moveToGuide).click()
    await moveToGuide.waitFor({ state: 'hidden' })
    const libraryKey = 'deepseek.local-library.v1'
    const memoryRows = [
      { id: 'remove-with-guide', text: '行程备注', sessionId: 'project' },
      { id: 'outside-guide', text: '我的读书进度', sessionId: 'standalone' },
      { id: 'general', text: '通用偏好', sessionId: null },
    ]
    // Represent memories already on this device. The real application performs every deletion.
    await page.evaluate(({ key, rows }) => {
      const data = JSON.parse(localStorage.getItem(key))
      data.memories = rows
      localStorage.setItem(key, JSON.stringify(data))
    }, { key: libraryKey, rows: memoryRows })
    const readLibrary = () => page.evaluate(key => localStorage.getItem(key), libraryKey)
    const baseline = await readLibrary()
    await openFolders()
    const guideEditor = await edit(guideName)
    const review = dialog('删除文件夹')
    const final = dialog('最后确认')
    const begin = async () => {
      await button('删除文件夹', guideEditor).click()
      await review.waitFor()
      check((await review.innerText()).includes('1 个对话') && (await review.innerText()).includes('1 条记忆'), '第一步列出本次对话与记忆数量')
    }
    await begin()
    await shot('delete-review')
    await button('取消', review).click()
    await review.waitFor({ state: 'hidden' })
    check(await readLibrary() === baseline, '第一次确认取消保留原数据')
    await begin()
    await back()
    await review.waitFor({ state: 'hidden' })
    check(await readLibrary() === baseline, '第一次确认返回保留原数据')
    await begin()
    await button('继续删除', review).dblclick()
    await final.waitFor()
    check(await button('取消', final).evaluate(el => el === document.activeElement), '最终确认的默认焦点在取消')
    check(await readLibrary() === baseline, '双击继续不能越过第二次确认')
    await shot('delete-final')
    await back()
    await final.waitFor({ state: 'hidden' })
    check(await readLibrary() === baseline, '最终确认返回保留原数据')
    await begin()
    await button('继续删除', review).click()
    await button('取消', final).click()
    await final.waitFor({ state: 'hidden' })
    check(await readLibrary() === baseline, '最终确认取消保留原数据')
    await begin()
    await button('继续删除', review).click()
    // Another tab edits an affected memory without changing either preview count.
    const writer = await context.newPage()
    await writer.goto(origin)
    await writer.evaluate(key => {
      const data = JSON.parse(localStorage.getItem(key))
      data.memories.find(row => row.id === 'remove-with-guide').text = '其他窗口刚刚更新的行程备注'
      localStorage.setItem(key, JSON.stringify(data))
    }, libraryKey)
    await writer.close()
    await button('确认永久删除', final).click()
    await review.getByRole('alert').waitFor()
    check(JSON.parse(await readLibrary()).memories.length === 3, '同数量的内容变更会回到第一步且保留所有记忆')
    await button('继续删除', review).click()
    await button('确认永久删除', final).click()
    await final.waitFor({ state: 'hidden' })
    const after = JSON.parse(await readLibrary())
    check(after.memories.map(row => row.id).sort().join(',') === 'general,outside-guide', '最终删除仅清除成员对话的记忆，并保留通用和其他对话记忆')
    check(!after.sessions.some(row => row.sessionId === 'project' && row.folderId), '已保留对话解除文件夹归属')
    record.motion.push(...await page.evaluate(() => window.motionFrames))
    await page.reload()
    await openDrawer()
    await openFolders()
    check(await picker.getByRole('listitem').count() === 2 && await button(new RegExp(`^${renamed}`), picker).count() === 1 && await button('全部对话', picker).count() === 1, '重启后只剩全部对话和用户文件夹，删除的示例不会重建')
    await shot('after-reload')
    await motionStep('back-to-drawer', async () => {
      await page.evaluate(() => history.back())
      await picker.waitFor({ state: 'hidden' })
      await button(/^文件夹(?: ·|$)/).waitFor()
    })
    await project.waitFor()
    check(await project.isVisible(), '重启后原对话仍可从全部对话打开')
    const transforms = record.motion.filter(row => row.keys.some(key => key.transform || key.translate))
    const visibleTravel = transforms.some(row => row.duration > 1 && row.samples.some(sample => sample.transform !== 'none' && sample.transform !== 'matrix(1, 0, 0, 1, 0, 0)'))
    check(motion === 'reduce' ? !visibleTravel : visibleTravel, motion === 'reduce' ? '减少动态效果时无空间位移' : '普通动效采集到实际位移帧')
    check((await page.evaluate(() => document.documentElement.scrollWidth)) <= width + 1, '屏幕内没有水平溢出')
    check(errors.length === 0, `浏览器异常 ${errors.length}`)
  } catch (error) {
    await writeFile(resolve(out, `${id}-failure.txt`), `${error}\n${await page.locator('body').innerText().catch(() => '')}`)
    await page.screenshot({ path: resolve(out, `${id}-failure.png`) }).catch(() => {})
    throw error
  } finally {
    record.motion.push(...await page.evaluate(() => window.motionFrames || []).catch(() => []))
    await context.close()
  }
}

try {
  for (const view of [{ width: 390, theme: 'light', motion: 'no-preference' }, { width: 320, theme: 'dark', motion: 'reduce' }]) await verify(view)
} finally {
  await writeFile(resolve(out, 'results.json'), JSON.stringify(evidence, null, 2))
  await browser.close()
  const closed = new Promise(resolve => server.close(resolve))
  server.closeAllConnections()
  await closed
}
