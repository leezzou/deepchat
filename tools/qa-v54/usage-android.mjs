// The production JS bridge uploads a byte stream to the profile selected in settings.
// This fixture supplies the Android side and keeps its traffic separate from window.fetch.
export function installUsageAndroid({ base, native }) {
  const requests = new Map()
  const cancels = []
  const deliver = (id, fields) => window.DeepChatProfile.onmessage({ data: JSON.stringify({ id, ...fields }) })
  const bytes = value => btoa(String.fromCharCode(...new TextEncoder().encode(value)))
  window.DshNative = {
    postMessage(raw) {
      if (JSON.parse(raw).op !== 'status') throw Error('Unexpected signed-out account traffic')
      queueMicrotask(() => window.DshNative.onmessage({ data: JSON.stringify({ type: 'account', signedIn: false }) }))
    },
  }
  window.DeepChatProfile = {
    async postMessage(raw) {
      const frame = JSON.parse(raw)
      const id = frame.id
      if (frame.op === 'start') {
        if (raw.includes('qa-usage')) throw Error('Unexpected raw profile credential in bridge frame')
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('qa-usage'))
        const expected = Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('')
        if (frame.origin !== base || frame.digest !== expected || !frame.profileId || frame.operation !== (native ? 'messages' : 'chat')) throw Error('Profile bridge route or credential reference mismatch')
        requests.set(id, { start: frame, offset: 0, parts: [] })
        deliver(id, { type: 'pull', offset: 0, length: Math.min(frame.length, 49152) })
        return
      }
      if (frame.op === 'cancel') {
        cancels.push(id)
        return
      }
      const request = requests.get(id)
      if (!request || frame.op !== 'chunk' || frame.offset !== request.offset) throw Error('Profile bridge chunk or offset mismatch')
      const part = Uint8Array.from(atob(frame.data), c => c.charCodeAt(0))
      request.parts.push(part)
      request.offset += part.byteLength
      if (request.offset !== request.start.length) {
        deliver(id, { type: 'pull', offset: request.offset, length: Math.min(request.start.length - request.offset, 49152) })
        return
      }
      const body = JSON.parse(await new Blob(request.parts).text())
      const { start } = request
      const entry = window.usageFixture.register(body, { id, profileId: start.profileId, protocol: start.protocol, operation: start.operation, transport: 'Android profile port' })
      entry.emit = text => deliver(id, { type: 'data', data: bytes(text) })
      entry.end = () => deliver(id, { type: 'end' })
      deliver(id, { type: 'headers', status: 200, contentType: 'text/event-stream' })
    },
  }
  window.qaUsageCancelled = cancels
}
