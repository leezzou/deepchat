import assert from 'node:assert/strict'

export async function modePanel({ page, check, shot }, { choose, eventually }) {
  const target = 'https://openrouter.ai/api/v1'
  const flash = 'deepseek/deepseek-v4.1-flash-1017'
  const pinned = '~openai/gpt-astra-latest'
  const key = 'qa-session-panel-fixture'
  const profiles = [
    { id: 'panel-official', name: 'QA Flash', providerId: 'deepseek', origin: 'https://api.deepseek.com', protocol: 'deepseek', model: 'deepseek-flash', apiKey: 'qa-official-fixture' },
    { id: 'panel-router', name: 'QA Router', providerId: 'openrouter', origin: target, protocol: 'openai', model: 'private-default', apiKey: key },
  ]
  const sent = []
  await page.route(target + '/models/user**', async route => {
    const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization', 'Access-Control-Allow-Methods': 'GET' }
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers })
    assert.equal(route.request().headers().authorization, 'Bearer ' + key)
    sent.push(route.request().method())
    return route.fulfill({ headers, json: { data: [{ id: flash, context_length: 131072 }, { id: pinned, name: 'Testing exact tilde', context_length: 64000 }, { id: 'private-default', max_tokens: 1000 }] } })
  })
  await page.evaluate(profiles => {
    localStorage.setItem('chat-demo:api-profiles', JSON.stringify(profiles))
    localStorage.setItem('chat-demo:active-profile', profiles[0].id)
    localStorage.setItem('chat-demo:chat-source', 'api')
  }, profiles)
  await page.reload()
  const trigger = page.getByRole('button', { name: /会话模型与模板/ }).first()
  await trigger.click()
  const scope = page.getByRole('dialog', { name: '会话模型与模板' })
  await choose(page, scope, '服务方案', 'QA Router')
  const field = scope.getByRole('textbox', { name: '模型', exact: true })
  await eventually(async () => (await field.inputValue()) === flash, 'server confirmed Flash version mapping')
  check(sent.length === 1, 'Switch fetches the selected profile with only its own credential')
  check(await scope.getByRole('button', { name: '确认切换' }).isEnabled(), 'Switch keeps the history destination confirmation')
  await scope.getByRole('button', { name: '使用方案默认模型' }).click()
  check(await field.inputValue() === 'private-default', 'Explicit default uses the new profile default instead of carried model')
  await choose(page, scope, '服务方案', 'QA Flash')
  await choose(page, scope, '服务方案', 'QA Router')
  await scope.getByRole('button', { name: '使用方案默认模型' }).click()
  await eventually(() => sent.length === 2, 'deployment discovery after default reset')
  await scope.getByTestId('model-picker-browse').click()
  await scope.getByTestId('model-picker-search').fill('testing exact tilde')
  await scope.locator(`[data-model-id="${pinned}"]`).waitFor()
  check(await field.inputValue() === 'private-default', 'Late discovery respects a route default explicitly selected before the fetch')
  await scope.getByTestId('model-picker-browse').click()
  await scope.getByTestId('model-picker-browse').click()
  await scope.getByTestId('model-picker-search').fill('testing exact tilde')
  await scope.locator(`[data-model-id="${pinned}"]`).click()
  check(await field.inputValue() === pinned, 'Search selects the exact endpoint model ID, including its leading tilde')
  check(!await scope.getByTestId('model-picker-search').count(), 'Selecting closes search and dismisses its editing focus')
  check(await scope.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'Sheet content fits without horizontal overflow')
  await shot('selected-exact-model')
  await scope.getByRole('button', { name: '确认切换' }).click()
  await scope.waitFor({ state: 'hidden' })
  const saved = await page.evaluate(() => ({ data: JSON.parse(localStorage.getItem('chat-demo:conversation-modes:v1')), active: localStorage.getItem('chat-demo:active-profile') }))
  check(saved.data.draft.model === pinned && saved.data.draft.profileId === 'panel-router', 'Applying pins the draft to the exact provider and wire ID')
  check(saved.active === 'panel-official', 'Session actions preserve the global default profile')
  await trigger.click()
  check(await field.inputValue() === pinned, 'Reopening restores the selected model')
  await scope.getByRole('button', { name: '取消' }).click()
  await scope.waitFor({ state: 'hidden' })
  await page.evaluate(() => {
    const storage = 'chat-demo:conversation-modes:v1'
    const data = JSON.parse(localStorage.getItem(storage))
    data.destinations = [[null, 'review']]
    localStorage.setItem(storage, JSON.stringify(data))
  })
  await page.reload()
  const before = sent.length
  await trigger.click()
  const review = scope.getByRole('button', { name: '从这个方案获取模型' })
  await review.waitFor()
  await page.waitForTimeout(1100) // Exceed the automatic discovery debounce.
  check(sent.length === before, 'An unreviewed restored destination waits for explicit discovery approval')
  await review.click()
  await eventually(() => sent.length > before, 'explicit discovery on reviewed profile')
  await scope.getByRole('button', { name: '取消' }).click()
  const approvals = await page.evaluate(() => JSON.parse(localStorage.getItem('chat-demo:conversation-modes:v1')).destinations)
  check(approvals.some(([id, value]) => id === null && value === 'review'), 'Browsing the model list does not approve sending the conversation history')
}
