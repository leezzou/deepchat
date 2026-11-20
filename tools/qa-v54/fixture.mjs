// Installed into a fresh Playwright context. Only the WorkBuddy native port is simulated.
// All UI, request adaptation, streaming, backup ZIP generation and IndexedDB use the app's code.
export function installFixture() {
  const accountModels = [
    'deepseek-v4.1-flash',
    'deepseek-v4-pro',
    'deepseek-v4-flash',
    'qa-workbuddy-added',
  ]
  const catalog = accountModels.map((id) => ({
    id,
    name: id === 'qa-workbuddy-added' ? '联调用账号型号' : id,
    contextWindow: id === 'qa-workbuddy-added' ? 96000 : 1000000,
    reasoning: true,
  }))
  let model = sessionStorage.getItem('qa-active-model') || accountModels[0]
  const revision = '00000000-0000-4000-8000-000000000054'
  if (!sessionStorage.getItem('qa-v54-init')) {
    sessionStorage.setItem('qa-v54-init', 'yes')
    for (const [key, value] of Object.entries({
      locale: 'zh-CN',
      'chat-source': 'workbuddy',
      search: 'false',
      thinking: 'true',
      'workbuddy-route:v1': JSON.stringify({ model, revision }),
    })) {
      localStorage.setItem('chat-demo:' + key, value)
    }
  }
  const calls = []
  const frame = (id, fields) =>
    window.WorkBuddyChat.onmessage({ data: JSON.stringify({ id, ...fields }) })
  const bytes = (text) =>
    btoa(Array.from(new TextEncoder().encode(text), (byte) => String.fromCharCode(byte)).join(''))
  const send = (id, text) => frame(id, { type: 'data', data: bytes(text) })
  const row = (id, delta, reason) =>
    send(
      id,
      'data: ' + JSON.stringify({ choices: [{ delta, finish_reason: reason ?? null }] }) + '\n\n'
    )
  window.qa = {
    calls,
    header(id) {
      frame(id, { type: 'headers', status: 200, contentType: 'text/event-stream' })
    },
    think(id, text) {
      row(id, { reasoning_content: text })
    },
    text(id, text) {
      row(id, { content: text })
    },
    finish(id, reason = 'stop') {
      row(id, {}, reason)
      send(id, 'data: [DONE]\n\n')
      frame(id, { type: 'end' })
    },
    sources(id, results) {
      frame(id, { type: 'headers', status: 200, contentType: 'application/json' })
      send(id, JSON.stringify({ results }))
      frame(id, { type: 'end' })
    },
    page(id, text) {
      frame(id, { type: 'headers', status: 200, contentType: 'application/json' })
      send(id, JSON.stringify({ text }))
      frame(id, { type: 'end' })
    },
    async store(dbName, store, key) {
      const open = indexedDB.open(dbName)
      const db = await new Promise((ok, fail) => {
        open.onsuccess = () => ok(open.result)
        open.onerror = () => fail(open.error)
      })
      try {
        const request =
          key === undefined
            ? db.transaction(store).objectStore(store).getAll()
            : db.transaction(store).objectStore(store).get(key)
        return await new Promise((ok, fail) => {
          request.onsuccess = () => ok(request.result)
          request.onerror = () => fail(request.error)
        })
      } finally {
        db.close()
      }
    },
  }
  window.WorkBuddyChat = {
    postMessage(raw) {
      const call = JSON.parse(raw)
      calls.push(call)
      if (['status', 'catalog', 'model'].includes(call.op)) {
        if (call.op === 'model') {
          if (!accountModels.includes(call.model)) throw Error('Unlisted synthetic account model')
          model = call.model
          sessionStorage.setItem('qa-active-model', model)
        }
        queueMicrotask(() =>
          frame(call.id, { type: 'status', model, revision, catalog, name: '离线测试账户' })
        )
      } else if (!['chat', 'search', 'cancel', 'read'].includes(call.op))
        throw Error('Unexpected mock operation ' + call.op)
    },
  }
}
