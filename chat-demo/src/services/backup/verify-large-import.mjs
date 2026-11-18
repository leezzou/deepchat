// Run from chat-demo: node src/services/backup/verify-large-import.mjs
// --generate-only prints a disk ZIP for a native picker. Reuse its exact bytes with
// --fixture-dir DIR [--source-root PATH/TO/ARCHIVED/chat-demo] in a fresh Chrome profile.
// --local64 generates a ZIP with Python's force_zip64 local headers. Add --streamed
// for a nonseekable writer and 64-bit data descriptors. --archive PATH
// tests an existing repack of the same fixture. --without-to-sorted simulates that
// missing WebView API. Frozen baselines may use --expect-failure zip64|to-sorted.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { rspack } from '@rspack/core'
import { zipSync } from 'fflate'
import { chromium } from '../../../../tools/node_modules/playwright/index.mjs'

const { values: options } = parseArgs({
  options: {
    'generate-only': { type: 'boolean' },
    'fixture-dir': { type: 'string' },
    'source-root': { type: 'string' },
    archive: { type: 'string' },
    local64: { type: 'boolean' },
    'expect-failure': { type: 'string' },
    'without-to-sorted': { type: 'boolean' },
    streamed: { type: 'boolean' },
  },
})
const app = fileURLToPath(new URL('../../../', import.meta.url))
const source = path.resolve(options['source-root'] ?? app)
const temporary = await mkdtemp(path.join(tmpdir(), 'deepchat-large-import-'))
const fixtureDir = path.resolve(options['fixture-dir'] ?? temporary)
const canonical = path.join(fixtureDir, 'deepseek_data-75MiB.zip')
assert.ok(!(options.archive && options.local64), 'choose --archive or --local64')
assert.ok(!options.streamed || options.local64, 'use --streamed with --local64')
const local64Name = options.streamed
  ? 'deepseek_data-75MiB-stream64.zip'
  : 'deepseek_data-75MiB-local64.zip'
const archive = options.archive
  ? path.resolve(options.archive)
  : options.local64
    ? path.join(temporary, local64Name)
    : canonical
const description = path.join(fixtureDir, 'fixture.json')
const MiB = 1024 * 1024
const sha256 = (data) => createHash('sha256').update(data).digest('hex')
const print = (...values) => process.stdout.write(values.join(' ') + '\n')

// A valid uncompressed 24-bit BMP, with a repeatable different pixel field per image.
function bitmap(seed) {
  const side = 1024
  const pixels = Buffer.alloc(54 + side * side * 3)
  pixels.write('BM')
  pixels.writeUInt32LE(pixels.length, 2)
  pixels.writeUInt32LE(54, 10)
  pixels.writeUInt32LE(40, 14)
  pixels.writeInt32LE(side, 18)
  pixels.writeInt32LE(side, 22)
  pixels.writeUInt16LE(1, 26)
  pixels.writeUInt16LE(24, 28)
  pixels.writeUInt32LE(pixels.length - 54, 34)
  let state = seed + 1
  for (let i = 54; i < pixels.length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    pixels[i] = state >>> 24
  }
  return pixels
}

