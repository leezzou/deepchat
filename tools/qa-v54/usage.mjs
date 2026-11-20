import assert from 'node:assert/strict'
import { installUsageAndroid } from './usage-android.mjs'

export const usageRoutes = {
  claude: { label: 'Anthropic Claude', base: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-5', native: true },
  gpt: { label: 'OpenAI', base: 'https://api.openai.com/v1', model: 'gpt-4.1' },
  proxy: { label: '自定义（OpenAI 兼容）', base: 'https://usage-proxy.example.test/v1', model: 'qa-private-deployment' },
  silicon: { label: '硅基流动 SiliconFlow', base: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V3' },
  local: { label: 'Ollama（本机）', base: 'http://localhost:11434/v1', model: 'qa-local-deployment', local: true },
}

function installUsageFixture({ base, model, native, local }) {
  const original = window.fetch.bind(window)
  const log = []
  const targetUrl = base + (native ? '/messages' : '/chat/completions')
  function register(body, fields) {
    if (body.model !== model || !body.stream) throw Error('Unexpected wire model or stream type')
    if (native && (!Number.isInteger(body.max_tokens) || body.max_tokens <= 0 || body.title || body.safety_check)) throw Error('Claude native Messages request contains an invalid field or token limit')
    const request = { target: targetUrl, model: body.model, includeUsage: body.stream_options?.include_usage, thinking: body.thinking, reasoning: body.reasoning, ...fields }
    log.push(request)
    return request
  }
  window.usageFixture = {
    log, register,
    emit(bytes) { log.at(-1).emit(bytes) },
    end() { log.at(-1).end?.() },
  }
  window.fetch = (url, init) => {
    const target = String(url)
    if (target !== base + (native ? '/messages' : '/chat/completions')) return original(url, init)
    const headers = new Headers(init.headers)
    if (native && (!headers.get('anthropic-version') || headers.get('x-api-key') !== 'qa-usage')) throw Error('Claude Messages headers')
    if (!native && headers.get('authorization') !== (local ? null : 'Bearer qa-usage')) throw Error('Compatible authorization headers')
    const request = register(JSON.parse(init.body), { transport: 'fetch' })
    return Promise.resolve(new Response(new ReadableStream({start(controller) {
      request.emit = value => controller.enqueue(new TextEncoder().encode(value))
    }}), {headers: {'Content-Type': 'text/event-stream'}}))
  }
}

const event = (type, fields) => `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`
const chunk = fields => `data: ${JSON.stringify(fields)}\n\n`
async function emitAnswer(page, route, text, counts, finish = 'stop') {
  let start, end = ''
  if (route.native) {
    const usage = counts ? { input_tokens: counts.input, cache_read_input_tokens: counts.read, cache_creation_input_tokens: counts.write } : undefined
    start = event('message_start', { message: { id: 'qa-native', model: route.model, type: 'message', role: 'assistant', content: [], usage } }) +
      event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) +
      event('content_block_delta', { index: 0, delta: { type: 'text_delta', text } })
    if (finish) end = event('content_block_stop', { index: 0 }) + event('message_delta', {
      delta: { stop_reason: finish === 'length' ? 'max_tokens' : 'end_turn', stop_sequence: null },
      ...(counts && { usage: { output_tokens: counts.output } }),
    }) + event('message_stop', {})
  } else {
    start = chunk({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })
    const includeUsage = await page.evaluate(() => window.usageFixture.log.at(-1).includeUsage === true)
    const usage = counts && includeUsage ? {
      prompt_tokens: counts.input + (counts.read || 0) + (counts.write || 0), completion_tokens: counts.output,
      ...(counts.read !== undefined && { prompt_tokens_details: { cached_tokens: counts.read } }),
      ...(counts.outputHit !== undefined && { completion_tokens_details: { cached_tokens: counts.outputHit } }),
    } : undefined
    if (finish) end = chunk({ choices: [{ index: 0, delta: {}, finish_reason: finish }] }) + (usage ? chunk({ choices: [], usage }) : '') + 'data: [DONE]\n\n'
  }
  await page.evaluate(bytes => window.usageFixture.emit(bytes), start)
  if (end) await page.evaluate(bytes => { window.usageFixture.emit(bytes); window.usageFixture.end() }, end)
}

export async function usage(kind, { page, phone, check, shot, result }, { settings, choose, send, activeMessage, eventually }) {
  const route = usageRoutes[kind]
  const actualSize = page.viewportSize()
  if (!phone) await page.setViewportSize({ width: 390, height: 844 }) // The full profile editor is available through mobile settings.
  const androidBridge = process.env.QA_ANDROID_ACCOUNT_BRIDGE === '1'
  if (androidBridge) await page.addInitScript(installUsageAndroid, route)
  await page.addInitScript(installUsageFixture, route)
  await page.route(url => url.origin === new URL(route.base).origin, async intercepted => {
    const url = new URL(intercepted.request().url())
    const models = url.pathname.endsWith('/models') || url.pathname === '/api/tags'
    if (!models) return intercepted.abort()
    return intercepted.fulfill({json: {data: [{ id: route.model, type: 'model' }], models: [{ name: route.model, model: route.model }]}})
  })
  await page.reload()
  await settings(page)
  await page.locator('[data-usage-home-entry]').click()
  const blank = page.getByRole('dialog').filter({ has: page.locator('[data-api-usage]') })
  await blank.locator('[data-usage-trend]').getByRole('status').waitFor()
  check(await blank.locator('[data-usage-total], [data-usage-series]').count() === 0, 'The empty usage chart displays guidance before any key or chat is configured')
  await blank.getByRole('button', { name: '返回', exact: true }).click()
  await page.getByRole('button', { name: /API Key 管理/ }).click()
  await page.getByRole('button', { name: '添加 API Key', exact: true }).click()
  const front = page.locator('[data-settings-route][data-route-position="front"]').last()
  await choose(page, front, '服务商', route.label)
  if (kind === 'proxy') await page.locator('#api-profile-origin').fill(route.base)
  await page.locator('#api-profile-name').fill('QA ' + route.label)
  if (await page.locator('#api-profile-model').inputValue() !== route.model) await page.locator('#api-profile-model').fill(route.model)
  if (!route.local) await page.locator('#api-profile-key').fill('qa-usage')
  await page.getByRole('button', { name: '保存并启用', exact: true }).click()
  await page.getByRole('button', { name: '添加 API Key', exact: true }).waitFor()
  await page.reload()
  await settings(page)
  await choose(page, front, '聊天使用', 'API Key')
  await page.setViewportSize(actualSize)
  await page.reload()
  const row = activeMessage(page)
  const waitCall = n => eventually(() => page.evaluate(n => window.usageFixture.log.length === n, n), `Usage request ${n}`)
  const completed = () => row.locator('[data-message-actions]').waitFor()
  // Change only the displayed browser date. Fetch, IndexedDB and animation timers still run normally.
  const today = new Date()
  today.setHours(12, 0, 0, 0)
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  await page.clock.setFixedTime(yesterday)
  await send(page, '九溪步行路线')
  await waitCall(1)
  const write = route.native ? 2 : 0
  await emitAnswer(page, route, '先到九溪。', { input: 80, read: 20, write, output: 14, ...(kind === 'proxy' && { outputHit: 7 }) }, 'length')
  await page.clock.setFixedTime(today)
  await row.getByRole('button', { name: '继续生成' }).click()
  await waitCall(2)
  await emitAnswer(page, route, '再到梅家坞。', { input: 51, read: 0, write: 0, output: 7 })
  await completed()
  await send(page, '再说一点')
  await waitCall(3)
  await emitAnswer(page, route, '第三段。', null, null)
  await row.getByText('第三段。', { exact: true }).waitFor()
  await page.getByRole('button', { name: '停止生成' }).click()
  await completed()
  await send(page, '还有吗')
  await waitCall(4)
  await emitAnswer(page, route, '最后一段。', null)
  await completed()
  await settings(page)
  if (phone) await page.locator('[data-settings-group="models"] [data-usage-home-entry]').click()
  else {
    await page.getByRole('tab', { name: '模型与用量', exact: true }).click()
    await page.locator('[data-api-usage-entry]').click()
  }
  const report = page.locator('[data-api-usage]:visible')
  await report.locator('[data-usage-loaded]').waitFor()
  await report.locator('[data-usage-requests] > summary').click()
  const rows = report.locator('[data-usage-row]')
  await eventually(async () => (await rows.count()) === 4, 'four real dispatches appear in usage report')
  const records = []
  for (const item of await rows.all()) {
    await item.locator(':scope > summary').click()
    const data = await item.evaluate(el => ({
      provider: el.dataset.provider, model: el.dataset.model, purpose: el.dataset.purpose, status: el.dataset.status,
      fields: Object.fromEntries([...el.querySelectorAll('[data-usage-metric]')].map(m => [m.dataset.usageMetric, m.dataset.value])),
      visible: el.innerText,
    }))
    check(data.model === route.model && Boolean(data.provider), 'Usage identifies the dispatched provider and exact deployment')
    records.push(data)
  }
  const partial = records.find(r => r.purpose === 'chat' && r.fields.output === '14')
  const continuation = records.find(r => r.purpose === 'continue')
  const stopped = records.find(r => r.status === 'stopped')
  const absent = records.find(r => r.purpose === 'chat' && r.status === 'done' && r.fields.input === 'missing')
  check(partial?.fields.input === String(100 + write) && partial.fields.inputHit === '20', 'The truncated request retains its own cache-inclusive input and output')
  check(continuation?.fields.input === '51' && continuation.fields.output === '7' && continuation.fields.inputHit === '0' && continuation.fields.inputRate === '0', 'Continuation has its own receipt and reports the upstream zero cache hit')
  if (kind === 'proxy') check(partial.fields.outputHit === '7' && partial.fields.outputRate === '50', 'The compatible proxy reports seven cached output tokens and a 50% output hit rate')
  check(stopped?.fields.input === 'missing' && stopped.fields.output === 'missing', 'Stopped request without counts retains its status and missing metrics')
  check(absent?.fields.output === 'missing' && absent.fields.inputHit === 'missing' && absent.fields.outputHit === 'missing' && absent.visible.includes('未提供'), 'Missing usage is explicitly distinguished from a real zero')
  assert.equal(new Set(records.map(r => r.provider)).size, 1)
  const network = await page.evaluate(() => window.usageFixture.log.map(({ emit, end, ...request }) => request))
  const expectedTransport = androidBridge && !route.local ? 'Android profile port' : 'fetch'
  check(network.every(request => request.transport === expectedTransport), `Every dispatch uses ${expectedTransport}`)
  if (expectedTransport === 'Android profile port') {
    const cancelled = await page.evaluate(() => window.qaUsageCancelled)
    check(cancelled.includes(network[2].id), 'Stopping the response cancels its matching native profile request')
  }
  if (kind === 'gpt' || kind === 'proxy') check(network.every(request => !request.thinking && !request.reasoning), 'Ordinary GPT and unknown custom deployments omit unsupported reasoning controls')
  check(network.length === records.length, 'Every real chat or continuation dispatch corresponds to one detail row')
  if (!route.native) check(network.every(request => request.includeUsage === true), 'Every Chat Completions dispatch explicitly requests streamed usage counters')
  const expectedProviders = kind === 'proxy' ? [new URL(route.base).hostname, route.label] : [route.label]
  check(expectedProviders.includes(records[0].provider), 'The recorded provider matches the configured deployment')
  await shot('request-details')
  const trend = report.locator('[data-usage-trend]')
  const buckets = await trend.locator('[data-usage-bucket]').evaluateAll(elements => elements.filter(el => Number(el.dataset.requests) > 0).map(el => ({
    requests: Number(el.dataset.requests),
    input: el.querySelector('[data-usage-series="input"]')?.dataset.value,
    output: el.querySelector('[data-usage-series="output"]')?.dataset.value,
  })))
  assert.deepEqual(buckets, [{ requests: 1, input: String(100 + write), output: '14' }, { requests: 3, input: '51', output: '7' }])
  check(true, 'Daily chart preserves independent dispatch dates, counts and reported input/output')
  await trend.scrollIntoViewIfNeeded()
  await shot('daily-trend')
  const cache = async direction => report.locator(`[data-cache-chart="${direction}"]`).evaluate(el => ({ rate: el.dataset.rate, hits: el.dataset.hits, base: el.dataset.base, paired: el.dataset.paired }))
  const inputCache = await cache('input')
  const outputCache = await cache('output')
  check(inputCache.hits === '20' && inputCache.base === String(151 + write) && inputCache.paired === '2', 'Input cache chart uses only reported pairs in the denominator')
  check(kind === 'proxy' ? outputCache.rate === '50' && outputCache.base === '14' : outputCache.rate === 'missing', 'Output cache chart distinguishes reported hits from missing evidence')
  await report.locator('[data-usage-days="1"]').click()
  check((await cache('input')).rate === '0' && (await cache('output')).rate === 'missing', 'Today shows zero input hit rate and unreported output hit rate')
  await report.locator('[data-usage-days="all"]').click()
  await report.locator(`[data-usage-rank="provider"][data-rank-id="${records[0].provider}"]`).click()
  await report.locator(`[data-usage-rank="model"][data-rank-id="${route.model}"]`).click()
  const summary = report.locator('[data-usage-summary]')
  const metrics = await summary.locator('[data-usage-metric]').evaluateAll(elements => Object.fromEntries(elements.map(el => [el.dataset.usageMetric, el.dataset.value])))
  check(metrics.input === String(151 + write) && metrics.output === '21' && metrics.inputHit === '20', 'All-time provider and model filters keep the correct known totals')
  result.usage = { provider: records[0].provider, network, records, totals: metrics }
  await shot('filtered-summary')
}
