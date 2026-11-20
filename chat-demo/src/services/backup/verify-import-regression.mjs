// node src/services/backup/verify-import-regression.mjs [--source-root /path/to/chat-demo]
// Builds the actual phone settings UI into a temporary directory. Playwright intercepts every
// request; file/link/DAV all use synthetic bytes. No server, device, credentials or app dist.
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { rspack } from '@rspack/core'
import { historyFixture, sha256 } from './test-fixtures/import-regression.mjs'
import { chromium } from '../../../../tools/node_modules/playwright/index.mjs'

const { values } = parseArgs({ options: { 'source-root': { type: 'string' } } })
const app = fileURLToPath(new URL('../../../', import.meta.url))
const source = path.resolve(values['source-root'] ?? app)
const temporary = await mkdtemp(path.join(tmpdir(), 'deepchat-import-regression-'))
// Only this mkdtemp directory belongs to the test. Keep production builds untouched.
assert.equal(path.dirname(path.resolve(temporary)), path.resolve(tmpdir()))
assert.match(path.basename(temporary), /^deepchat-import-regression-[A-Za-z0-9]+$/)
process.once('exit', () => rmSync(temporary, { recursive: true, force: true }))
const assets = path.join(temporary, 'build')
const origin = 'https://import.test'
const phrase = 'synthetic-phrase-123'
const small = historyFixture()
const large = historyFixture(true)
const invalid = Buffer.from('fixture with no ZIP signature')
const bridge = path.join(temporary, 'fixture-bridge.ts')
const modules = {
  db: 'chat/db',
  crypto: 'backup/portableCrypto',
  metadata: 'backup/portableMetadata',
}
await writeFile(
  bridge,
  Object.entries(modules)
    .map(
      ([name, file]) =>
        `import * as ${name} from ${JSON.stringify(path.join(source, 'src/services', file + '.ts'))}`
    )
    .join('\n') + '\nwindow.fixture = { db, crypto, metadata };\n'
)
const { createConfig } = await import(pathToFileURL(path.join(source, 'rspack.config.ts')))
const config = createConfig({ apiOrigin: origin })
config.context = source
config.entry.main.push(bridge)
config.output = { ...config.output, path: assets }
config.devtool = false
const compiler = rspack(config)
await new Promise((resolve, reject) =>
  compiler.run((error, stats) =>
    compiler.close((closeError) => {
      if (error || closeError || stats?.hasErrors()) {
        reject(error ?? closeError ?? new Error(stats.toString({ all: false, errors: true })))
      } else {
        resolve()
      }
    })
  )
)

// Run in an isolated document. Record committed DOM changes (visible copy and accessibility
// values), not just byte callbacks. In a tiny ZIP, allow two paints while the real staging
// transaction is still pending so a premature 100% cannot escape observation through batching.
function instrument(mode) {
  const trace = (window.trace = {
    stages: [],
    premature: [],
    fault: null,
    committed: false,
    staged: false,
  })
  const sample = () => {
    const feedback = document.querySelector('[data-import-state]')
    const stage = feedback?.dataset.importStage
    if (stage && !trace.stages.includes(stage)) {
      trace.stages.push(stage)
    }
    const status = document.querySelector('.dav-status')
    const text = (feedback?.textContent ?? '') + (status?.textContent ?? '')
    const bar = (feedback ?? status)?.querySelector('[role="progressbar"]')
    const full =
      /100\s*[%％]/.test(text) ||
      bar?.getAttribute('aria-valuenow') === '100' ||
      /100\s*[%％]/.test(bar?.getAttribute('aria-valuetext') ?? '')
    const success = feedback?.dataset.importState === 'success' || /^已恢复\s*\d/.test(text)
    if ((!success && full) || (!trace.committed && success)) {
      if (!trace.premature.includes(text)) {
        trace.premature.push(text)
      }
    }
  }
  new MutationObserver(sample).observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  })
  const add = IDBObjectStore.prototype.add
  IDBObjectStore.prototype.add = function (...args) {
    const req = add.apply(this, args)
    if (
      !trace.staged &&
      this.transaction.db.name === 'chat-demo' &&
      this.name === 'sessionsStaging'
    ) {
      trace.staged = true
      let painted = false
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          sample()
          painted = true
        })
      )
      const keepAlive = () => {
        if (!painted) {
          this.getKey('new').onsuccess = keepAlive
        }
      }
      keepAlive()
    }
    return req
  }
  const remove = IDBObjectStore.prototype.delete
  IDBObjectStore.prototype.delete = function (...args) {
    if (
      mode === 'recovery' &&
      trace.committed &&
      !trace.fault &&
      this.name === 'journal' &&
      this.transaction.db.name === 'deepchat-portable-recovery' &&
      args[0] === 'pending'
    ) {
      trace.fault = 'committed-journal-quota'
      throw new DOMException('fixture', 'QuotaExceededError')
    }
    return remove.apply(this, args)
  }
  const put = IDBObjectStore.prototype.put
  IDBObjectStore.prototype.put = function (...args) {
    const tx = this.transaction
    if (
      mode === 'quota' &&
      tx.db.name === 'chat-demo-backups' &&
      this.name === 'snapshots' &&
      args[1] === 'latest'
    ) {
      trace.fault = 'snapshot-quota'
      throw new DOMException('fixture', 'QuotaExceededError')
    }
    const req = put.apply(this, args)
    if (tx.db.name === 'chat-demo' && this.name === 'historyMeta' && args[1] === 'active') {
      tx.addEventListener('complete', () => {
        trace.committed = true
      })
      if (mode === 'abort') {
        req.addEventListener('success', () => {
          trace.fault = 'commit-abort'
          tx.abort()
        })
      }
    }
    return req
  }
}

