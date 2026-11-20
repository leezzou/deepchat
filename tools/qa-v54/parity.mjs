// Only the remote transport is synthetic. The production app consumes real, paced SSE bytes.
const canonical = 'deepseek-v4-pro'
const official = 'https://api.deepseek.com'
const profiles = {
  workbuddy: null,
  messages: { origin: official, protocol: 'deepseek', model: canonical, providerId: 'deepseek' },
  completions: { origin: official, protocol: 'openai', model: canonical, providerId: 'deepseek' },
  openrouter: { origin: 'https://openrouter.ai/api/v1', protocol: 'openai', model: `deepseek/${canonical}`, providerId: 'openrouter' },
}
const topic = '杭州周末徒步路线'
const reasoning = '先比较步行距离。'
const source = { url: 'https://trails.example.test/jiuxi', title: '九溪步道资料' }

function installTransport({ endpoint, kind }) {
  const original = window.fetch.bind(window)
  const requests = []
  window.qaWire = {
    requests,
    write(text) { requests.at(-1).controller.enqueue(new TextEncoder().encode(text)) },
    end() { requests.at(-1).controller.close() },
  }
  window.fetch = (url, options) => {
    if (String(url) !== endpoint) return original(url, options)
    if (options.method !== 'POST') throw Error('Unexpected request method')
    const headers = new Headers(options.headers)
    const authorized = kind === 'messages'
      ? headers.get('x-api-key') === 'qa-parity'
      : headers.get('authorization') === 'Bearer qa-parity'
    if (!authorized) throw Error('Unexpected synthetic profile authorization')
    const request = { body: JSON.parse(options.body) }
    requests.push(request)
    const stream = new ReadableStream({ start(controller) { request.controller = controller } })
    return Promise.resolve(new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }))
  }
}

