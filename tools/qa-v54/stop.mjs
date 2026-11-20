export async function stop({ page, phone, check, shot, result }, { send, call, activeMessage, eventually }) {
  const text = '可以从九溪出发。'
  await send(page, '杭州周末徒步路线')
  const request = await call(page, 'chat', 0)
  await page.evaluate(({ id, text }) => {
    window.qa.header(id)
    window.qa.text(id, text)
  }, { id: request.id, text })
  const row = activeMessage(page)
  await row.getByText(text, { exact: true }).waitFor()
  const glyph = page.locator('svg[data-stop-glyph]')
  const sizes = await glyph.evaluate(svg => {
    const button = svg.closest('button')
    const square = svg.querySelector('rect')
    const bounds = button.getBoundingClientRect()
    const painted = square.getBoundingClientRect()
    const rules = getComputedStyle(button)
    return {
      hit: bounds.width,
      hitHeight: bounds.height,
      disk: bounds.width - parseFloat(rules.borderLeftWidth) - parseFloat(rules.borderRightWidth),
      glyph: painted.width,
      glyphHeight: painted.height,
      corner: Number(square.getAttribute('rx')),
      label: button.getAttribute('aria-label'),
    }
  })
  const ratio = sizes.glyph / sizes.disk
  check(Math.abs(ratio - 0.3) < 0.005 && sizes.glyph === sizes.glyphHeight && sizes.corner > 0 && sizes.corner < 5,
    'Stop mark is a small rounded square measuring 30% of the painted disk')
  if (phone) check(sizes.hit === 48 && sizes.hitHeight === 48, 'Mobile stop control has a 48×48 CSS-pixel touch target')
  await shot('streaming-stop', true)
  await glyph.locator('..').click()
  await row.locator('[data-message-actions]').waitFor()
  await eventually(() => page.evaluate(async text => {
    const messages = (await window.qa.store('chat-demo', 'sessions'))[0]?.messages || []
    return messages.some(m => m.status === 'stopped' && m.blocks.some(b => b.text === text))
  }, text), 'stopped response preserves partial text')
  check((await call(page, 'cancel', 0)).id === request.id && await glyph.count() === 0,
    'Clicking Stop cancels the active transport and leaves the saved partial reply visible')
  await send(page, '再说两句')
  await call(page, 'chat', 1)
  await glyph.locator('..').click()
  await row.getByText(/无法从此处续写，可重新生成回答/).waitFor()
  check(await row.getByRole('button', { name: '继续生成' }).count() === 0,
    'Stopping before any answer offers regeneration and explains the unavailable continuation')
  await row.getByRole('button', { name: '重新生成' }).click()
  const regenerated = await call(page, 'chat', 2)
  await page.evaluate(id => {
    window.qa.header(id)
    window.qa.text(id, '第一段。')
    window.qa.finish(id, 'length')
  }, regenerated.id)
  await row.getByRole('button', { name: '继续生成' }).click()
  const continued = await call(page, 'chat', 3)
  check(continued.model === regenerated.model && continued.messages.some(m => m.role === 'assistant' && m.content.includes('第一段。')),
    'Continue keeps the selected model and includes its actual partial answer')
  await page.evaluate(id => {
    window.qa.header(id)
    window.qa.text(id, '第二段。')
    window.qa.finish(id)
  }, continued.id)
  await row.locator('[data-message-actions]').waitFor()
  await eventually(() => page.evaluate(async () => {
    const messages = (await window.qa.store('chat-demo', 'sessions'))[0]?.messages || []
    return messages.some(m => m.status === 'done' && m.blocks?.filter(b => b.type === 'text').map(b => b.text).join('') === '第一段。第二段。')
  }), 'continued answer persists as a single completed message')
  check(await row.getByRole('button', { name: '继续生成' }).count() === 0,
    'The real continuation appends its text and clears the Continue control after completion')
  result.stop = { ...sizes, ratio }
}
