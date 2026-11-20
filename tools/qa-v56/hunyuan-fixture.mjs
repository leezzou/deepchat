// Only replace Android's WorkBuddy port. The APK's own JavaScript renders the picker,
// routes the request, parses streamed bytes and writes conversation/usage records.
export function installHunyuanPort() {
  const revision = '00000000-0000-4000-8000-000000000056'
  const initial = 'deepseek-v4-pro'
  const catalog = [
    ['hy3', 'Hy3', 0], ['hy3-x', 'Hy3', 0.05],
    ['hy4-preview', 'Hy4 preview', 0.29], ['hy4-preview-x', 'Hy4 preview', 0.29],
    ['hy3-preview', 'Hy3 preview'], ['hunyuan-chat', 'Hunyuan-Turbos'],
    ['hy4-flash', 'Hy4 flash'], ['hy4', 'Hy4'], ['hy4std', 'Hy4'],
    ['hy4flash', 'Hy4 flash'], ['hy4flash-free', 'Hy4 flash Free'],
    ['deepseek-v4-pro', 'DeepSeek-V4-Pro'], ['glm-5.3', 'GLM-5.3'], ['kimi-k3-2', 'Kimi-K3'],
  ].map(([id, name, multiplier]) => ({ id, name, reasoning: true,
    ...(multiplier !== undefined && { rate: { multiplier } }),
  }))
  localStorage.setItem('chat-demo:chat-source', 'workbuddy')
  localStorage.setItem('chat-demo:workbuddy-route:v1', JSON.stringify({ model: initial, revision }))
  localStorage.setItem('chat-demo:search', 'false')
  localStorage.setItem('chat-demo:thinking', 'true')
  const calls = []
  let model = initial
  const frame = (id, fields) => window.WorkBuddyChat.onmessage({ data: JSON.stringify({ id, ...fields }) })
  window.WorkBuddyChat = {
    postMessage(raw) {
      const call = JSON.parse(raw)
      calls.push(call)
      if (['status', 'catalog', 'model', 'profile'].includes(call.op)) {
        if (call.op === 'model') model = call.model
        queueMicrotask(() => frame(call.id, { type: 'status', model, revision, catalog,
          name: '离线测试账户', catalogUpdatedAt: Date.now(), catalogRefresh: false }))
      } else if (!['search', 'read', 'chat', 'cancel'].includes(call.op)) {
        throw Error(`Unexpected WorkBuddy operation ${call.op}`)
      }
    },
  }
  window.hunyuanFixture = {
    calls,
    respond(id, events, originModel) {
      frame(id, { type: 'headers', status: 200, contentType: 'text/event-stream', originModel })
      const raw = new TextEncoder().encode(events.map(event => typeof event === 'string'
        ? `data: ${event}\r\n\r\n` : `data: ${JSON.stringify(event)}\r\n\r\n`).join(''))
      // Split in the middle of event delimiters, JSON and multi-byte Unicode.
      for (let offset = 0; offset < raw.length; offset += 13) {
        frame(id, { type: 'data', data: btoa(String.fromCharCode(...raw.slice(offset, offset + 13))) })
      }
      frame(id, { type: 'end' })
    },
    async receipts() {
      const result = request => new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      const db = await result(indexedDB.open('deepchat-usage'))
      try { return await result(db.transaction('requests').objectStore('requests').getAll()) }
      finally { db.close() }
    },
  }
}
