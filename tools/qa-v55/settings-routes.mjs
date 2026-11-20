import assert from 'node:assert/strict'

// Fresh, isolated accounts. Only the 390px viewport installs Android Capacitor callbacks.
export function androidFixture(native) {
  window.qaSettings = { native, exits: 0, accountRequests: [] }
  window.AndroidUpdater = { getInstalledVersion: () => '1.0.55' }
  window.DshNative = {
    postMessage(raw) {
      const frame = JSON.parse(raw)
      window.qaSettings.accountRequests.push(frame)
      if (frame.op === 'status')
        queueMicrotask(() =>
          this.onmessage({ data: JSON.stringify({ type: 'account', signedIn: false }) })
        )
    },
  }
  if (!native) return
  window.CapacitorPlatforms = {
    currentPlatform: { getPlatform: () => 'android', isNativePlatform: () => true },
  }
  const methods = (...names) => names.map((name) => ({ name, rtype: 'promise' }))
  window.Capacitor = {
    PluginHeaders: [
      {
        name: 'App',
        methods: [
          ...methods('removeListener', 'exitApp', 'getInfo'),
          { name: 'addListener', rtype: 'callback' },
        ],
      },
      { name: 'StatusBar', methods: methods('setStyle', 'setBackgroundColor') },
      { name: 'WorkBuddyWallet', methods: methods('status', 'refresh') },
    ],
    nativeCallback(plugin, method, options, callback) {
      if (plugin === 'App' && method === 'addListener' && options.eventName === 'backButton')
        window.qaSettings.back = callback
      return 'test-listener'
    },
    async nativePromise(plugin, method) {
      if (plugin === 'App' && method === 'exitApp') window.qaSettings.exits++
      if (plugin === 'App' && method === 'getInfo') return { version: '1.0.55' }
      if (plugin === 'WorkBuddyWallet')
        return {
          source: 'account',
          revision: '00000000-0000-4000-8000-000000000054',
          state: 'account-page',
          balance: 54,
          checkIn: 'unknown',
          observedAt: Date.now(),
        }
      return {}
    },
  }
}
const btn = (scope, name) => scope.getByRole('button', { name, exact: typeof name === 'string' })
const front = (page, name) =>
  page.locator(`[data-settings-route="${name}"][data-route-position=front]:not([inert])`)
