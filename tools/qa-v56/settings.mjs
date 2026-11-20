// Normal UI entry on each form factor. No settings state, router, or DOM is patched.
import assert from 'node:assert/strict'
import { accountsFixture } from './accounts-fixture.mjs'
import { contrast } from './visual-checks.mjs'
import { button, front, openSettings, runner } from './browser.mjs'

const run = await runner(process.argv.slice(2))
const evidence = (width, theme) =>
  (width === 320 && theme === 'light') ||
  (width === 390 && theme === 'dark') ||
  (width === 1280 && theme === 'light')

async function routeMatrix({ page, record, shot, phone, version }) {
  await openSettings(page)
  const is55 = version === '1.0.55'
  const panel = page.getByRole('tabpanel')
  const capture = evidence(record.width, record.theme)
  async function inspect(name, scope) {
    await scope.waitFor()
    const metrics = await scope.evaluate((el) => {
      const interactive = Array.from(
        el.querySelectorAll('button,a,input:not([type=hidden]),textarea,[role=tab]')
      )
      const boxes = interactive
        .filter((node) => node.getClientRects().length && !node.closest('[inert]'))
        .map((node) => {
          const rect = node.getBoundingClientRect()
          return {
            label: (node.getAttribute('aria-label') || node.textContent || node.tagName)
              .trim()
              .slice(0, 40),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          }
        })
      const scrollables = [el, ...el.querySelectorAll('*')].filter(
        (node) => node.clientWidth > 0 && /^(scroll|auto)$/.test(getComputedStyle(node).overflowX)
      )
      const overflows = scrollables
        .filter((node) => node.scrollWidth > node.clientWidth + 1)
        .map((n) => [n.className, n.clientWidth, n.scrollWidth])
      return {
        client: el.clientWidth,
        scroll: el.scrollWidth,
        overflows,
        small: boxes.filter((b) => b.width < 44 || b.height < 44),
      }
    })
    assert.ok(
      metrics.client > 0 && metrics.scroll <= metrics.client + 1,
      `Overflow on ${name}: ${JSON.stringify(metrics)}`
    )
    record.checks.push(name)
    ;(record.metrics ??= {})[name] = metrics
    if (capture) await shot(name)
    if (!is55 && name === 'workbuddyAccount') await contrast(button(scope, '电脑版登录'), record)
  }
  async function overlay(name, trigger, expected) {
    await trigger.click()
    const dialog = page.getByRole('dialog', { name: expected, exact: typeof expected === 'string' })
    await inspect(name, dialog)
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'detached' })
  }
  async function phoneRoute(parent, name, trigger, inside, shotName = name) {
    const row =
      typeof trigger === 'string'
        ? front(page, parent).locator(trigger)
        : button(front(page, parent), trigger)
    await row.click()
    const scope = front(page, name)
    await inspect(shotName, scope)
    assert.equal(await page.locator('[data-settings-route]:not([inert])').count(), 1)
    if (inside) await inside(scope)
    await button(scope, '返回').click()
    await scope.waitFor({ state: 'detached' })
    await front(page, parent).waitFor()
    assert.ok(
      await row.evaluate(
        (el) => el === document.activeElement || el.contains(document.activeElement)
      ),
      `Return focus missing: ${parent}→${name}`
    )
  }
  const location = (scope) =>
    scope
      .locator('input,button')
      .count()
      .then((count) => assert.ok(count >= 2))
  const memories = (scope) => overlay('memory-editor', button(scope, /添加.*记忆/), /记忆/)
  async function nativeAccount(scope) {
    const called = await page.evaluate(() => v56QA.calls.filter((c) => c === 'dsh:account').length)
    await scope.locator('[data-dsh-account]').click()
    assert.equal(
      await page.evaluate(() => v56QA.calls.filter((c) => c === 'dsh:account').length),
      called + 1
    )
    record.checks.push('DSH native account handoff')
  }
  if (phone) {
    const root = front(page, 'root')
    await inspect('home', root)
    for (const title of ['语言', 'DeepSeek 朗读音色', '检查更新', '帮助与反馈']) {
      await overlay(title, button(root, new RegExp(title)), title)
    }
    await overlay('home-usage', root.locator('[data-usage-home-entry]'), '模型用量')
    await phoneRoute('root', 'fontSize', /^字体大小/)
    if (is55)
      await phoneRoute('root', 'profile', /^账号资料/, () =>
        phoneRoute('profile', 'location', /^位置信息/, location)
      )
    else await phoneRoute('root', 'location', /^位置信息/, location)
    await nativeAccount(root)
    await phoneRoute('root', 'workbuddyAccount', '[data-wb-account-entry]')
    await phoneRoute('root', 'apiKey', /^API Key 管理/, async (scope) => {
      await phoneRoute('apiKey', 'guide', /^申请官方 API Key/)
      await phoneRoute('apiKey', 'apiEdit', /^添加 API Key/, undefined, 'api-add')
      await phoneRoute('apiKey', 'apiEdit', /^编辑/, undefined, 'api-edit')
      await overlay('api-usage', scope.locator('[data-api-usage-entry]'), '模型用量')
    })
    await phoneRoute('root', 'contextModels', '[data-context-settings-entry]')
    await phoneRoute('root', 'data', /^数据管理/, async () => {
      await phoneRoute('data', 'webdav', /WebDAV/)
      await phoneRoute('data', 'compacted', /^已压缩的对话/)
    })
    await phoneRoute('root', 'security', /^安全与应用锁/)
    await phoneRoute('root', 'memory', /^记忆/, memories)
    await button(root, '返回').click()
    await root.waitFor({ state: 'detached' })
    return
  }
  const expected = [
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
  const tabs = page.getByRole('tablist').getByRole('tab')
  assert.deepEqual(
    await tabs.evaluateAll((items) => items.map((el) => el.dataset.settingsTab)),
    expected
  )
  for (const name of expected) {
    const tab = page.locator(`[data-settings-tab="${name}"]`)
    await tab.click()
    assert.equal(await tab.getAttribute('aria-selected'), 'true')
    await inspect(name, panel)
    if (name === 'account') {
      await nativeAccount(panel)
      await overlay('workbuddyAccount', panel.locator('[data-wb-account-entry]'), /WorkBuddy/)
    } else if (name === 'apiKey')
      await overlay('api-usage', panel.locator('[data-api-usage-entry]'), '模型用量')
    else if (name === 'data') await overlay('delete-confirm', button(panel, '删除'), /清空历史/)
    else if (name === 'memory') await memories(panel)
    else if (name === 'about') {
      await overlay('update', panel.locator('[data-update-entry]'), '检查更新')
      await overlay('help', button(panel, /查看帮助/), '帮助与反馈')
    }
    assert.equal(await tab.getAttribute('aria-selected'), 'true')
  }
  await page.keyboard.press('Escape')
  await page.getByRole('tablist').waitFor({ state: 'detached' })
}
try {
  await Promise.all(
    [320, 390, 1280].flatMap((width) =>
      ['dark', 'light'].map((theme) =>
        run.visit(width, theme, 'routes', accountsFixture, routeMatrix)
      )
    )
  )
} finally {
  await run.finish()
}
