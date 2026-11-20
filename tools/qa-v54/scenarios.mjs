import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { restoreHistoricalThinking } from './history.mjs'
import { backupEnglish } from './backup-en.mjs'
import { titles } from './titles.mjs'
import { parity } from './parity.mjs'
import { modePanel } from './mode-panel.mjs'
import { workBuddyRates } from './workbuddy-rates.mjs'
import { stop } from './stop.mjs'
import { usage, usageRoutes } from './usage.mjs'
import { deployedFileAttachments, fileAttachments } from './files.mjs'
import { catalog, discovery } from './catalog.mjs'
const button = (page, name) => page.getByRole('button', { name, exact: typeof name === 'string' })
const input = (page) => page.locator('textarea:visible').first()
const paint = (page) =>
  page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
  )
async function eventually(probe, description) {
  const deadline = Date.now() + 6500
  do {
    if (await probe()) return
    await new Promise((resolve) => setTimeout(resolve, 35))
  } while (Date.now() < deadline)
  throw Error('Timed out: ' + description)
}
async function send(page, question) {
  await input(page).fill(question)
  await button(page, '发送').click()
}
async function call(page, op, index) {
  await page.waitForFunction(
    ({ op, index }) => window.qa.calls.filter((c) => c.op === op).length > index,
    { op, index }
  )
  return page.evaluate(({ op, index }) => window.qa.calls.filter((c) => c.op === op)[index], {
    op,
    index,
  })
}
const answer = (page, id, text) =>
  page.evaluate(
    ({ id, text }) => {
      window.qa.header(id)
      window.qa.text(id, text)
      window.qa.finish(id)
    },
    { id, text }
  )
