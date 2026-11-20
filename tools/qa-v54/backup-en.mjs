// Exercise real completions before reloading with the second language. Nothing in the
// test opens an uninitialized database or races the app's first schema upgrade.
export async function backupEnglish({ page, phone, motion, check, result }) {
  const composer = page.locator('textarea:visible').first()
  for (let round = 1; round <= 9; round++) {
    await composer.fill(`备份测试 ${round}`)
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await page.waitForFunction(n => window.qa.calls.filter(call => call.op === 'chat').length === n, round)
    const reply = `已完成 ${round}`
    await page.evaluate(text => {
      const id = window.qa.calls.filter(call => call.op === 'chat').at(-1).id
      window.qa.header(id); window.qa.text(id, text); window.qa.finish(id)
    }, reply)
    await page.locator('[data-message-id]').last().getByText(reply, { exact: true }).waitFor()
  }
  await page.waitForFunction(async () => (await window.qa.store('chat-demo-backups', 'preferences', 'settings'))?.completedRounds === 9)
  await page.evaluate(() => localStorage.setItem('chat-demo:locale', 'en-US'))
  await page.reload()
  await page.waitForFunction(() => document.documentElement.lang === 'en-US')
  await composer.fill('Archive this round on this device')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await page.waitForFunction(() => window.qa.calls.some(c => c.op === 'chat'))
  await composer.fill('draft')
  await composer.focus()
  await page.evaluate(() => {
    const id = window.qa.calls.find(c => c.op === 'chat').id
    window.qa.header(id); window.qa.text(id, 'Round complete'); window.qa.finish(id)
  })
  const toast = page.getByRole('status').filter({ hasText: 'Backed up on this device. Turn off in Settings → Data → Local automatic backup.' })
  await toast.waitFor()
  const ui = await toast.evaluate(el => ({ pointerEvents: getComputedStyle(el).pointerEvents,
    animation: getComputedStyle(el).animationName, live: el.getAttribute('aria-live'), atomic: el.getAttribute('aria-atomic'),
    actions: el.querySelectorAll('button, a, input, [tabindex]').length }))
  check(ui.pointerEvents === 'none' && !ui.actions && ui.live === 'polite' && ui.atomic === 'true', 'English notice is a polite atomic live region with no focus or hit targets')
  check((ui.animation === 'none') === (motion === 'reduce'), 'Toast motion follows the real reduced-motion preference')
  await toast.waitFor({ state: 'hidden', timeout: 9000 })
  check(await composer.evaluate(el => document.activeElement === el && el.value === 'draft'), 'Toast disappears automatically while typing focus and the draft survive')
  const openData = async mobile => {
    const entry = page.getByRole('button', { name: 'Settings', exact: true })
    const sidebar = page.getByRole('button', { name: /^Open sidebar/i })
    await entry.or(sidebar).first().waitFor()
    if (!await entry.isVisible()) await sidebar.click()
    await entry.click()
    await page.getByRole(mobile ? 'button' : 'tab', { name: 'Data', exact: true }).click()
  }
  await openData(phone)
  const toggle = page.getByRole('switch', { name: 'Local automatic backup', exact: true })
  await toggle.uncheck()
  await page.waitForFunction(async () => (await window.qa.store('chat-demo-backups', 'preferences', 'settings')).autoEnabled === false)
  // Enter the other actual settings surface and ensure it reflects the same persistent preference.
  // A touch screen up to 1600px uses tablet settings. Emulate a mouse when the
  // same browser profile changes to desktop, as well as changing its viewport.
  const inputDevice = await page.context().newCDPSession(page)
  await inputDevice.send('Emulation.setTouchEmulationEnabled', { enabled: !phone })
  await page.setViewportSize(phone ? { width: 1280, height: 900 } : { width: 390, height: 844 })
  await page.reload()
  await page.waitForFunction(coarse => matchMedia('(pointer: coarse)').matches === coarse, !phone)
  await openData(!phone)
  check(!await toggle.isChecked(), 'English setting persists when switching between mobile and desktop entry points')
  const remove = page.getByRole('button', { name: 'Delete local automatic backup', exact: true })
  await remove.click()
  await page.getByRole('group', { name: /Delete the local automatic copy/ }).getByRole('button', { name: 'Cancel' }).click()
  check(await remove.evaluate(el => document.activeElement === el), 'Cancel restores focus to Delete local automatic backup')
  check(!!await page.evaluate(() => window.qa.store('chat-demo-backups', 'artifacts', 'automatic')), 'Cancel retains the real ZIP')
  result.englishBackupToast = ui
}