async function settings(page) {
  await page.locator('textarea:visible').first().waitFor({ timeout: 15000 })
  const setting = btn(page, '设置')
  if (!(await setting.isVisible())) await btn(page, /^打开边栏/).click()
  await setting.click()
  await page.locator('[data-theme-picker]:visible').waitFor()
}
async function noOverflow(scope) {
  const geometry = await scope.evaluate((el) => ({
    client: el.clientWidth,
    scroll: el.scrollWidth,
  }))
  assert.ok(
    geometry.scroll <= geometry.client + 1,
    `Horizontal overflow ${JSON.stringify(geometry)}`
  )
}
export async function appearance({ page, osTheme, phone, note, shot }) {
  await settings(page)
  const picker = page.locator('[data-theme-picker]:visible')
  assert.equal(await picker.getByRole('radio').count(), 3)
  const radios = await picker.getByRole('radio').evaluateAll((items) => items.map((el) => el.value))
  assert.deepEqual([...radios].sort(), ['dark', 'light', 'system'])
  if (phone) {
    assert.deepEqual(
      await front(page, 'root')
        .locator('[data-settings-group]')
        .evaluateAll((els) => els.map((el) => el.dataset.settingsGroup)),
      ['preferences', 'account', 'models', 'privacy', 'about']
    )
    note('Home groups: preferences, accounts, models, privacy, about')
  }
  await noOverflow(picker)
  for (const theme of ['dark', 'light', 'system']) {
    const expected = theme === 'system' ? osTheme : theme
    await picker.locator(`[data-theme-choice=${theme}]`).click()
    await page.waitForFunction(
      ({ theme, expected }) =>
        document.body.classList.contains(expected) &&
        document.querySelector(`[data-theme-picker] input[value=${theme}]`).checked &&
        localStorage.getItem('chat-demo:theme-preference') === theme,
      { theme, expected }
    )
    assert.equal(await picker.locator('input:checked').count(), 1)
    if (phone) assert.equal(await page.locator('[data-settings-route]').count(), 1)
    await page.reload()
    await settings(page)
    assert.ok(await picker.locator(`input[value=${theme}]`).isChecked())
    assert.ok(await page.locator(`body.${expected}`).count())
  }
  const opposite = osTheme === 'light' ? 'dark' : 'light'
  await page.emulateMedia({ colorScheme: opposite })
  await page.locator(`body.${opposite}`).waitFor({ state: 'attached' })
  await page.emulateMedia({ colorScheme: osTheme })
  await page.locator(`body.${osTheme}`).waitFor({ state: 'attached' })
  note('All three choices apply in place and survive reload. System follows live OS changes')
  const current = picker.locator('input:checked')
  await current.focus()
  await page.keyboard.press('ArrowRight')
  const next = radios[(radios.indexOf('system') + 1) % 3]
  assert.ok(await picker.locator(`input[value=${next}]`).isChecked())
  assert.equal(await page.evaluate(() => document.activeElement?.value), next)
  await page.keyboard.press('ArrowLeft')
  assert.ok(await picker.locator('input[value=system]').isChecked())
  note('Arrow keys move focus and select on the radio group')
  await shot('preferences')
  const switcher = page.getByRole('switch', { name: '思考内容自动折叠', exact: true })
  assert.ok((await switcher.getAttribute('data-collapse-thinking')) !== null)
  const wasChecked = await switcher.isChecked()
  await switcher.focus()
  await page.keyboard.press('Space')
  assert.equal(await switcher.isChecked(), !wasChecked)
  if (phone) assert.equal(await page.locator('[data-settings-route]').count(), 1)
  await page.reload()
  await settings(page)
  assert.equal(await switcher.isChecked(), !wasChecked)
  note('Space toggles auto-collapse on the preferences page and the choice survives reload')
}
async function back(page, source) {
  if (source === 'android') await page.evaluate(() => window.qaSettings.back({ canGoBack: true }))
  else if (source === 'browser') await page.evaluate(() => history.back())
  else await page.keyboard.press('Escape')
}
const rootRoutes = [
  ['fontSize', /^字体大小/],
  ['profile', /^账号资料/],
  ['workbuddyAccount', '[data-wb-account-entry]'],
  ['apiKey', /^API Key 管理/],
  ['contextModels', '[data-context-settings-entry]'],
  ['data', /^数据管理/],
  ['security', /^安全与应用锁/],
  ['memory', /^记忆/],
]
export async function phoneRoutes({ page, native, motion, note, shot }) {
  const source = native ? 'android' : 'browser'
  if (native) await page.waitForFunction(() => typeof window.qaSettings.back === 'function')
  const route = async (parent, child, opener, visit) => {
    if (typeof opener === 'string') opener = front(page, parent).locator(opener)
    else opener = btn(front(page, parent), opener)
    await opener.focus()
    await opener.click()
    const childEl = front(page, child)
    await childEl.waitFor()
    const transformMs = await childEl.evaluate((el) => {
      const s = getComputedStyle(el)
      return s.transitionProperty.includes('transform') ? parseFloat(s.transitionDuration) || 0 : 0
    })
    if (motion === 'reduce')
      assert.equal(transformMs, 0, 'Reduced motion removes route translation')
    else assert.ok(transformMs > 0, 'Route uses a nonzero transform transition')
    await noOverflow(childEl)
    assert.equal(await page.locator('[data-settings-route]:not([inert])').count(), 1)
    if (visit) await visit(childEl)
    await back(page, source)
    await childEl.waitFor({ state: 'detached' })
    await page.locator(`[data-settings-route=${child}]`).waitFor({ state: 'detached' })
    await front(page, parent).waitFor()
    assert.ok(
      await opener.evaluate(
        (el) => el.contains(document.activeElement) || document.activeElement === el
      ),
      'Restore the opening control'
    )
    note(`${parent} → ${child} → ${parent}, ${source} back and focus restored`)
  }
  for (const [child, trigger] of rootRoutes) {
    await route('root', child, trigger, async (scope) => {
      if (child === 'profile') await route(child, 'location', /^位置信息/)
      if (child === 'apiKey') {
        await route(child, 'guide', /^申请官方 API Key/)
        await route(child, 'apiEdit', /^添加 API Key/)
        await usage('apiKey', '[data-api-usage-entry]')
      }
      if (child === 'data') {
        await route(child, 'webdav', /WebDAV/)
        await route(child, 'compacted', /^已压缩的对话/)
        const localHistory = scope.getByRole('region', { name: '本机历史', exact: true })
        const danger = scope.getByRole('region', { name: '清除本机数据', exact: true })
        assert.equal(await localHistory.getByRole('button').count(), 1)
        const clear = btn(danger, /删除所有/)
        await clear.scrollIntoViewIfNeeded()
        assert.ok(await clear.isDisabled(), 'No history to delete in a fresh account')
        await shot('data')
      }
      if (child === 'contextModels') await shot('context')
    })
  }
  async function usage(parent, selector) {
    const opener = front(page, parent).locator(selector)
    await opener.click()
    const overlay = page.getByRole('dialog', { name: '模型用量', exact: true })
    await overlay.waitFor()
    await back(page, source)
    await overlay.waitFor({ state: 'detached' })
    await front(page, parent).waitFor()
    assert.ok(await opener.evaluate((el) => el === document.activeElement), 'Usage restores opener')
    note(`${parent} → usage → ${parent} via ${source}`)
  }
  await usage('root', '[data-usage-home-entry]')
  for (const title of ['语言', 'DeepSeek 朗读音色', '检查更新', '帮助与反馈']) {
    await btn(front(page, 'root'), new RegExp(title)).click()
    const modal = page.getByRole('dialog', { name: title, exact: true })
    await modal.waitFor()
    await back(page, source)
    await modal.waitFor({ state: 'detached' })
    await front(page, 'root').waitFor()
    note(`${title} overlay dismissed with ${source} back; root preserved`)
  }
  await front(page, 'root').locator('[data-dsh-account]').click()
  assert.equal(await page.evaluate(() => qaSettings.accountRequests.at(-1).op), 'account')
  if (native) assert.equal(await page.evaluate(() => qaSettings.exits), 0)
  await back(page, source)
  await page.locator('[data-settings-shell]').waitFor({ state: 'detached' })
  note(`Root closed via ${source}; account entry delivered native operation`)
}
export async function desktopRoutes({ page, note, shot }) {
  const tabs = page.getByRole('tablist').getByRole('tab')
  const labels = await tabs.allTextContents()
  assert.deepEqual(
    await tabs.evaluateAll((items) => items.map((item) => item.dataset.settingsTab)),
    [
      'general',
      'account',
      'apiKey',
      'contextModels',
      'data',
      'memory',
      'security',
      'webdav',
      'about',
    ]
  )
  await page.keyboard.press('Shift+Tab')
  await tabs.first().focus()
  await page.keyboard.press('End')
  assert.equal(await tabs.last().getAttribute('aria-selected'), 'true')
  await page.keyboard.press('Home')
  let usageGroup,
    wbGroup,
    dataGroup,
    context = false
  for (const [index, label] of labels.entries()) {
    const tab = page.getByRole('tab', { name: label, exact: true })
    if (index) {
      await tabs.nth(index - 1).focus()
      await page.keyboard.press('ArrowDown')
    }
    assert.equal(await tab.getAttribute('aria-selected'), 'true')
    const panel = page.getByRole('tabpanel')
    await noOverflow(panel)
    await noOverflow(panel.locator('..'))
    if (await panel.locator('[data-api-usage-entry]').isVisible()) {
      usageGroup = label
      await panel.locator('[data-api-usage-entry]').click()
      const modal = page.getByRole('dialog', { name: '模型用量', exact: true })
      await modal.waitFor()
      await page.keyboard.press('Escape')
      await modal.waitFor({ state: 'detached' })
      assert.equal(await tab.getAttribute('aria-selected'), 'true')
    }
    if (await panel.locator('[data-wb-account-entry]').isVisible()) {
      wbGroup = label
      await panel.locator('[data-wb-account-entry]').click()
      await page.locator('[data-wb-account-page]').waitFor()
      await page.keyboard.press('Escape')
      await page.locator('[data-wb-account-page]').waitFor({ state: 'detached' })
      assert.equal(await tab.getAttribute('aria-selected'), 'true')
    }
    if (await panel.locator('[data-context-settings]').isVisible()) context = true
    const danger = panel.locator('[data-settings-group=danger]')
    if (await danger.isVisible()) {
      dataGroup = label
      const action = btn(danger, '删除')
      await action.click()
      const confirmation = page.getByRole('dialog', {
        name: '保存安全快照后清空历史？',
        exact: true,
      })
      await confirmation.waitFor()
      await page.keyboard.press('Escape')
      await confirmation.waitFor({ state: 'detached' })
      assert.equal(await tab.getAttribute('aria-selected'), 'true')
      note('Clear action opens a confirmation; Escape returns to the data tab')
    }
    if ((await tab.getAttribute('data-settings-tab')) === 'about') {
      await panel.locator('[data-update-entry]').click()
      const update = page.getByRole('dialog', { name: '检查更新', exact: true })
      await update.waitFor()
      await page.keyboard.press('Escape')
      await update.waitFor({ state: 'detached' })
      await btn(panel, '查看帮助').click()
      const help = page.getByRole('dialog', { name: '帮助与反馈', exact: true })
      await help.waitFor()
      await page.keyboard.press('Escape')
      await help.waitFor({ state: 'detached' })
    }
    note(`Keyboard opens desktop tab ${label}`)
  }
  assert.ok(
    wbGroup && usageGroup && context && dataGroup,
    JSON.stringify({ wbGroup, usageGroup, context, dataGroup })
  )
  assert.notEqual(usageGroup, dataGroup, 'Usage belongs to the model group')
  note(`Account, data, model context and usage reachable. Usage returned to ${usageGroup}`)
  await page.getByRole('tab', { name: usageGroup, exact: true }).click()
  await shot('models')
  await page.keyboard.press('Escape')
  await page.getByRole('tablist').waitFor({ state: 'detached' })
}