const oldFile = [0, 253, 128, 17, 97]
async function seed(page) {
  await page.evaluate(async (bytes) => {
    const message = {
      id: 'u',
      role: 'user',
      createdAt: 1,
      content: 'old message',
      parentId: null,
      files: [
        {
          id: 'old-file',
          name: 'old.bin',
          size: bytes.length,
          isImage: false,
          mimeType: 'application/octet-stream',
          serverId: null,
        },
      ],
    }
    await window.fixture.db.saveSession(
      {
        id: 'old',
        title: 'Old fixture',
        createdAt: 1,
        updatedAt: 2,
        rootMessageId: 'u',
        messages: [message],
      },
      [
        {
          id: 'old-file',
          blob: new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' }),
        },
      ]
    )
  }, oldFile)
}
// The journal is deleted by normal startup only after recovery has finished.
async function recoveryCleared() {
  const request = (req) =>
    new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  const db = await request(indexedDB.open('deepchat-portable-recovery'))
  try {
    return (await request(db.transaction('journal').objectStore('journal').count())) === 0
  } finally {
    db.close()
  }
}
async function persisted(page) {
  return page.evaluate(async () => {
    const db = window.fixture.db
    const rows = []
    for (const { id, title } of await db.loadSessionSummaries()) {
      const msg = (await db.loadSession(id)).messages[0]
      rows.push({ id, title, text: msg.content, files: msg.files.map((f) => f.id) })
    }
    const hashes = {}
    for (const id of ['old-file', 'small', 'stored', 'deflated']) {
      const blob = await db.loadFile(id)
      if (!blob) {
        continue
      }
      try {
        const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))
        hashes[id] = Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('')
      } catch (error) {
        hashes[id] = error.name
      }
    }
    return { rows, hashes }
  })
}
const old = {
  rows: [{ id: 'old', title: 'Old fixture', text: 'old message', files: ['old-file'] }],
  hashes: { 'old-file': sha256(Buffer.from(oldFile)) },
}
const restored = (fixture) => ({
  rows: [{ id: 'new', title: 'Imported fixture', text: 'imported message', files: fixture.ids }],
  hashes: fixture.hashes,
})

