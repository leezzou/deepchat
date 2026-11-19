// Offline browser regression. Node 22.13+, tools' Playwright and an installed Chrome.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { chromium } from 'playwright'

const js = stripTypeScriptTypes(await readFile(new URL('../chat-demo/src/shell/account.ts', import.meta.url), 'utf8'))
const browser = await chromium.launch({ channel: 'chrome' })
try {
  const page = await browser.newPage({ serviceWorkers: 'block' })
  await page.route('**/*', route => {
    switch (route.request().url()) {
      case 'https://localhost/': return route.fulfill({ contentType: 'text/html', body: '<!doctype html>' })
      case 'https://localhost/account.js': return route.fulfill({ contentType: 'text/javascript', body: js })
      default: return route.abort()
    }
  })
  await page.goto('https://localhost/')
  const result = await page.evaluate(async () => {
    const check = (condition, reason) => { if (!condition) throw new Error(reason) }
    const outbox = []
    let wake
    window.DshNative = { postMessage(message) { outbox.push(JSON.parse(message)); wake?.() } }
    async function next(op) {
      if (!outbox.length) {
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${op}`)), 10000)
          wake = () => { clearTimeout(timeout); resolve() }
        })
        wake = null
      }
      const msg = outbox.shift()
      check(msg?.op === op, `Expected ${op}, received ${msg?.op}`)
      return msg
    }
    function send(type, id, fields = {}) {
      window.DshNative.onmessage({ data: JSON.stringify({ type, id, ...fields }) })
    }
    const { initializeAccount, accountFetch } = await import('/account.js')
    initializeAccount(() => {})
    await next('status')
    let reads = 0, maxRead = 0
    const rawRead = FileReader.prototype.readAsDataURL
    FileReader.prototype.readAsDataURL = function (blob) {
      maxRead = Math.max(maxRead, blob.size)
      check(blob.size <= 96 * 1024, 'Read a file-sized blob into memory')
      reads++
      return rawRead.call(this, blob)
    }
    Request.prototype.blob = () => { throw new Error('Materialized complete multipart body') }
    const MiB = 1024 * 1024, fileSize = 100 * MiB, chunkSize = 96 * 1024
    const binary = new Uint8Array(MiB)
    for (let i = 0; i < binary.length; i++) binary[i] = i % 251
    const block = new Blob([binary])
    const form = new FormData()
    form.append('purpose', 'text_recognition')
    form.append('file', new File(Array(100).fill(block), '测试"\n.pdf', { type: 'application/pdf' }))
    const endpoint = 'https://api.deepseek.com/anthropic/v1/files'
    const upload = signal => accountFetch(endpoint, { method: 'POST', body: form, signal })
    const pending = upload()
    const start = await next('upload')
    check(!('body' in start) && start.path === '/anthropic/v1/files' && start.method === 'POST', 'Invalid upload start frame')
    const boundary = start.contentType.split('boundary=')[1]
    const encoder = new TextEncoder()
    const head = encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\ntext_recognition\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="测试%22%0A.pdf"\r\nContent-Type: application/pdf\r\n\r\n`)
    const tail = encoder.encode(`\r\n--${boundary}--\r\n`)
    check(start.length === head.length + fileSize + tail.length, 'Incorrect Content-Length')
    let chunks = 0
    for (let offset = 0; offset < start.length;) {
      check(reads === chunks && outbox.length === 0, 'Read ahead of native write acknowledgement')
      const length = Math.min(chunkSize, start.length - offset)
      send('pull', start.id, { offset, length })
      const msg = await next('chunk')
      check(msg.id === start.id && msg.offset === offset, 'Wrong request or offset')
      const bytes = atob(msg.body)
      check(bytes.length === length, 'Incorrect chunk size')
      for (let i = 0; i < length; i++) {
        const index = offset + i, fileIndex = index - head.length
        const expected = fileIndex < 0 ? head[index] : fileIndex < fileSize ? (fileIndex % MiB) % 251 : tail[fileIndex - fileSize]
        if (bytes.charCodeAt(i) !== expected) throw new Error(`Incorrect multipart byte at ${index}`)
      }
      offset += length
      chunks++
    }
    send('headers', start.id, { status: 200, contentType: 'application/json' })
    send('data', start.id, { base64: btoa('{"id":"offline-file"}') })
    send('end', start.id)
    check((await (await pending).json()).id === 'offline-file', 'Lost upload response')

    const rejects = async (promise, name) => {
      try { await promise } catch (error) { check(error.name === name, 'Wrong rejection'); return }
      throw new Error('Request unexpectedly succeeded')
    }
    const cancelled = new AbortController()
    const afterStart = upload(cancelled.signal)
    const second = await next('upload')
    send('pull', second.id, { offset: 0, length: chunkSize })
    cancelled.abort() // Stop while the real FileReader is reading its first slice.
    await rejects(afterStart, 'AbortError')
    check((await next('cancel')).id === second.id, 'Native call did not receive cancellation')
    send('pull', second.id, { offset: 0, length: chunkSize })
    await rejects(upload(cancelled.signal), 'AbortError')
    const malformed = upload()
    const third = await next('upload')
    send('pull', third.id, { offset: 1, length: chunkSize })
    await rejects(malformed, 'Error')
    check((await next('cancel')).id === third.id, 'Malformed pull left native call running')
    for (const url of [endpoint.replace('https:', 'http:'), endpoint.replace('api.', 'other.'),
      endpoint.replace('//', '//user@'), endpoint + '?other=1', endpoint + '#fragment']) {
      await rejects(accountFetch(url, { method: 'POST', body: form }), 'Error')
    }
    await new Promise(resolve => setTimeout(resolve, 0))
    check(outbox.length === 0, 'Late or forbidden upload frame')
    return { fileBytes: fileSize, wireBytes: start.length, chunks, maxRead }
  })
  assert.equal(result.fileBytes, 104857600)
  console.log('Offline account upload passed', result)
} finally {
  await browser.close()
}