const activeMessage = (page) => page.locator('[data-message-id]').last()
async function settings(page) {
  const entry = button(page, '设置')
  const sidebar = button(page, /^打开边栏/)
  await entry.or(sidebar).first().waitFor()
  if (!(await entry.isVisible())) await sidebar.click()
  await entry.click()
}
async function choose(page, scope, label, option) {
  await button(scope, label).click()
  const menu = page.getByRole('listbox', { name: label })
  await menu.getByRole('option', { name: option, exact: typeof option === 'string' }).click()
  // Desktop makes the outgoing popup inert before applying the pending choice.
  await page.locator(`[role="listbox"][aria-label="${label}"]`).waitFor({ state: 'detached' })
  await paint(page)
}
async function thinking({ page, phone, shot, check, motion, result }) {
  await send(page, '请简单概括。')
  const first = await call(page, 'chat', 0)
  check(first.thinking === true, 'Requested thinking is on while upstream sends text only')
  const row = activeMessage(page)
  await row.waitFor()
  await paint(page)
  const hints = () => row.innerText()
  check(
    !/思考|推理/.test(await hints()) && (await row.locator('[data-reply-thinking]').count()) === 0,
    'Waiting reply has no thinking label'
  )
  const dots = row.locator('[class*="waitingDot"]')
  await dots.first().waitFor()
  const animations = await dots.evaluateAll((items) =>
    items.map((el) => getComputedStyle(el).animationName)
  )
  result.waitingAnimations = animations
  check(
    animations.length === 3 && animations.every((a) => (a === 'none') === (motion === 'reduce')),
    'Waiting dots respect actual motion preference'
  )
  await page.evaluate((id) => {
    window.qa.header(id)
    window.qa.text(id, '普通文字回答')
  }, first.id)
  await row.getByText('普通文字回答', { exact: true }).waitFor()
  check(!/思考|推理/.test(await hints()), 'Text-only streaming reply has no thinking label')
  await page.evaluate((id) => window.qa.finish(id), first.id)
  await row.locator('[data-message-actions]').waitFor()
  check(!/思考|推理/.test(await hints()), 'Completed text-only reply has no thinking label')
  check(
    !(await row.locator('[class*=notice] > svg,[role=alert]').count()),
    'Plain completed answer has no red failure notice'
  )
  await shot('plain')
  await send(page, '请逐步比较。')
  const second = await call(page, 'chat', 1)
  await page.evaluate((id) => {
    window.qa.header(id)
    window.qa.think(id, '先对照两组观测值。')
  }, second.id)
  await row.getByText('先对照两组观测值。', { exact: true }).waitFor()
  const header = row.locator('[data-reply-thinking]')
  check(
    (await header.getAttribute('aria-expanded')) === 'true',
    'Received reasoning opens a labeled thinking block'
  )
  await shot('thinking')
  await page.evaluate((id) => {
    window.qa.text(id, '比较完成。')
    window.qa.finish(id)
  }, second.id)
  await row.getByText('比较完成。', { exact: true }).waitFor()
  await row.locator('[data-reply-thinking][aria-expanded="false"]').waitFor()
  await header.click()
  await row.getByText('先对照两组观测值。', { exact: true }).waitFor()
  check(
    (await header.getAttribute('aria-expanded')) === 'true',
    'Completed reasoning can be expanded again'
  )
  await restoreHistoricalThinking({ page, phone, check, shot }, eventually)
}
async function search({ page, shot, check, result }, thorough = false) {
  await button(page, '深度思考').click()
  await button(page, /智能搜索|联网搜索/).click()
  const question = thorough
    ? '查找两款产品的官方续航规格，并逐篇核对每篇独立测评的正文。'
    : '查找两款产品的官方续航规格，并比较独立测评。'
  await send(page, question)
  const seen = new Set(),
    sources = new Map(),
    queries = [],
    reads = []
  let final
  for (let iterations = 0; iterations < 18; iterations++) {
    await page.waitForFunction(
      (ids) =>
        window.qa.calls.some(
          (c) => ['chat', 'search', 'read'].includes(c.op) && !ids.includes(c.id)
        ),
      [...seen]
    )
    const calls = await page.evaluate(() =>
      window.qa.calls.filter((c) => ['chat', 'search', 'read'].includes(c.op))
    )
    for (const c of calls.filter((c) => !seen.has(c.id))) {
      seen.add(c.id)
      if (
        c.op === 'chat' &&
        (c.purpose === 'search_plan' ||
          c.messages?.[0]?.content.includes('WorkBuddy search planner'))
      ) {
        await answer(
          page,
          c.id,
          JSON.stringify({
            queries: ['产品官方续航规格', '独立测评续航对比'],
            multi: true,
            read: true,
          })
        )
        continue
      }
      if (c.op === 'search') {
        queries.push(c.query)
        const step = activeMessage(page).locator('[data-search-step]')
        await step
          .filter({ hasText: /搜索/ })
          .first()
          .waitFor()
        if (queries.length === 1) await shot('searching')
        const rows = Array.from({ length: 5 }, (_, i) => {
          // An overlapping first result in round 2 verifies the UI counts unique documents.
          const n = i === 0 ? 1 : (queries.length - 1) * 5 + i + 1
          return {
            title: `测评资料 ${n}`,
            url: `https://source${n}.example.test/review`,
            snippet: `样例资料摘要 ${n}`,
            readKey: `public-read-${n}`,
          }
        })
        for (const r of rows) sources.set(r.url, r)
        await page.evaluate(({ id, rows }) => window.qa.sources(id, rows), { id: c.id, rows })
      } else if (c.op === 'chat') {
        final = c
        break
      } else if (c.op === 'read') {
        reads.push(c.readKey)
        check(
          [...sources.values()].some((source) => source.readKey === c.readKey),
          'Page was opened using an ID issued by the search fixture'
        )
        await page.evaluate(({ id, text }) => window.qa.page(id, text), {
          id: c.id,
          text: '已读取公开正文 ' + c.readKey,
        })
      }
    }
    if (final) break
  }
  check(
    final && queries.length >= 2 && new Set(queries).size >= 2,
    'At least two distinct search queries were actually dispatched'
  )
  const evidence = final.messages
    .filter((m) => m.role === 'user')
    .map((m) => m.content)
    .join('\n')
  const used = [...sources.keys()].filter((url) => evidence.includes(url))
  check(used.length > 5, 'Final model received evidence from more than five distinct source URLs')
  check(
    new Set(reads).size > 5 &&
      reads.length === new Set(reads).size &&
      reads.every((key) => evidence.includes('已读取公开正文 ' + key)),
    'More than five unique page reads contribute their actual text to the answer'
  )
  await answer(page, final.id, '已按不同来源进行核对。[S1][S2]')
  await page.getByText('已按不同来源进行核对。', { exact: true }).waitFor()
  check(
    (await activeMessage(page).locator('[data-search-page=done]').count()) === reads.length,
    'Search timeline marks each actual page read complete'
  )
  const cites = activeMessage(page).locator('.ds-markdown-cite[role=link]')
  check((await cites.count()) === 2, 'Answer renders two inline source citations')
  const summary = activeMessage(page).locator('[data-search-sources]')
  await summary.waitFor()
  await summary.click()
  const links = page.locator('aside a[href*=".example.test/review"]:visible')
  await links.first().waitFor()
  const urls = await links.evaluateAll((items) => items.map((el) => el.href))
  check(
    new Set(urls).size > 5 &&
      urls.length === new Set(urls).size &&
      urls.every((url) => sources.has(url)),
    'Sources panel renders more than five distinct matching clickable URLs'
  )
  check(
    !(await activeMessage(page).locator('[data-reply-thinking]').count()),
    'Search without reasoning has no thinking header'
  )
  result.search = {
    queries,
    reads,
    uniqueResultLinks: urls.length,
    uniqueGroundingLinks: used.length,
  }
  await shot('sources')
}
async function contextSettings({ page, shot, check, result }) {
  async function open() {
    await settings(page)
    await page.locator('[data-context-settings-entry]').click()
  }
  await open()
  const panel = page.locator('[data-context-settings]'),
    field = panel.locator('[data-context-window]')
  const save = panel.locator('[data-context-save]'),
    reset = panel.locator('[data-context-reset]')
  const wb = async () => choose(page, panel, '服务方案', /WorkBuddy/)
  const models = async (id) => {
    await button(panel, '模型').click()
    const menu = page.getByRole('listbox', { name: '模型' })
    await menu.locator(`[data-option-value="${id}"]`).click()
    await menu.waitFor({ state: 'detached' })
    await paint(page)
  }
  await wb()
  await models('deepseek-v4.1-flash')
  const initial = await field.inputValue()
  check(Number(initial) > 0, 'Known model exposes positive default window')
  await field.fill('0')
  check(
    (await save.isDisabled()) || !(await field.evaluate((el) => el.checkValidity())),
    'Invalid context value cannot be saved'
  )
  await field.fill('49152')
  await save.click()
  await models('deepseek-v4-pro')
  const other = await field.inputValue()
  check(other !== '49152' && Number(other) > 0, 'Another model keeps its own window')
  await field.fill('65536')
  await save.click()
  await models('deepseek-v4.1-flash')
  check(
    (await field.inputValue()) === '49152',
    'Switching back restores the first model’s saved value'
  )
  await field.fill('50000')
  await models('deepseek-v4-pro')
  await models('deepseek-v4.1-flash')
  check((await field.inputValue()) === '49152', 'Switching discards an unsaved edit')
  await shot('editor')
  await page.reload()
  await open()
  await wb()
  await models('deepseek-v4.1-flash')
  check((await field.inputValue()) === '49152', 'Window survives browser reload')
  await models('deepseek-v4-pro')
  check((await field.inputValue()) === '65536', 'Second model persists independently')
  await reset.click()
  check((await field.inputValue()) === other, 'Reset restores this model’s default')
  check(
    await page.evaluate(() => !window.qa.calls.some((c) => ['chat', 'model'].includes(c.op))),
    'Editing windows does not dispatch chat or change the active account model'
  )
  result.contextWindows = { initial, other, edits: [49152, 65536] }
}
async function backup({ page, phone, shot, check, result }) {
  const state = () =>
    page.evaluate(async () => {
      const get = (s, k) => window.qa.store('chat-demo-backups', s, k)
      const p = await get('preferences', 'settings'),
        a = await get('artifacts', 'automatic')
      return {
        rounds: p?.completedRounds ?? 0,
        id: a?.id,
        size: a?.blob?.size,
        auto: p?.autoEnabled ?? true,
        reason: a?.reason,
      }
    })
  for (let n = 1; n <= 10; n++) {
    await send(page, `第 ${n} 次备份测试`)
    const c = await call(page, 'chat', n - 1)
    if (n === 10) {
      await input(page).fill('保留此草稿')
      await input(page).focus()
      await input(page).evaluate((el) => {
        el.setSelectionRange(2, 2)
        window.qa.lostFocus = 0
        el.addEventListener('blur', () => window.qa.lostFocus++)
      })
    }
    await answer(page, c.id, `回答已完成 ${n}`)
    await activeMessage(page).getByText(`回答已完成 ${n}`, { exact: true }).waitFor()
    if (n < 10) {
      await eventually(async () => (await state()).rounds === n, `round ${n} committed`)
      check(!(await state()).id, `Round ${n} produces no automatic artifact`)
    }
  }
  const toast = page
    .getByRole('status')
    .filter({ hasText: /已备份到本机.*设置.*数据管理.*本机自动备份.*关闭/ })
  await toast.waitFor()
  const focus = await input(page).evaluate((el) => ({
    value: el.value,
    active: document.activeElement === el,
    caret: el.selectionStart,
    blurs: window.qa.lostFocus,
  }))
  check(
    focus.active && focus.value === '保留此草稿' && focus.caret === 2 && focus.blurs === 0,
    'Tenth completion keeps composer focus, caret and unsent draft'
  )
  check(
    (await page.locator('dialog[open], [role="dialog"]:visible').count()) === 0,
    'Backup completion opens no blocking dialog'
  )
  const auto = await state()
  check(
    auto.reason === 'automatic' && auto.size > 0 && auto.rounds === 0,
    'Tenth successful turn generates a nonempty local ZIP and resets the counter'
  )
  result.backup = { focus, zipBytes: auto.size }
  await shot('notice')
  const archive = await page.evaluate(async () =>
    Array.from(
      new Uint8Array(
        await (
          await window.qa.store('chat-demo-backups', 'artifacts', 'automatic')
        ).blob.arrayBuffer()
      )
    )
  )
  result.backup.archive = JSON.parse(
    execFileSync('python3', [fileURLToPath(new URL('./zip.py', import.meta.url))], {
      input: Buffer.from(archive),
      encoding: 'utf8',
    })
  )
  check(
    result.backup.archive.finishedTurns === 10,
    'Verified ZIP CRC, manifest, index and ten complete archived questions and replies'
  )
  await page.keyboard.insertText('继续')
  check(
    (await input(page).inputValue()) === '保留继续此草稿',
    'Typing can continue at the same caret'
  )
  // Populate sentinel records in the separate safety-snapshot stores of this ephemeral context.
  await page.evaluate(async () => {
    const open = indexedDB.open('chat-demo-backups')
    const db = await new Promise((ok) => {
      open.onsuccess = () => ok(open.result)
    })
    const tx = db.transaction(['snapshots', 'snapshotParts'], 'readwrite')
    tx.objectStore('snapshots').put(
      {
        id: 'qa-safety',
        name: 'qa-safety.zip',
        reason: 'before-clear',
        parts: 1,
        createdAt: Date.now(),
        sessionCount: 1,
        saveStatus: 'generated',
      },
      'latest'
    )
    tx.objectStore('snapshotParts').put({ draft: { id: 'qa-draft', text: 'sentinel' } }, [
      'qa-safety',
      0,
    ])
    await new Promise((ok, fail) => {
      tx.oncomplete = ok
      tx.onerror = () => fail(tx.error)
    })
    db.close()
  })
  async function openData() {
    await settings(page)
    await page.getByRole(phone ? 'button' : 'tab', { name: '数据管理', exact: true }).click()
  }
  await openData()
  const toggle = page.getByRole('switch', { name: '本机自动备份', exact: true })
  await toggle.uncheck()
  check(!(await state()).auto, 'Settings disables automatic backups')
  await button(page, /导出历史备份/).click()
  await button(page, '生成备份').click()
  await page.getByText('已生成，尚未确认保存', { exact: true }).first().waitFor()
  const artifactInfo = await page.evaluate(async () => {
    const a = await window.qa.store('chat-demo-backups', 'artifacts', 'latest')
    return a ? { keys: Object.keys(a), reason: a.reason, size: a.blob?.size } : null
  })
  result.backup.manualArtifact = artifactInfo
  const snapshot = async () =>
    page.evaluate(async () => {
      const manual = await window.qa.store('chat-demo-backups', 'artifacts', 'latest')
      const sessions = await window.qa.store('chat-demo', 'sessions')
      const bytes =
        manual?.blob &&
        new Uint8Array(await crypto.subtle.digest('SHA-256', await manual.blob.arrayBuffer()))
      return {
        manual: {
          id: manual?.id,
          size: manual?.blob?.size,
          sha256: bytes && Array.from(bytes, (n) => n.toString(16).padStart(2, '0')).join(''),
        },
        safety: await window.qa.store('chat-demo-backups', 'snapshots', 'latest'),
        part: await window.qa.store('chat-demo-backups', 'snapshotParts', ['qa-safety', 0]),
        sessions,
      }
    })
  await eventually(
    async () =>
      (await snapshot()).sessions.some(
        (session) =>
          session.messages.filter((m) => m.role === 'user').length === 10 &&
          session.messages.filter((m) => m.role === 'assistant' && m.status === 'done').length ===
            10
      ),
    'ten turns persisted'
  )
  const before = await snapshot()
  result.backup.manualSha256 = before.manual.sha256
  result.backup.manualBytes = before.manual.size
  check(
    before.manual.size > 0,
    'Manual ZIP and complete ten-turn conversation exist before deletion'
  )
  const del = button(page, '删除本机自动备份')
  await del.click()
  await button(page, '取消').last().click()
  check((await state()).id === auto.id, 'Cancel keeps automatic artifact')
  await del.click()
  await shot('delete-confirm')
  await button(page, '删除备份').click()
  await eventually(async () => !(await state()).id, 'automatic artifact deleted')
  assert.deepEqual(await snapshot(), before)
  check(true, 'Delete preserves manual ZIP, safety snapshot, snapshot data and all live messages')
  await page.reload()
  await openData()
  check(
    !(await toggle.isChecked()) && !(await state()).id,
    'Off state and deletion persist after reload'
  )
  await page.reload()
  for (let n = 1; n <= 10; n++) {
    await send(page, `关闭自动备份后的第 ${n} 轮`)
    const c = await call(page, 'chat', n - 1)
    await answer(page, c.id, `关闭后回复 ${n}`)
    await activeMessage(page).getByText(`关闭后回复 ${n}`, { exact: true }).waitFor()
  }
  await eventually(
    async () =>
      (await snapshot()).sessions.some(
        (session) =>
          session.messages.filter((m) => m.role === 'assistant' && m.status === 'done').length ===
            10 && session.messages.some((m) => m.content === '关闭自动备份后的第 10 轮')
      ),
    'ten additional disabled turns persisted'
  )
  const off = await state()
  check(
    !off.id && !off.auto && off.rounds === 0,
    'Ten completed turns while disabled leave the auto slot empty and counter at zero'
  )
}
async function openWorkBuddySettings(page) {
  await settings(page)
  const tab = page.locator('[data-settings-tab="account"]')
  const entry = page.locator('[data-wb-account-entry]')
  await tab.or(entry).first().waitFor()
  if (await tab.isVisible()) await tab.click()
  await entry.click()
}
async function roster({ page, check, shot, result }) {
  const extra = 'qa-workbuddy-added'
  await openWorkBuddySettings(page)
  const panel = page.locator('[data-wb-account-page]')
  await button(panel, 'WorkBuddy 模型').click()
  const menu = page.getByRole('listbox', { name: 'WorkBuddy 模型' })
  const options = await menu.getByRole('option').allTextContents()
  check(options.length === 4, 'The account model menu renders the full synthetic account roster')
  await menu.getByRole('option', { name: /qa-workbuddy-added/ }).click()
  await call(page, 'model', 0)
  await button(panel, 'WorkBuddy 模型')
    .getByText(/qa-workbuddy-added/)
    .waitFor()
  await shot('account-selection')
  await page.reload()
  await send(page, '新加入的测试模型')
  const c = await call(page, 'chat', 0)
  check(
    c.model === extra,
    'Chat dispatch uses the additional account-authorized ID on the WorkBuddy bridge'
  )
  await answer(page, c.id, '来自所选型号')
  await activeMessage(page).getByText('来自所选型号', { exact: true }).waitFor()
  result.roster = { options, dispatched: c.model }
}
export const scenarios = {
  modePanel: (ui) => modePanel(ui, { choose, eventually }),
  workBuddyRates: (ui) => workBuddyRates(ui, { openWorkBuddySettings }),
  thinking,
  search,
  searchPerPage: (ui) => search(ui, true),
  fileAttachments: env => fileAttachments(env, { call, answer, eventually }),
  ...Object.fromEntries(['official', 'router', 'custom'].map(kind => [`files-${kind}`, env => deployedFileAttachments(kind, env, { eventually })])),
  context: contextSettings,
  backup,
  backupEnglish,
  roster,
  ...Object.fromEntries(Object.keys(usageRoutes).map(kind => [`usage-${kind}`, env => usage(kind, env, { settings, choose, send, activeMessage, eventually })])),
  stop: env => stop(env, {send,call,activeMessage,eventually}),
  ...Object.fromEntries(['workbuddy','messages','completions','openrouter'].map(kind=>[`parity-${kind}`,env=>parity(kind,env,{send,call,eventually,activeMessage})])),
  titles: (env) => titles(env, { send, call, answer, eventually, activeMessage }),
  catalog: (env) => catalog(env, { settings, choose }),
  discovery: (env) => discovery(env, { settings, choose, eventually }),
}
