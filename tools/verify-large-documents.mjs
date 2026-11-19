// Run after a production build: node tools/verify-large-documents.mjs [dist-directory]
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const { zipSync } = createRequire(new URL('../chat-demo/package.json', import.meta.url))('fflate')
const dist = path.resolve(process.argv[2] ?? fileURLToPath(new URL('../chat-demo/dist', import.meta.url)))
const origin = 'https://localhost'
const api = 'https://api.deepseek.com'
const beta = 'files-api-2025-04-14'
const model = 'deepseek-v4-flash'
const MiB = 1024 * 1024

// The original files exceed 20 MiB while their readable text fits the extracted-text limit.
function makePdf() {
  const contents = 'BT /F1 16 Tf 36 700 Td (Quarterly report) Tj ET\n'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${contents.length} >>\nstream\n${contents}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let pdf = '%PDF-1.4\n'
  const rows = ['0000000000 65535 f \n']
  for (const [index, object] of objects.entries()) {
    rows.push(`${String(pdf.length).padStart(10, '0')} 00000 n \n`)
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  // All contents are ASCII. Comments are legal between objects and the cross-reference table.
  pdf += ('%' + ' '.repeat(254) + '\n').repeat(21 * MiB / 256)
  const xref = pdf.length
  return Buffer.from(`${pdf}xref\n0 ${rows.length}\n${rows.join('')}trailer\n<< /Size ${rows.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
}

function makeDocx() {
  const padding = ('<!--' + ' '.repeat(1017) + '-->').repeat(21 * MiB / 1024)
  return Buffer.from(zipSync({
    '[Content_Types].xml': Buffer.from('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    '_rels/.rels': Buffer.from('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    'word/document.xml': Buffer.from(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Quarterly report</w:t></w:r></w:p>${padding}</w:body></w:document>`),
  }, { level: 0 }))
}

function reply(answer, anthropic) {
  const events = anthropic ? [
    { type: 'message_start', message: { id: 'msg-test', model } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: answer } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' },
  ] : [{ choices: [{ delta: { content: answer }, finish_reason: 'stop' }] }, '[DONE]']
  return events.map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join('')
}

// Word can open RTF in a .doc file. The two readable summaries contain no case data.
function legacyWord(name, sizeKiB) {
  const rtf = `{\\rtf1\\ansi Synthetic document: ${name}.`
  return { name, mimeType: 'application/msword', buffer: Buffer.from(rtf.padEnd(sizeKiB * 1024 - 1) + '}') }
}
const pdf = { name: 'report.pdf', mimeType: 'application/pdf', buffer: makePdf() }
const docx = { name: 'report.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: makeDocx() }
const mixed = [legacyWord('summary.doc', 56), legacyWord('notes.doc', 24), pdf]
assert.ok(pdf.buffer.length > 20 * MiB && docx.buffer.length > 20 * MiB)
const browser = await chromium.launch({ channel: 'chrome' })
try {
  for (const files of [mixed, [docx]]) {
    for (const protocol of ['deepseek', 'openai']) {
      const anthropic = protocol === 'deepseek'
      const prompt = files.length > 1 ? '请对比三份文档，概括共同点并说明主要差异。' : '请总结这份 Word 文档的主要内容。'
      const answer = '文档摘要已完成。'
      const idFor = name => `file-${files.findIndex(file => file.name === name) + 1}`
      const page = await browser.newPage({ serviceWorkers: 'block', locale: 'en-US' })
      page.setDefaultTimeout(15000)
      const failure = Promise.withResolvers()
      page.on('pageerror', failure.reject)
      const uploaded = new Set()
      let messages = 0
      await page.addInitScript(({ api, model, protocol }) => {
        localStorage.setItem('chat-demo:api-profiles', JSON.stringify([{ id: 'offline', protocol, model, origin: api, apiKey: 'offline-test-only' }]))
      }, { api, model, protocol })
      await page.route('**/*', async route => {
        try {
          const req = route.request(), url = new URL(req.url())
          if (url.origin === origin && req.method() === 'GET') {
            const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }
            const file = path.join(dist, url.pathname === '/' ? 'index.html' : url.pathname)
            return await route.fulfill({ path: file, contentType: mime[path.extname(file)] })
          }
          if (url.origin !== api) return await route.abort() // e.g. the startup update check
          assert.equal(req.method(), 'POST')
          const headers = req.headers()
          assert.equal(headers['anthropic-beta'], anthropic ? beta : undefined)
          const uploadPath = anthropic ? '/anthropic/v1/files' : '/files'
          const chatPath = anthropic ? '/anthropic/v1/messages' : '/chat/completions'
          if (url.pathname === uploadPath) {
            const form = await new Response(req.postDataBuffer(), { headers }).formData()
            assert.deepEqual([...form.keys()], ['purpose', 'file'])
            assert.equal(form.get('purpose'), 'rich_layout_recognition')
            const file = form.get('file')
            const fixture = files.find(item => item.name === file.name)
            assert.ok(fixture && !uploaded.has(file.name), `Unexpected upload: ${file.name}`)
            uploaded.add(file.name)
            assert.equal(file.type, fixture.mimeType)
            assert.ok(Buffer.from(await file.arrayBuffer()).equals(fixture.buffer), 'Multipart upload changed document bytes')
            return await route.fulfill({ json: { id: idFor(file.name) } })
          }
          assert.equal(url.pathname, chatPath)
          assert.equal(++messages, 1)
          assert.equal(uploaded.size, files.length)
          const body = req.postDataJSON()
          assert.equal(body.stream, true)
          if (anthropic && files === mixed) {
            assert.deepEqual(body.thinking, { type: 'enabled' })
            assert.ok(body.tools.some(tool => tool.type === 'deepseek_web_search' && tool.name === 'deepseek_web_search'))
          }
          const blocks = files.map(({ name }) => anthropic
            ? { type: 'document', source: { type: 'file', file_id: idFor(name) } }
            : { type: 'file', file_id: idFor(name) })
          assert.deepEqual(body.messages.findLast(m => m.role === 'user')?.content, [...blocks, { type: 'text', text: prompt }])
          return await route.fulfill({ contentType: 'text/event-stream', body: reply(answer, anthropic) })
        } catch (error) {
          failure.reject(error)
          await route.abort()
        }
      })
      await Promise.race([failure.promise, (async () => {
        await page.goto(origin)
        if (files === mixed) {
          for (const name of ['DeepThink', 'Search']) {
            const toggle = page.locator('main').getByRole('button', { name, exact: true })
            if (await toggle.getAttribute('aria-pressed') !== 'true') await toggle.click()
            assert.equal(await toggle.getAttribute('aria-pressed'), 'true')
          }
        }
        await page.locator('main textarea').fill(prompt)
        await page.locator('main input[type=file][multiple]').setInputFiles(files)
        await page.getByRole('button', { name: 'Send', exact: true }).click()
        await page.getByText(answer, { exact: true }).waitFor()
        assert.equal(messages, 1)
        console.log(`PASS ${protocol} ${files.map(f => `${f.name} (${f.buffer.length} bytes)`).join(' + ')} with typed text and SSE reply`)
      })()])
      await page.close()
    }
  }
} finally {
  await browser.close()
}
