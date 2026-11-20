import { runner, openSettings, button, front } from './browser.mjs'
const run = await runner(process.argv.slice(2))
async function pictures({ page, phone, shot, record, version }) {
  await openSettings(page)
  await shot('home')
  const root = phone ? front(page, 'root') : page
  const sections = [
    phone && version !== '1.0.55'
      ? ['location', /^位置信息/, 'account']
      : ['profile', /^账号资料/, 'account'],
    ['apiKey', /^API Key 管理/, 'apiKey'],
    ['contextModels', '[data-context-settings-entry]', 'contextModels'],
    ['data', /^数据管理/, 'data'],
    ['security', /^安全与应用锁/, 'security'],
    ['memory', /^记忆/, 'memory'],
  ]
  for (const [name, mobile, desktop] of sections) {
    const opener = phone
      ? typeof mobile === 'string'
        ? root.locator(mobile)
        : button(root, mobile)
      : page.locator(`[data-settings-tab="${desktop}"]`)
    await opener.click()
    const route = phone ? front(page, name) : page.getByRole('tabpanel')
    await route.waitFor()
    await shot(name)
    record.checks.push(name)
    if (phone) {
      await page.keyboard.press('Escape')
      await root.waitFor()
    }
  }
}
try {
  await Promise.all(
    [320, 390, 1280].flatMap((w) =>
      ['light', 'dark'].map((t) => run.visit(w, t, 'settings', undefined, pictures))
    )
  )
} finally {
  await run.finish()
}
