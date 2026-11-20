// Reuse a real completed conversation. Add the single property v53 wrote to a successful reply.
export async function restoreHistoricalThinking({ page, phone, check, shot }, eventually) {
  await eventually(
    () =>
      page.evaluate(async () => {
        const chats = await window.qa.store('chat-demo', 'sessions')
        return chats.some(
          (chat) =>
            chat.messages.filter((m) => m.role === 'assistant' && m.status === 'done').length === 2
        )
      }),
    'two complete replies committed'
  )
  const history = await page.evaluate(async () => {
    const [session] = await window.qa.store('chat-demo', 'sessions')
    const answers = session.messages.filter((m) => m.role === 'assistant')
    const plain = answers[0]
    if (
      plain.error ||
      plain.workBuddyReasoningUnavailable ||
      plain.blocks.some((b) => b.type === 'thinking')
    )
      throw Error('New plain answer contains a failure or stale flag')
    if (!answers[1].blocks.some((b) => b.type === 'thinking' && b.thinking.trim()))
      throw Error('Missing persisted reasoning')
    plain.workBuddyReasoningUnavailable = true
    // Set an unambiguous visible title in the original session and its sidebar summary.
    session.title = 'QA 历史思考兼容'
    const [summary] = await window.qa.store('chat-demo', 'sessionSummaries')
    summary.title = session.title
    const request = indexedDB.open('chat-demo')
    const db = await new Promise((ok, fail) => {
      request.onsuccess = () => ok(request.result)
      request.onerror = () => fail(request.error)
    })
    try {
      const tx = db.transaction(['sessions', 'sessionSummaries'], 'readwrite')
      tx.objectStore('sessions').put(session)
      tx.objectStore('sessionSummaries').put(summary)
      await new Promise((ok, fail) => {
        tx.oncomplete = ok
        tx.onerror = () => fail(tx.error)
      })
    } finally {
      db.close()
    }
    return { plain: plain.id, reasoning: answers[1].id, title: session.title }
  })
  await page.reload()
  if (phone) await page.getByRole('button', { name: /^打开边栏/ }).click()
  await page.getByRole('button', { name: history.title, exact: true }).click()
  const plain = page.locator(`[data-message-id="${history.plain}"]`)
  const reasoning = page.locator(`[data-message-id="${history.reasoning}"]`)
  await plain.getByText('普通文字回答', { exact: true }).waitFor()
  const warning = '[class*="notice"] > svg,[role=alert],[data-reply-thinking]'
  check(
    (await plain.locator(warning).count()) === 0 &&
      !/思考|推理|失败|错误/.test(await plain.innerText()),
    'v53 history flag keeps ordinary answer without a red failure notice or thinking label'
  )
  const header = reasoning.locator('[data-reply-thinking]')
  await header.waitFor()
  check(/思考/.test(await header.innerText()), 'Reloaded real reasoning retains its explicit label')
  if ((await header.getAttribute('aria-expanded')) === 'false') await header.click()
  await reasoning.getByText('先对照两组观测值。', { exact: true }).waitFor()
  await shot('historical-replies')
}