function nativeEvent(type, fields) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`
}
function chatEvent(delta, finish = null) {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
}
function nativeBlock(index, type, text, cited = false) {
  const field = type === 'text' ? 'text' : 'thinking'
  const start = nativeEvent('content_block_start', { index, content_block: { type, [field]: '' } })
  const part = nativeEvent('content_block_delta', { index, delta: { type: `${type}_delta`, [field]: text } })
  const cite = cited ? nativeEvent('content_block_delta', { index, delta: { type: 'citations_delta', citation: {
    type: 'web_search_result_location', ...source, cited_text: text, encrypted_index: '',
  } } }) : ''
  return start + part + cite + nativeEvent('content_block_stop', { index })
}

export async function parity(kind, { page, check, shot, result }, { send, call, eventually, activeMessage }) {
  const profile = profiles[kind]
  const model = profile?.model || canonical
  await page.evaluate(({ profile, model }) => {
    sessionStorage.setItem('qa-active-model', model)
    localStorage.setItem('chat-demo:workbuddy-route:v1', JSON.stringify({ model, revision: '00000000-0000-4000-8000-000000000054' }))
    if (profile) {
      localStorage.setItem('chat-demo:api-profiles', JSON.stringify([{ ...profile, id: 'qa-parity', name: 'QA provider', apiKey: 'qa-parity' }]))
      localStorage.setItem('chat-demo:active-profile', 'qa-parity')
      localStorage.setItem('chat-demo:chat-source', 'api')
    }
  }, { profile, model })
  if (profile) await page.addInitScript(installTransport, {
    endpoint: profile.origin + (kind === 'messages' ? '/anthropic/v1/messages' : '/chat/completions'), kind,
  })
  await page.reload()
  const toggle = page.getByRole('button', { name: '深度思考', exact: true })
  const row = activeMessage(page)
  const actions = row.locator('[data-message-actions]')
  await toggle.waitFor()
  check(await toggle.isEnabled(), `${kind}: thinking is available for the selected DeepSeek V4 Pro`)
  const write = bytes => page.evaluate(bytes => window.qaWire.write(bytes), bytes)
  const events = []

  async function committed(index) {
    const read = () => page.evaluate(async n => {
      const sessions = await window.qa.store('chat-demo', 'sessions')
      return sessions[0]?.messages.filter(m => m.role === 'assistant')[n]
    }, index)
    await eventually(async () => ['done', 'error', 'stopped'].includes((await read())?.status), 'settled reply persisted')
    return read()
  }

  async function round(question, text, { think = false, early = false, cited = false } = {}) {
    const index = events.length
    const wanted = await toggle.getAttribute('aria-pressed') === 'true'
    await send(page, question)
    let body
    if (profile) {
      await eventually(() => page.evaluate(n => window.qaWire.requests.length > n, index), `${kind} outbound request`)
      body = await page.evaluate(n => window.qaWire.requests[n].body, index)
      if (kind === 'messages') await write(nativeEvent('message_start', {
        message: { id: `qa-${index}`, model, role: 'assistant', content: [], usage: { input_tokens: 15, output_tokens: 0 } },
      }))
    } else {
      body = await call(page, 'chat', index)
      await page.evaluate(id => window.qa.header(id), body.id)
    }
    check(body.model === model, `${kind}: selected deployment receives the request`)
    const enabled = kind === 'workbuddy' ? body.thinking : kind === 'openrouter' ? body.reasoning?.enabled :
      { enabled: true, disabled: false }[body.thinking?.type]
    check(enabled === wanted, `${kind}: outgoing payload matches the visible thinking preference`)
    if (index === 0) {
      await page.locator('main header:visible').first().getByText(topic, { exact: true }).waitFor()
      check(true, `${kind}: conversation header shows the first question before reply bytes`)
    }
    if (think) {
      if (!profile) await page.evaluate(({ id, reasoning }) => window.qa.think(id, reasoning), { id: body.id, reasoning })
      else if (kind === 'messages') await write(nativeBlock(0, 'thinking', reasoning))
      else await write(chatEvent(kind === 'openrouter' ? { reasoning } : { reasoning_content: reasoning }))
      if (wanted) {
        await row.getByText(reasoning, { exact: true }).waitFor()
        check(await row.locator('[data-reply-thinking]').getAttribute('aria-expanded') === 'true', `${kind}: real streaming reasoning starts expanded`)
      }
    }
    if (!profile) await page.evaluate(({ id, text }) => window.qa.text(id, text), { id: body.id, text })
    else if (kind === 'messages') await write(nativeBlock(think ? 1 : 0, 'text', text, cited))
    else await write(chatEvent({ content: text, ...(cited && { annotations: [{ type: 'url_citation', url_citation: source }] }) }))
    await row.getByText(text, { exact: true }).waitFor()
    if (!profile) {
      await page.evaluate(({ id, early }) => {
        if (early) window.WorkBuddyChat.onmessage({ data: JSON.stringify({ id, type: 'end' }) })
        else window.qa.finish(id)
      }, { id: body.id, early })
    } else if (early) {
      await page.evaluate(() => window.qaWire.end())
    } else if (kind === 'messages') {
      await write(nativeEvent('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } }) + nativeEvent('message_stop', {}))
    } else {
      await write(chatEvent({}, 'stop') + 'data: [DONE]\n\n')
    }
    await actions.waitFor()
    const data = await committed(index)
    const controls = await actions.locator('button').evaluateAll(els => els.map(el => el.getAttribute('aria-label') || el.innerText))
    events.push({ question, model: body.model, thinking: enabled, status: data.status, actions: controls })
    check(data.blocks.some(b => b.type === 'text' && b.text === text), `${kind}: history retains the exact answer`)
    if (early) {
      check(data.status === 'error' && !!data.error, `${kind}: premature EOF is marked as an interrupted answer`)
      return body
    }
    check(data.status === 'done' && !data.error && await row.locator('[class*=notice] > svg').count() === 0, `${kind}: completed reply has no error notice`)
    if (think && wanted) {
      const marker = row.locator('[data-reply-thinking]')
      await marker.click()
      await row.getByText(reasoning, { exact: true }).waitFor()
    } else {
      check(await row.locator('[data-reply-thinking]').count() === 0 && !data.blocks.some(b => b.type === 'thinking' && b.thinking.trim()), `${kind}: plain or disabled reasoning has no marker or stored reasoning text`)
    }
    if (cited) {
      await row.locator('.ds-markdown-cite[role=link]').waitFor()
      check(data.blocks.some(b => b.citations?.some(c => c.url === source.url && c.title === source.title)), `${kind}: inline marker retains the upstream source URL and title`)
    }
    return body
  }

  await round(topic, '从九溪出发。')
  await round('比较步行距离', '步行约两公里。', { think: true })
  await shot('real-thinking')
  await toggle.click()
  check(await toggle.getAttribute('aria-pressed') === 'false', `${kind}: user can turn reasoning off`)
  await round('简要回答', '可以步行前往。', { think: true })
  await round('继续说明', '保留这段回答。', { early: true })
  check(['复制', '分享', '消息操作', '删除消息', '重新生成'].every(action => events[0].actions.includes(action)), `${kind}: completed answer exposes all common message actions`)
  if (kind === 'messages') await round('引自何处', '公开步道资料。', { cited: true })
  if (kind === 'openrouter') {
    const usedBeforeConsent = await page.evaluate(() => window.qaWire.requests.some(request => request.body.plugins?.length > 0))
    check(!usedBeforeConsent, 'OpenRouter receives no paid search request before consent')
    await page.getByRole('button', { name: '智能搜索', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByText(/Exa/).waitFor()
    await dialog.getByRole('button', { name: '开启搜索', exact: true }).click()
    const searched = await round('引自何处', '公开步道资料。', { cited: true })
    check(searched.plugins?.some(plugin => plugin.id === 'web'), 'OpenRouter receives its web plugin only after explicit consent')
    await row.locator('[data-search-sources]').click()
    await page.locator(`aside a[href="${source.url}"]:visible`).waitFor()
    await shot('sources')
  }
  result.parity = { canonical, deployment: model, events }
}
