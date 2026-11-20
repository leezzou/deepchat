import assert from 'node:assert/strict'

// Exercise the same native status and catalog frames used by Android, without a personal account.
export async function workBuddyRates({ page, check, shot }, { openWorkBuddySettings }) {
  const base = 'deepseek-v4.1-flash'
  const active = 'qa-priced'
  const unknown = 'qa-unpriced'
  const revA = '00000000-0000-4000-8000-000000000054'
  const revB = '00000000-0000-4000-8000-000000000055'
  const rows = (rate) => [
    { id: base, name: 'Flash', rate: { multiplier: 0 } },
    { id: active, name: 'Pro', rate: { multiplier: rate } },
    { id: unknown, name: 'Preview' },
  ]
  await page.evaluate(
    ({ revA, base, rows }) => {
      const f = (window.qaRates = {
        revision: revA,
        model: base,
        catalog: rows,
        next: rows,
        updated: 0,
        stale: true,
        error: false,
        wait: false,
        requests: [],
        pending: null,
      })
      const frame = (id) =>
        window.WorkBuddyChat.onmessage({
          data: JSON.stringify({
            id,
            type: 'status',
            name: 'Fixture',
            revision: f.revision,
            model: f.model,
            catalog: f.catalog,
            catalogUpdatedAt: f.updated,
            catalogError: f.error,
            catalogStale: f.stale,
            catalogRefresh: false,
          }),
        })
      const original = window.WorkBuddyChat.postMessage
      window.WorkBuddyChat.postMessage = (raw) => {
        const c = JSON.parse(raw)
        if (!['status', 'model', 'catalog'].includes(c.op)) return original(raw)
        f.requests.push(c)
        if (c.op === 'catalog') {
          if (c.revision !== f.revision) throw Error('Wrong account during refresh')
          if (f.wait) {
            f.pending = c
            return
          }
          f.stale = f.error
          if (!f.error) {
            f.updated = Date.now()
            f.catalog = f.next
          }
        }
        if (c.op === 'model') f.model = c.model
        queueMicrotask(() => frame(c.id))
      }
      window.dispatchEvent(new Event('online'))
    },
    { revA, base, rows: rows(0.29) }
  )
  const button = (scope, name) => scope.getByRole('button', { name, exact: true })
  const trigger = page.getByRole('button', { name: /会话模型与模板/ }).first()
  const panel = page.getByRole('dialog', { name: '会话模型与模板' })
  const chat = button(panel, '模型')
  const menu = page.getByRole('listbox', { name: '模型', exact: true })
  const option = (scope, id) => scope.locator(`[data-option-value="${id}"]`)
  const refresh = async (scope, catalog, error = false) => {
    await page.evaluate(
      ({ catalog, error }) => Object.assign(window.qaRates, { next: catalog, error }),
      { catalog, error }
    )
    await button(scope, '刷新费率').click()
  }
  await trigger.click()
  await panel.getByText(/上次同步/).waitFor()
  await chat.click()
  assert.equal(await menu.getByRole('option').count(), 3)
  for (const [id, label] of [
    [base, '免费'],
    [active, '0.29× 腾讯积分'],
    [unknown, /^(?:未提供费率|费率未知)$/u],
  ]) {
    await option(menu, id).getByText(label, { exact: true }).waitFor()
  }
  check(
    await menu.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    'Rate labels fit the responsive model list'
  )
  await shot('conversation-options')
  await page.evaluate((latest) => {
    Object.assign(window.qaRates, { catalog: latest, updated: Date.now() })
    window.dispatchEvent(new Event('online'))
  }, rows(0.4))
  await option(menu, active).getByText('0.4× 腾讯积分').waitFor()
  check(
    (await option(menu, base).getAttribute('aria-selected')) === 'true',
    'An open list updates prices without changing its selected ID'
  )
  await option(menu, active).click()
  await chat.getByText('0.4× 腾讯积分').waitFor()
  await button(panel, '应用到会话').click()
  await panel.waitFor({ state: 'detached' })
  assert.equal(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem('chat-demo:conversation-modes:v1')).draft.model
    ),
    active
  )
  await trigger.click()
  await refresh(panel, rows(1.5))
  await chat.getByText('1.5× 腾讯积分').waitFor()
  await refresh(panel, rows(0))
  await chat.getByText('免费').waitFor()
  await refresh(panel, rows(0.5))
  await chat.getByText('0.5× 腾讯积分').waitFor()
  await refresh(panel, null, true)
  await panel.getByText(/刷新失败/).waitFor()
  await chat.getByText('缓存').waitFor()
  check(
    (await chat.innerText()).includes('0.5×'),
    'Failed sync preserves the last observed price and flags it as cached'
  )
  await refresh(
    panel,
    rows(0.5).filter((r) => r.id !== active)
  )
  await chat.getByText(`${active} · 当前不可选`).waitFor()
  check(
    await button(panel, '应用到会话').isDisabled(),
    'Removed selected model remains visible and cannot be applied'
  )
  assert.equal(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem('chat-demo:conversation-modes:v1')).draft.model
    ),
    active
  )
  await button(panel, '取消').click()
  await openWorkBuddySettings(page)
  const account = page.locator('[data-wb-account-page]')
  const accountModel = button(account, 'WorkBuddy 模型')
  await refresh(account, rows(0.75))
  await accountModel.click()
  const accountMenu = page.getByRole('listbox', { name: 'WorkBuddy 模型' })
  await option(accountMenu, active).getByText('0.75× 腾讯积分').waitFor()
  await shot('settings-options')
  await option(accountMenu, active).click()
  await accountModel.getByText('0.75× 腾讯积分').waitFor()
  const choices = await page.evaluate(() => window.qaRates.requests.filter((r) => r.op === 'model'))
  check(
    choices.length === 1 && choices[0].model === active && choices[0].revision === revA,
    'Only an explicit account selection writes the selected ID to its native account'
  )
  // Simulate an outstanding catalog request from account A when returning from account B sign-in.
  await page.evaluate(() => {
    window.qaRates.wait = true
  })
  await button(account, '刷新费率').click()
  await page.waitForFunction(() => window.qaRates.pending !== null)
  const accountB = [{ id: active, name: 'Pro', rate: { multiplier: 3 } }]
  await page.evaluate(
    ({ revB, accountB }) => {
      Object.assign(window.qaRates, {
        revision: revB,
        next: accountB,
        catalog: accountB,
        updated: Date.now(),
        wait: false,
      })
      window.dispatchEvent(new Event('online'))
    },
    { revB, accountB }
  )
  await accountModel.getByText('3× 腾讯积分').waitFor()
  await page.evaluate(
    ({ revA, base, rows }) => {
      window.WorkBuddyChat.onmessage({
        data: JSON.stringify({
          type: 'status',
          id: window.qaRates.pending.id,
          model: base,
          revision: revA,
          catalog: rows,
          catalogUpdatedAt: Date.now(),
        }),
      })
    },
    { revA, base, rows: rows(0.75) }
  )
  await accountModel.click()
  check(
    (await accountMenu.getByRole('option').count()) === 1 &&
      (await accountMenu.innerText()).includes('3× 腾讯积分'),
    'Late refresh A cannot overwrite B’s selected model, price, or available list'
  )
  await option(accountMenu, active).click()
  check(
    await account.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    'Account settings fit the viewport'
  )
}