const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
})
async function exercise(entry, mode) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    locale: 'zh-CN',
    serviceWorkers: 'block',
  })
  let encrypted,
    gets = 0
  const fixture = mode === 'success' && entry !== 'webdav' ? large : small
  const bytes = mode === 'format' ? invalid : fixture.bytes
  const committed = mode === 'success' || mode === 'recovery'
  try {
    const errors = []
    context.on('weberror', (e) => errors.push(e.error().message))
    await context.route('**/*', async (route) => {
      const url = new URL(route.request().url())
      if (url.origin !== origin || route.request().method() !== 'GET') {
        return route.abort()
      }
      if (url.pathname === '/fixture.zip' || url.pathname === '/dav/deepchat-backup.dcb') {
        gets++
        const body = url.pathname === '/fixture.zip' ? bytes : encrypted
        return route.fulfill({
          body,
          contentType: 'application/octet-stream',
          headers: { 'Content-Length': String(body.length) },
        })
      }
      const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
      if (!/^(index\.html|static\/[\w./-]+)$/.test(relative) || relative.includes('..')) {
        return route.fulfill({ status: 404, body: '' })
      }
      return route.fulfill({ path: path.join(assets, relative) })
    })
    await context.addInitScript((origin) => {
      if (location.origin !== origin) {
        return
      }
      localStorage.setItem('chat-demo:locale', 'zh-CN')
      localStorage.setItem('chat-demo:api-key', 'synthetic-fixture-key')
    }, origin)
    const page = await context.newPage()
    page.setDefaultTimeout(8000)
    const open = async () => {
      await page.goto(origin)
      await page.waitForFunction(() => Boolean(window.fixture))
    }
    await open()
    await seed(page)
    await open()
    assert.deepEqual(await persisted(page), old)
    const button = (name) => page.getByRole('button', { name, exact: true })
    await button('打开边栏').click()
    await button('设置').click()
    await button('数据管理').click()
    await page.evaluate(instrument, mode)
    let terminal
    if (entry === 'webdav') {
      encrypted = Buffer.from(
        await page.evaluate(
          async ({ bytes, phrase }) => {
            const { crypto, metadata } = window.fixture
            const sealed = await crypto.sealBackup(
              new Blob([new Uint8Array(bytes)]),
              metadata.capturePortableMetadata(['new']),
              phrase
            )
            return [...new Uint8Array(await sealed.arrayBuffer())]
          },
          { bytes: [...bytes], phrase }
        )
      )
      await page.getByRole('button', { name: /WebDAV/ }).click()
      await page.getByLabel('WebDAV 目录地址').fill(origin + '/dav/')
      await page.getByLabel('备份密码', { exact: true }).fill(phrase)
      await button('从备份恢复').click()
      await button('确认恢复').click()
      terminal =
        mode === 'success'
          ? page.locator('.dav-status').filter({ hasText: /已恢复\s*1/ })
          : page.locator('.dav-error')
    } else {
      if (entry === 'link') {
        await button('从 DeepSeek 链接导入').click()
        await page.locator('input[inputmode="url"]').fill(origin + '/fixture.zip')
        await page.getByRole('button', { name: /下载并导入/ }).click()
      } else {
        await page
          .locator('input[type="file"][accept*="zip"]')
          .setInputFiles({ name: 'fixture.zip', mimeType: 'application/zip', buffer: bytes })
      }
      await button('确认导入').click()
      terminal = page.locator(
        '[data-import-state="success"], [data-import-state="failed"], [data-import-state="recovery"]'
      )
    }
    await terminal.waitFor()
    const text = await terminal.textContent()
    const state = await terminal.getAttribute('data-import-state')
    const trace = await page.evaluate(() => window.trace)
    if (mode === 'recovery') {
      assert.equal(await page.evaluate(recoveryCleared), false, 'journal retained for restart')
    }
    await open()
    if (mode === 'recovery') {
      await page.waitForFunction(recoveryCleared)
    }
    const actual = await persisted(page)
    process.stdout.write(
      JSON.stringify({ entry, mode, state, text, ...trace, durable: actual }) + '\n'
    )
    assert.deepEqual(
      actual,
      committed ? restored(fixture) : old,
      'durable conversation, references and original attachment bytes after reload'
    )
    if (entry !== 'webdav') {
      assert.equal(state, committed ? mode : 'failed', 'import outcome shown to the user')
    }
    assert.equal(gets, entry === 'file' ? 0 : 1, 'transport must fetch the fixture exactly once')
    assert.deepEqual(errors, [], 'uncaught page errors')
    assert.equal(trace.staged, mode !== 'format', 'valid ZIP rows really reached staging')
    assert.equal(
      trace.fault,
      { abort: 'commit-abort', quota: 'snapshot-quota', recovery: 'committed-journal-quota' }[
        mode
      ] ?? null
    )
    assert.equal(trace.committed, committed, 'actual generation switch committed')
    if (mode === 'recovery') {
      assert.match(text, /已导入|已替换|已恢复|已写入/, 'acknowledge the durable switch')
      assert.match(text, /重新打开|重开|重启/, 'offer recovery after restart')
      assert.match(text, /无需|不用|不必|不要/, 'make clear a second import is unnecessary')
    }
    if (mode === 'format') {
      assert.match(text, /格式|识别|完整.*ZIP/, 'explain invalid archive')
    }
    if (mode === 'quota') {
      assert.match(text, /空间不足|腾出|配额/, 'explain quota exhaustion')
    }
    if (mode === 'success') {
      assert.match(text, /1\s*个|一\s*个/, 'successful import count')
    }
    assert.deepEqual(
      trace.premature,
      [],
      '100% or success appeared before the generation switch committed'
    )
  } finally {
    await context.close()
  }
}
const failures = []
try {
  for (const [entry, modes] of [
    ['file', ['abort', 'format', 'recovery', 'success']],
    ['link', ['quota', 'success']],
    ['webdav', ['abort', 'quota', 'format', 'success']],
  ]) {
    for (const mode of modes) {
      try {
        await exercise(entry, mode)
      } catch (error) {
        failures.push(`${entry}/${mode}: ${error.message}`)
        process.stderr.write(failures.at(-1) + '\n')
      }
    }
  }
  assert.deepEqual(failures, [], 'history import regression')
  process.stdout.write(`Passed 10 import cases against ${source}\n`)
} finally {
  await browser.close()
}
