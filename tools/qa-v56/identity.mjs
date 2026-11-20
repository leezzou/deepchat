import assert from 'node:assert/strict'
import { runner, button, front, openSettings } from './browser.mjs'
import { accountsFixture } from './accounts-fixture.mjs'

const run = await runner(process.argv.slice(2))
async function identities({ page, phone, record, shot, version }) {
  const side = page.locator('[data-sidebar-identity]:visible')
  const account = phone ? front(page, 'root') : page.getByRole('tabpanel')
  const update = (d, w) => page.evaluate(([d, w]) => v56QA.update(d, w), [d, w])
  async function drawer() {
    await page.locator('textarea:visible').first().waitFor()
    const settings = button(page, '设置')
    if (!(await settings.isVisible())) await button(page, /^打开边栏/).click()
    await settings.waitFor()
  }
  async function verifyAvatar(entry, profile) {
    const image = entry.locator('img')
    if (!profile?.avatar) {
      await image.waitFor({ state: 'detached' })
      assert.ok((await entry.locator('svg').count()) >= 1)
      return
    }
    await image.waitFor()
    assert.equal(await image.getAttribute('src'), profile.avatar)
    assert.ok(
      await image.evaluate(async (img) => {
        await img.decode()
        return img.naturalWidth > 0
      }),
      'Avatar loads'
    )
  }
  async function sidebar(key) {
    await drawer()
    const profile = key ? await page.evaluate((k) => v56QA.profiles[k], key) : null
    const expected = profile?.name || '账号'
    await side.getByText(expected, { exact: true }).waitFor()
    await verifyAvatar(side, profile)
    record.checks.push(
      `sidebar ${key || 'guest'}: ${expected}, ${profile?.avatar ? 'decoded image' : 'fallback'}`
    )
  }
  async function enter() {
    await side.click()
    await account.locator('[data-dsh-account]').waitFor()
    if (!phone)
      assert.equal(
        await page.locator('[data-settings-tab=account]').getAttribute('aria-selected'),
        'true'
      )
  }
  const leave = async () => {
    await page.keyboard.press('Escape')
    await account.waitFor({ state: 'detached' })
  }
  const choice = (id) => account.locator(`[data-identity-choice=${id}]`)
  async function rows(d, w, chosen) {
    for (const [id, selector] of [
      [d, '[data-dsh-account]'],
      [w, '[data-wb-account-entry]'],
    ]) {
      const entry = account.locator(selector)
      const profile = id ? await page.evaluate((k) => v56QA.profiles[k], id) : null
      if (profile) await entry.getByText(profile.name, { exact: true }).waitFor()
      else assert.match(await entry.innerText(), /登录/)
      await verifyAvatar(entry, profile)
    }
    const radios = account.locator('[data-identity-choice]')
    if (d && w) {
      assert.equal(await radios.count(), 2)
      assert.ok(await choice(chosen).isChecked())
    } else assert.equal(await radios.count(), 0)
    record.checks.push(`account rows ${d || '–'} / ${w || '–'}, selector ${chosen || 'hidden'}`)
  }
  async function chatSource(value) {
    const trigger = button(account, '聊天使用')
    await trigger.click()
    await page.locator(`[role=option][data-option-value=${value}]`).click()
    await page.waitForFunction(
      (value) => localStorage.getItem('chat-demo:chat-source') === value,
      value
    )
  }
  const source = () => page.evaluate(() => localStorage.getItem('chat-demo:chat-source'))
  const pic = async (name) => {
    if (
      (record.width === 390 && record.theme === 'dark') ||
      (record.width === 1280 && record.theme === 'light')
    )
      await shot(name)
  }
  if (version === '1.0.55') {
    await update('d1', 'w1')
    await drawer()
    await pic('dual-sidebar')
    await openSettings(page)
    if (!phone) await page.locator('[data-settings-tab=account]').click()
    await pic('dual-accounts')
    await account.locator('[data-wb-account-entry]').click()
    await page.locator('[data-wb-account-page]').waitFor()
    await pic('wb-signed-in')
    record.checks.push('v55 dual-account scenes')
    return
  }
  await sidebar(null)
  await enter()
  await rows(null, null)
  await pic('guest-account')
  await leave()
  await update('d1', null)
  await sidebar('d1')
  await enter()
  await rows('d1', null)
  await leave()
  await update(null, 'w1')
  await sidebar('w1')
  await enter()
  await rows(null, 'w1')
  await leave()
  await update('d1', 'w1')
  await sidebar('d1')
  await pic('dual-sidebar')
  await enter()
  await rows('d1', 'w1', 'dsh')
  await pic('dual-accounts')
  await chatSource('workbuddy')
  assert.ok(await choice('dsh').isChecked())
  record.checks.push('chat via WorkBuddy, identity DSH retained')
  await chatSource('api')
  await choice('workbuddy').check()
  assert.equal(await source(), 'api')
  await leave()
  await sidebar('w1')
  await page.reload()
  await sidebar('w1')
  await enter()
  await rows('d1', 'w1', 'workbuddy')
  assert.equal(await source(), 'api')
  record.checks.push('reload retained independent API routing and WB identity')
  await chatSource('account')
  assert.ok(await choice('workbuddy').isChecked())
  await leave()
  await sidebar('w1')
  await update('d2', 'w2')
  await sidebar('w2')
  await enter()
  await rows('d2', 'w2', 'workbuddy')
  await leave()
  await update('d2', 'w1')
  await sidebar('w1')
  await enter()
  await account.locator('[data-wb-account-entry]').click()
  const wb = page.locator('[data-wb-account-page]')
  await wb.waitFor()
  await pic('wb-signed-in')
  await button(wb, /退出/).click()
  const confirm = page.getByRole('dialog', { name: /退出.*WorkBuddy|WorkBuddy.*退出/ })
  if (await confirm.isVisible())
    await button(confirm, /退出/)
      .last()
      .click()
  await page.waitForFunction(() => v56QA.state.w === null)
  await page.keyboard.press('Escape')
  await wb.waitFor({ state: 'detached' })
  await rows('d2', null)
  await leave()
  await sidebar('d2')
  assert.equal(await source(), 'account')
  record.checks.push('WB sign-out → DSH fallback, routing retained')
  await update(null, null)
  await sidebar(null)
  await enter()
  await rows(null, null)
  await leave()
  await update('d1', 'w1')
  await sidebar('w1')
  await enter()
  await rows('d1', 'w1', 'workbuddy')
  await choice('dsh').check()
  await leave()
  await sidebar('d1')
  await update(null, 'w1')
  await sidebar('w1')
  await enter()
  await rows(null, 'w1')
  await leave()
  await page.reload()
  await sidebar('w1')
  record.checks.push('DSH signed-out status → WB fallback also on reload')
}
try {
  await Promise.all(
    [320, 390, 1280].flatMap((w) =>
      ['light', 'dark'].map((t) => run.visit(w, t, 'identities', accountsFixture, identities))
    )
  )
} finally {
  await run.finish()
}