function makeFixture() {
  const timestamp = '2025-01-10T01:02:03.000Z'
  const json = (data) => Buffer.from(JSON.stringify(data))
  const entries = { 'manifest.json': json({ export_format_version: 3 }) }
  const images = {}
  const index = []
  const sessions = []
  const files = []
  let textBytes = 0
  for (let s = 0; s < 32; s++) {
    const id = `large-${String(s).padStart(2, '0')}`
    const title = `大包回归 ${id}`
    const fileId = s < 10 ? `photo-${String(s).padStart(2, '0')}` : null
    const name = `${fileId}.bmp`
    const imagePath = `chat_sessions/${id}_files/${fileId}_${name}`
    let attachment
    if (fileId) {
      const bytes = bitmap(s)
      attachment = {
        id: fileId,
        file_name: name,
        file_size: bytes.length,
        token_usage: null,
        inserted_at: timestamp,
        export_path: imagePath,
        is_image: true,
        width: 1024,
        height: 1024,
      }
      images[imagePath] = [bytes, { level: s < 6 ? 0 : 1 }]
      files.push({ id: fileId, name, size: bytes.length, sha256: sha256(bytes) })
    }
    const messages = []
    const contents = []
    for (let n = 1; n <= 65; n++) {
      const alternate = n === 65
      const user = !alternate && n % 2 === 1
      const prefix = `${id}/${n} ${user ? '问题' : alternate ? '另一个回答' : '回答'} — `
      const line = `The review for session ${s} checks the text, original image and selected reply. `
      const suffix = ` End of ${id}/${n}.`
      const length = 22 * 1024 - Buffer.byteLength(prefix + suffix)
      const content =
        prefix + line.repeat(Math.ceil(length / line.length)).slice(0, length) + suffix
      textBytes += Buffer.byteLength(content)
      contents.push(content)
      const fragments = []
      if (n === 1 && attachment) {
        fragments.push({ type: 'FILE', files: [attachment] })
      }
      fragments.push({ type: user ? 'REQUEST' : 'RESPONSE', content })
      messages.push({
        id: n,
        parent_id: n === 1 ? null : alternate ? 1 : n - 1,
        role: user ? 'USER' : 'ASSISTANT',
        status: 'FINISHED',
        thinking_enabled: false,
        search_enabled: false,
        accumulated_token_usage: 0,
        inserted_at: timestamp,
        fragments,
      })
    }
    const summary = { id, title, pinned: false, inserted_at: timestamp, updated_at: timestamp }
    entries[`chat_sessions/${id}.json`] = json({ ...summary, current_message_id: 64, messages })
    index.push({ ...summary, message_count: messages.length })
    sessions.push({ id, title, fileId, textHash: sha256(json(contents)) })
  }
  entries['chat_session_index.json'] = json(index)
  const bytes = zipSync({ ...entries, ...images }, { level: 0, mtime: new Date(2000, 0, 1) })
  assert.ok(
    bytes.length >= 74 * MiB && bytes.length <= 76 * MiB,
    `unexpected ZIP size ${bytes.length}`
  )
  return {
    bytes,
    expected: {
      bytes: bytes.length,
      sha256: sha256(bytes),
      sessions,
      files,
      textBytes,
      imageBytes: files.reduce((n, f) => n + f.size, 0),
      messages: 65 * sessions.length,
    },
  }
}

async function fixture() {
  if (options['fixture-dir']) {
    const expected = JSON.parse(await readFile(description, 'utf8'))
    assert.equal(
      sha256(await readFile(canonical)),
      expected.sha256,
      'canonical disk fixture changed'
    )
    return expected
  }
  const { bytes, expected } = makeFixture()
  await writeFile(canonical, bytes)
  await writeFile(description, JSON.stringify(expected, null, 2))
  return expected
}
const expected = await fixture()
if (options.local64) {
  // Python's standard library reserves two 64-bit local size fields, even for
  // small files; these real backups still have a normal 32-bit central directory.
  execFileSync('python3', [
    '-c',
    `
import shutil, sys, zipfile
source, target, mode = sys.argv[1:]
class NonSeekable:
    def __init__(self, output): self.output = output
    def write(self, data): return self.output.write(data)
    def flush(self): self.output.flush()
with zipfile.ZipFile(source) as old, open(target, 'wb') as output:
    sink = NonSeekable(output) if mode == 'streamed' else output
    with zipfile.ZipFile(sink, 'w') as new:
        for entry in old.infolist():
            meta = zipfile.ZipInfo(entry.filename, entry.date_time)
            meta.compress_type = entry.compress_type
            with old.open(entry) as src, new.open(meta, 'w', force_zip64=True) as dst:
                shutil.copyfileobj(src, dst)
with zipfile.ZipFile(source) as old, zipfile.ZipFile(target) as new:
    assert new.testzip() is None and old.namelist() == new.namelist()
    for name in old.namelist():
        assert old.getinfo(name).compress_type == new.getinfo(name).compress_type
        assert old.read(name) == new.read(name)
`,
    canonical,
    archive,
    options.streamed ? 'streamed' : 'seekable',
  ])
}
if (archive !== canonical) {
  const bytes = await readFile(archive)
  expected.bytes = bytes.byteLength
  expected.sha256 = sha256(bytes)
}
print(
  JSON.stringify({
    archive,
    fixtureDir,
    bytes: expected.bytes,
    sha256: expected.sha256,
    sessions: expected.sessions.length,
    messages: expected.messages,
    files: expected.files.length,
    textBytes: expected.textBytes,
    imageBytes: expected.imageBytes,
  })
)
if (options['generate-only']) {
  process.exit(0)
}

