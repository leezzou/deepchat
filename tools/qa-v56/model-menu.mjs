import assert from 'node:assert/strict'
import { button, runner } from './browser.mjs'
import { composerGeometry } from './visual-checks.mjs'

const run = await runner(process.argv.slice(2))
async function modelMenu({ page, record, shot, version }) {
  await page.locator('textarea:visible').first().waitFor()
  if (version === '1.0.55') {
    await shot('closed')
    record.checks.push('v55 composer comparison')
    return
  }
  const trigger = page.locator('[data-model-menu-trigger]')
  const menu = page.locator('[data-quick-model-menu]')
  const selected = menu.getByRole('option', { selected: true })
  await trigger.waitFor()
  await shot('closed')
  const original = await trigger.getAttribute('aria-label')
  if (record.width === 1280) {
    await trigger.focus()
    await page.keyboard.press('ArrowDown')
    await selected.waitFor()
    await page.waitForFunction(() => document.activeElement?.matches('[data-quick-model-menu] [role=option][aria-selected=true]'))
    await page.keyboard.press('Escape')
    await menu.waitFor({ state: 'detached' })
    assert.ok(await trigger.evaluate(el => el === document.activeElement), 'Escape returns focus to the model trigger')
    record.checks.push('Keyboard open focuses selected option; Escape restores trigger focus')
  }
  await trigger.click()
  await selected.waitFor()
  assert.equal(await selected.count(), 1)
  assert.ok((await selected.locator('svg').count()) > 0)
  const next = menu.getByRole('option', { selected: false }).first()
  const model = await next.getAttribute('data-model-id')
  assert.ok(model)
  const bounds = await menu.evaluate((el) => {
    const visible = (node) => {
      const r = node.getBoundingClientRect()
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return {
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
        centerVisible: node.contains(hit),
      }
    }
    const buttons = Array.from(el.querySelectorAll('button'))
    return {
      viewport: [innerWidth, innerHeight],
      panel: visible(el),
      actions: buttons.map(visible),
    }
  })
  for (const item of [bounds.panel, ...bounds.actions]) {
    assert.ok(
      item.left >= -1 &&
        item.top >= -1 &&
        item.right <= bounds.viewport[0] + 1 &&
        item.bottom <= bounds.viewport[1] + 1 &&
        item.centerVisible,
      `Model control clipped/covered ${JSON.stringify(item)}`
    )
  }
  record.geometry = bounds
  await shot('open')
  await next.click()
  await menu.waitFor({ state: 'detached' })
  assert.notEqual(await trigger.getAttribute('aria-label'), original)
  await trigger.click()
  await selected.waitFor()
  assert.equal(await selected.getAttribute('data-model-id'), model)
  assert.equal(await selected.count(), 1)
  assert.ok((await selected.locator('svg').count()) > 0)
  await shot('changed')
  await button(menu, '服务方案与模板').click()
  await menu.waitFor({ state: 'detached' })
  const advanced = page.getByRole('dialog')
  await advanced.waitFor()
  assert.ok((await advanced.innerText()).length > 10)
  await page.keyboard.press('Escape')
  await advanced.waitFor({ state: 'detached' })
  record.closed = await composerGeometry(trigger)
  const text = page.getByRole('textbox', { name: '消息', exact: true })
  await text.fill('模型复核 🧪 模型 QA')
  record.draft = await composerGeometry(trigger)
  assert.ok(await button(page, '发送').isEnabled())
  if (record.width === 320) await shot('draft')
  await text.fill('')
  record.checks.push(
    'Composer with Chinese and emoji draft and enabled Send fits',
    'Closed composer targets distinct and current model readable',
    'Composer trigger and all menu actions inside viewport',
    'One initial selected row with visible mark',
    `Selection changed to ${model}, composer and reopened menu agree`,
    'Advanced selection opens and returns'
  )
}
try {
  await Promise.all(
    [320, 390, 1280].flatMap((w) =>
      ['light', 'dark'].map((t) => run.visit(w, t, 'model-menu', undefined, modelMenu))
    )
  )
} finally {
  await run.finish()
}
