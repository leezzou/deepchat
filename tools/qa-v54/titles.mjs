// Exercise the visible title before the first byte, the real history editor and v53-shaped history.
export async function titles(
  { page, phone, check, shot, result },
  { send, call, answer, eventually, activeMessage }
) {
  const chinese = '杭州周末徒步路线',
    english = 'Plan a weekend hike in Hangzhou',
    custom = '周末徒步记录'
  const header = page.locator('main header:visible').first()
  const sidebar = async () => {
    if (phone) await page.getByRole('button', { name: /^打开边栏/ }).click()
  }
  const row = (title) => page.getByRole('button', { name: title, exact: true })
  const open = async (title) => {
    await sidebar()
    await row(title).click()
  }
  const committed = async (title) =>
    page.evaluate(async (title) => {
      const full = await window.qa.store('chat-demo', 'sessions'),
        index = await window.qa.store('chat-demo', 'sessionSummaries')
      return full.some(
        (s) =>
          s.title === title &&
          s.messages.some((m) => m.role === 'assistant' && m.status === 'done') &&
          index.some((i) => i.id === s.id && i.title === title)
      )
    }, title)
  async function firstTurn(question, reply, index) {
    await send(page, question)
    const chat = await call(page, 'chat', index)
    await header.getByText(question, { exact: true }).waitFor()
    check(
      chat.model === 'deepseek-v4.1-flash',
      'Immediate local title appears on the WorkBuddy conversation before answer bytes'
    )
    await answer(page, chat.id, reply)
    await activeMessage(page).getByText(reply, { exact: true }).waitFor()
    await eventually(
      () => committed(question),
      'session and history contain completed conversation with local title'
    )
    await sidebar()
    await row(question).waitFor()
    check(
      (await row(question).getAttribute('aria-current')) === 'page',
      'History and mobile or desktop header show the same active title'
    )
  }
  await firstTurn(chinese, '从九溪出发。', 0)
  check(await page.evaluate(() => window.qa.calls.filter(c => c.op === 'chat').length === 1), 'Short Chinese prompt generates no extra model call')
  if (!phone) await row(chinese).hover()
  await row(chinese).locator('..').getByRole('button', { name: '更多' }).click()
  await page.getByRole('menuitem', { name: '重命名' }).click()
  const field = page.getByRole('textbox', { name: '重命名' })
  await field.fill(custom)
  await field.press('Enter')
  await row(custom).waitFor()
  if (phone) await row(custom).click()
  await header.getByText(custom, { exact: true }).waitFor()
  await eventually(() => committed(custom), 'manual rename persisted')
  await page.reload()
  await open(custom)
  await header.getByText(custom, { exact: true }).waitFor()
  check(true, 'Manual rename survives refresh in both header and history')
  await page.getByRole('button', { name: '开启新对话', exact: true }).first().click()
  await firstTurn(english, 'A day hike is a good starting point.', 0)
  check(
    await page.evaluate(() => window.qa.calls.filter((c) => c.op === 'chat').length === 1),
    'Short English prompt generates no extra model call'
  )
  await shot('english-history')
  // Turn a real completed record into the old format while preserving full messages and IDs.
  await page.evaluate(async (english) => {
    const chats = await window.qa.store('chat-demo', 'sessions'),
      s = chats.find((s) => s.title === english)
    const summaries = await window.qa.store('chat-demo', 'sessionSummaries'),
      summary = summaries.find((x) => x.id === s.id)
    const db = await new Promise((ok, fail) => {
      const r = indexedDB.open('chat-demo')
      r.onsuccess = () => ok(r.result)
      r.onerror = () => fail(r.error)
    })
    try {
      const tx = db.transaction(['sessions', 'sessionSummaries'], 'readwrite')
      for (const [store, record] of [
        ['sessions', s],
        ['sessionSummaries', summary],
      ]) {
        record.title = '新对话'
        delete record.titleSource
        delete record.titleOrigin
        tx.objectStore(store).put(record)
      }
      await new Promise((ok, fail) => {
        tx.oncomplete = ok
        tx.onerror = () => fail(tx.error)
      })
    } finally {
      db.close()
    }
  }, english)
  await page.reload()
  await sidebar()
  await row('新对话').or(row(english)).first().click()
  await header.getByText(english, { exact: true }).waitFor()
  await eventually(() => committed(english), 'repair legacy title in full record and summary')
  check(
    await page.evaluate(
      () => !window.qa.calls.some((c) => ['chat', 'search', 'read'].includes(c.op))
    ),
    'Opening historical 新对话 locally repairs its real topic with zero model calls'
  )
  await page.evaluate(async () => {
    const finite = document.getAnimations().filter(a => Number.isFinite(a.effect?.getComputedTiming().endTime))
    await Promise.allSettled(finite.map(a => a.finished))
  })
  await shot('repaired-header', true)
  result.titles = { chinese, english, manual: custom }
}