// Keep the contents intact but change the final image's ZIP CRC (both copies).
// This fails only after real parsing, decompression and writes to staging.
const badPath = path.join(temporary, 'bad-final-crc.zip')
{
  const bytes = await readFile(archive)
  const eocd = bytes.length - 22
  assert.equal(bytes.readUInt32LE(eocd), 0x06054b50)
  let directory = bytes.readUInt32LE(eocd + 16)
  let last
  while (directory < eocd) {
    assert.equal(bytes.readUInt32LE(directory), 0x02014b50)
    last = directory
    directory +=
      46 +
      bytes.readUInt16LE(last + 28) +
      bytes.readUInt16LE(last + 30) +
      bytes.readUInt16LE(last + 32)
  }
  assert.equal(directory, eocd)
  assert.ok(
    bytes
      .toString('utf8', last + 46, last + 46 + bytes.readUInt16LE(last + 28))
      .endsWith('photo-09.bmp')
  )
  const local = bytes.readUInt32LE(last + 42)
  const flags = bytes.readUInt16LE(local + 6)
  if (flags & 8) {
    // Streaming writers put the CRC after the compressed bytes. Leave their
    // all-zero local header intact so the reader really checks the image data.
    const data = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28)
    const descriptor = data + bytes.readUInt32LE(last + 20)
    const crc = descriptor + (bytes.readUInt32LE(descriptor) === 0x08074b50 ? 4 : 0)
    assert.equal(bytes.readUInt32LE(crc), bytes.readUInt32LE(last + 16))
    bytes[crc] ^= 1
  } else {
    bytes[local + 14] ^= 1
  }
  bytes[last + 16] ^= 1
  await writeFile(badPath, bytes)
}

const modules = {
  backup: 'services/chat/backup.ts',
  db: 'services/chat/db.ts',
  store: 'services/chat/store.ts',
  drafts: 'services/chat/drafts.ts',
}
const entry = path.join(temporary, 'harness.ts')
await writeFile(
  entry,
  Object.entries(modules)
    .map(
      ([name, file]) => `import * as ${name} from ${JSON.stringify(path.join(source, 'src', file))}`
    )
    .join('\n') + `\nwindow.testModules = { ${Object.keys(modules).join(', ')} };\n`
)
const compiler = rspack({
  mode: 'development',
  context: source,
  entry,
  devtool: false,
  output: { path: temporary, filename: 'entry.js', chunkFilename: '[id].js', publicPath: '/' },
  resolve: {
    extensions: ['.ts', '.tsx', '.js'],
    extensionAlias: { '.js': ['.ts', '.tsx', '.js'] },
    modules: [path.join(app, 'node_modules'), 'node_modules'],
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        loader: 'builtin:swc-loader',
        options: { jsc: { parser: { syntax: 'typescript', tsx: true } } },
      },
    ],
  },
  plugins: [new rspack.DefinePlugin({ __API_ORIGIN__: JSON.stringify('https://example.invalid') })],
})
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

const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
})
const result = {
  chrome: browser.version(),
  source,
  archive,
  bytes: expected.bytes,
  sha256: expected.sha256,
  withoutToSorted: Boolean(options['without-to-sorted']),
  expectedFailure: options['expect-failure'],
  timings: {},
}
async function verify() {
  const page = await browser.newPage()
  if (options['without-to-sorted']) {
    await page.addInitScript(() => {
      delete Array.prototype.toSorted
    })
  }
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.origin !== 'https://import.test') {
      return route.abort()
    }
    if (url.pathname === '/') {
      return route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: '<input type="file"><script src="/entry.js"></script>',
      })
    }
    return route.fulfill({
      contentType: 'text/javascript; charset=utf-8',
      body: await readFile(path.join(temporary, path.basename(url.pathname))),
    })
  })
  const loadPage = async () => {
    await page.goto('https://import.test/')
    await page.waitForFunction(() => !!window.testModules)
  }
  await loadPage()
  await page.evaluate(async () => {
    const { db, store, drafts } = window.testModules
    const session = {
      id: 'old',
      title: 'Original history',
      createdAt: 1,
      updatedAt: 2,
      rootMessageId: 'u',
      messages: [
        {
          id: 'u',
          role: 'user',
          createdAt: 1,
          content: 'preserve this history',
          parentId: null,
          files: [
            {
              id: 'old-file',
              name: 'old.txt',
              size: 8,
              isImage: false,
              mimeType: 'text/plain',
              serverId: null,
            },
          ],
        },
      ],
    }
    await db.saveSession(session, [{ id: 'old-file', blob: new Blob(['original']) }])
    await Promise.all([store.initChat(), drafts.initDrafts()])
    drafts.setDraftText('old', 'draft before import')
    if (!(await drafts.flushDrafts())) {
      throw new Error('failed to create original draft')
    }
  })

  // Playwright sends only the filesystem path to Chrome. The importer receives the
  // actual picker File object, including disk-backed File.slice and arrayBuffer I/O.
  const runImport = async (label, filePath, injectAbort = false) => {
    await page.locator('input').setInputFiles(filePath)
    const outcome = await page.evaluate(
      async ({ bytes, injectAbort }) => {
        const { backup } = window.testModules
        const file = document.querySelector('input').files[0]
        if (file.size !== bytes) {
          throw new Error('picker file has unexpected size')
        }
        let progress = null
        const stages = []
        let count = 0
        let aborted = null
        const put = IDBObjectStore.prototype.put
        if (injectAbort) {
          IDBObjectStore.prototype.put = function (...args) {
            const req = put.apply(this, args)
            const tx = this.transaction
            if (tx.db.name !== 'chat-demo') {
              return req
            }
            // Abort after the switch write succeeds, before its transaction commits.
            // Frozen v11 instead copies staged rows into `sessions` in the final transaction.
            const twoGenerations = tx.db.objectStoreNames.contains('historyMeta')
            const atCommit = twoGenerations
              ? this.name === 'historyMeta' && args[1] === 'active'
              : this.name === 'sessions' && ++count === 2
            if (atCommit) {
              req.addEventListener('success', () => {
                aborted = twoGenerations ? 'generation-pointer' : 'second-session-copy'
                tx.abort()
              })
            }
            return req
          }
        }
        const start = performance.now()
        try {
          const count = await backup.importHistory(
            file,
            (processed, total) => {
              progress = { processed, total }
            },
            (stage) => stages.push({ stage, ms: Math.round(performance.now() - start) })
          )
          return { ok: true, count, ms: Math.round(performance.now() - start), progress, stages }
        } catch (error) {
          return {
            ok: false,
            ms: Math.round(performance.now() - start),
            progress,
            stages,
            aborted,
            name: error.name,
            key: error.key,
            message: error.message,
            cause: error.cause?.message,
          }
        } finally {
          if (injectAbort) {
            IDBObjectStore.prototype.put = put
          }
        }
      },
      { bytes: expected.bytes, injectAbort }
    )
    result.timings[label] = outcome
    print(label, JSON.stringify(outcome))
    return outcome
  }
  const counts = () =>
    page.evaluate(async () => {
      const wrap = (request) =>
        new Promise((resolve, reject) => {
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        })
      const db = await wrap(indexedDB.open('chat-demo'))
      try {
        const twoGenerations = db.objectStoreNames.contains('historyMeta')
        const tx = db.transaction(Array.from(db.objectStoreNames), 'readonly')
        const generation = twoGenerations
          ? ((await wrap(tx.objectStore('historyMeta').get('active'))) ?? 0)
          : null
        const readCounts = async (suffix, names) =>
          Object.fromEntries(
            await Promise.all(
              names.map(async (name) => [name, await wrap(tx.objectStore(name + suffix).count())])
            )
          )
        const stores = ['sessions', 'sessionSummaries', 'files']
        // A single read-only IDB transaction observes one generation and its rows together.
        const active = await readCounts(generation === 1 ? 'Staging' : '', stores)
        const inactive = await readCounts(
          generation === 1 ? '' : 'Staging',
          twoGenerations ? stores : ['sessions', 'files']
        )
        return { generation, active, inactive }
      } finally {
        db.close()
      }
    })
  const initial = await counts()
  assert.ok(
    initial.generation === null || initial.generation === 0,
    'new profile starts in generation zero'
  )
  const gen0 = initial.generation
  const gen1 = gen0 === null ? null : 1
  const empty =
    gen0 === null ? { sessions: 0, files: 0 } : { sessions: 0, sessionSummaries: 0, files: 0 }
  const oldCounts = {
    generation: gen0,
    active: { sessions: 1, sessionSummaries: 1, files: 1 },
    inactive: empty,
  }
  const full = {
    sessions: expected.sessions.length,
    sessionSummaries: expected.sessions.length,
    files: expected.files.length,
  }
  assert.deepEqual(initial, oldCounts)
  result.databaseLayout = gen0 === null ? 'v11-copy' : 'two-generations'
  const oldData = () =>
    page.evaluate(async () => {
      const { db, drafts } = window.testModules
      return [
        (await db.loadSession('old')).messages[0].content,
        await (await db.loadFile('old-file')).text(),
        drafts.getDraft('old').text,
      ]
    })
  const before = ['preserve this history', 'original', 'draft before import']
  const checkAll = async (generation) => {
    assert.deepEqual(await counts(), { generation, active: full, inactive: empty })
    return page.evaluate(async (expected) => {
      const { db } = window.testModules
      const check = (ok, label) => {
        if (!ok) {
          throw new Error(label)
        }
      }
      const hash = async (bytes) =>
        Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (x) =>
          x.toString(16).padStart(2, '0')
        ).join('')
      const summaryTitles = new Map((await db.loadSessionSummaries()).map((s) => [s.id, s.title]))
      let checkedMessages = 0
      for (const target of expected.sessions) {
        const s = await db.loadSession(target.id)
        check(
          s && s.title === target.title && summaryTitles.get(s.id) === s.title,
          `${target.id} session/summary`
        )
        check(s.rootMessageId === '1' && s.messages.length === 65, `${s.id} root/count`)
        const texts = s.messages.map((m, i) => {
          const n = i + 1
          const user = n !== 65 && n % 2 === 1
          check(
            m.id === String(n) && m.role === (user ? 'user' : 'assistant'),
            `${s.id}/${n} identity`
          )
          check(
            m.parentId === (n === 1 ? null : n === 65 ? '1' : String(n - 1)),
            `${s.id}/${n} parent`
          )
          check(
            (m.selectedChildId ?? null) === (n < 64 ? String(n + 1) : null),
            `${s.id}/${n} selection`
          )
          if (user) {
            if (n === 1 && target.fileId) {
              const f = expected.files.find((f) => f.id === target.fileId)
              check(
                m.files.length === 1 &&
                  m.files[0].id === f.id &&
                  m.files[0].size === f.size &&
                  m.files[0].name === f.name &&
                  m.files[0].isImage &&
                  m.files[0].mimeType === 'image/bmp',
                `${s.id} attachment reference`
              )
            } else {
              check(m.files.length === 0, `${s.id}/${n} extra attachment`)
            }
          }
          checkedMessages++
          return user ? m.content : m.blocks[0].text
        })
        check(
          (await hash(new TextEncoder().encode(JSON.stringify(texts)))) === target.textHash,
          `${s.id} text SHA-256`
        )
      }
      for (const target of expected.files) {
        const blob = await db.loadFile(target.id)
        check(blob?.size === target.size && blob.type === 'image/bmp', `${target.id} size/MIME`)
        check(
          (await hash(await blob.arrayBuffer())) === target.sha256,
          `${target.id} pixel bytes SHA-256`
        )
        const bitmap = await createImageBitmap(blob)
        check(bitmap.width === 1024 && bitmap.height === 1024, `${target.id} decoded dimensions`)
        bitmap.close()
      }
      return {
        checkedMessages,
        checkedImages: expected.files.length,
        textBytes: expected.textBytes,
        imageBytes: expected.imageBytes,
      }
    }, expected)
  }
  if (result.expectedFailure) {
    const outcome = await runImport('reproduceBaselineFailure', archive)
    assert.equal(outcome.ok, false, 'expected this frozen baseline to reject the intact archive')
    if (result.expectedFailure === 'to-sorted') {
      assert.equal(outcome.name, 'TypeError')
      assert.match(outcome.message, /toSorted/)
    } else {
      assert.equal(result.expectedFailure, 'zip64')
      assert.equal(outcome.key, 'backupIncomplete')
    }
    assert.deepEqual(await counts(), oldCounts)
    assert.deepEqual(await oldData(), before)
    assert.deepEqual(pageErrors, [])
    result.previousHistoryPreserved = true
    return
  }
  const aborted = await runImport('abortDuringCommit', archive, true)
  assert.equal(aborted.ok, false)
  assert.equal(
    aborted.aborted,
    gen0 === null ? 'second-session-copy' : 'generation-pointer',
    'must abort the actual final commit transaction'
  )
  assert.deepEqual(await counts(), oldCounts)
  assert.deepEqual(await oldData(), before)

  const expectSuccess = (outcome) => {
    assert.ok(outcome.ok, JSON.stringify(outcome))
    assert.equal(outcome.count, expected.sessions.length)
    assert.ok(
      outcome.progress?.total > 0 && outcome.progress.processed === outcome.progress.total,
      'final byte progress'
    )
  }
  expectSuccess(await runImport('importOverSmallHistory', archive))
  result.integrity = await checkAll(gen1)
  const snapshot = () =>
    page.evaluate(() => window.testModules.backup.useBackupState.getState().safety)
  const saved = await snapshot()
  assert.ok(saved?.id && saved.reason === 'before-import' && saved.sessionCount === 1)
  const readMarker = () => page.evaluate(() => window.testModules.drafts.getDraft('large-00').text)
  await page.evaluate(async () => {
    const { drafts } = window.testModules
    drafts.setDraftText('large-00', 'marker in full history')
    if (!(await drafts.flushDrafts())) {
      throw new Error('failed to save full-history marker draft')
    }
  })
  const invalid = await runImport('rejectFinalImageCRC', badPath)
  assert.equal(invalid.ok, false)
  assert.equal(invalid.key, 'backupIncomplete')
  assert.equal((await snapshot()).id, saved.id)
  assert.equal(await readMarker(), 'marker in full history')
  await checkAll(gen1)

  // Reload from the actual IDB and prove the small original snapshot is restorable.
  const reloadStores = async () => {
    await loadPage()
    await page.evaluate(async () => {
      const { store, drafts, backup } = window.testModules
      await Promise.all([store.initChat(), drafts.initDrafts(), backup.loadBackupState()])
    })
  }
  const restore = () =>
    page.evaluate(async () => {
      const start = performance.now()
      const count = await window.testModules.backup.restoreSafetySnapshot()
      return { count, ms: Math.round(performance.now() - start) }
    })
  await reloadStores()
  assert.equal((await snapshot()).id, saved.id)
  result.timings.restoreOriginal = await restore()
  assert.equal(result.timings.restoreOriginal.count, 1)
  assert.deepEqual(await counts(), oldCounts)
  assert.deepEqual(await oldData(), before)
  // The before-restore snapshot now contains all large history and its draft.
  result.timings.restoreLarge = await restore()
  assert.equal(result.timings.restoreLarge.count, expected.sessions.length)
  assert.equal(await readMarker(), 'marker in full history')
  await checkAll(gen1)

  expectSuccess(await runImport('importOverLargeHistory', archive))
  assert.equal((await snapshot()).sessionCount, expected.sessions.length)
  await reloadStores()
  result.persistedAfterReload = await checkAll(gen0)
  assert.equal(await readMarker(), '')
  assert.deepEqual(pageErrors, [], 'uncaught browser errors')
}
try {
  await verify()
  result.passed = true
} finally {
  await browser.close()
  const report = path.join(temporary, 'report.json')
  await writeFile(report, JSON.stringify(result, null, 2) + '\n')
  print(JSON.stringify({ report, ...result }, null, 2))
}
