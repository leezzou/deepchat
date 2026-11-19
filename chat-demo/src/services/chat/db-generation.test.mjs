// node src/services/chat/db-generation.test.mjs — actual Chrome, isolated origin, two pages.
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { rspack } from '@rspack/core'
import { chromium } from '../../../../tools/node_modules/playwright/index.mjs'

const temporary = await mkdtemp(path.join(tmpdir(), 'deepchat-db-generation-'))
const compiler = rspack({
  mode: 'development',
  devtool: false,
  entry: fileURLToPath(new URL('./db.ts', import.meta.url)),
  output: { path: temporary, filename: 'db.js', library: { type: 'window', name: 'db' } },
  resolve: { extensionAlias: { '.js': ['.ts', '.js'] } },
  module: {
    rules: [
      {
        test: /\.ts$/,
        loader: 'builtin:swc-loader',
        options: { jsc: { parser: { syntax: 'typescript' } } },
      },
    ],
  },
})
await new Promise((resolve, reject) =>
  compiler.run((error, stats) =>
    compiler.close((closeError) => {
      if (error || closeError || stats?.hasErrors()) {
        reject(error ?? closeError ?? new Error(stats.toString()))
      } else {
        resolve()
      }
    })
  )
)
const bundle = await readFile(path.join(temporary, 'db.js'))
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
})
try {
  const context = await browser.newContext()
  const errors = []
  context.on('weberror', (event) => errors.push(event.error().message))
  const origin = 'https://history.test'
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url())
    if (url.origin !== origin) {
      return route.abort()
    }
    return route.fulfill(
      url.pathname === '/db.js'
        ? { contentType: 'text/javascript', body: bundle }
        : { contentType: 'text/html', body: '<script src="/db.js"></script>' }
    )
  })
  await context.addInitScript(() => {
    window.session = (id, fileId) => ({
      id,
      title: id,
      createdAt: 1,
      updatedAt: 1,
      messages: [
        {
          id: 'm',
          content: id,
          createdAt: 1,
          role: 'user',
          files: fileId ? [{ id: fileId, mimeType: '' }] : [],
        },
      ],
    })
    window.request = (req) =>
      new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
    window.physical = async () => {
      const raw = await request(indexedDB.open('chat-demo'))
      try {
        const tx = raw.transaction([...raw.objectStoreNames])
        const active = (await request(tx.objectStore('historyMeta').get('active'))) ?? 0
        const counts = (g) =>
          Promise.all(
            ['sessions', 'sessionSummaries', 'files'].map((name) =>
              request(tx.objectStore(name + (g ? 'Staging' : '')).count())
            )
          )
        return { active, live: await counts(active), inactive: await counts(1 - active) }
      } finally {
        raw.close()
      }
    }
  })
  const first = await context.newPage()
  const second = await context.newPage()
  await Promise.all([first.goto(origin), second.goto(origin)])
  // A real v11 connection leaves enough abandoned staging keys for three reclamation pages.
  await first.evaluate(async () => {
    const opening = indexedDB.open('chat-demo', 11)
    opening.onupgradeneeded = () => {
      const raw = opening.result
      for (const name of ['sessions', 'sessionsStaging', 'files', 'filesStaging']) {
        raw.createObjectStore(name, { keyPath: 'id' })
      }
      raw
        .createObjectStore('sessionSummaries', { keyPath: 'id' })
        .createIndex('fileIds', 'fileIds', { multiEntry: true })
    }
    const raw = await request(opening)
    const tx = raw.transaction([...raw.objectStoreNames], 'readwrite')
    tx.objectStore('sessions').add(session('legacy', 'old-file'))
    tx.objectStore('sessionSummaries').add({
      id: 'legacy',
      title: 'legacy',
      createdAt: 1,
      updatedAt: 1,
      fileIds: ['old-file'],
    })
    tx.objectStore('files').add({ id: 'old-file', blob: new Blob(['original']) })
    for (let i = 0; i < 270; i++) {
      tx.objectStore('sessionsStaging').add(session(`stale-${i}`))
    }
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve
      tx.onabort = () => reject(tx.error)
    })
    raw.close()
  })
  assert.deepEqual(
    await second.evaluate(async () => [
      (await db.loadSession('legacy')).id,
      await (await db.loadFile('old-file')).text(),
      (await db.loadSessionSummaries())[0].id,
    ]),
    ['legacy', 'original', 'legacy']
  )
  assert.deepEqual(await first.evaluate(() => physical()), {
    active: 0,
    live: [1, 1, 1],
    inactive: [270, 0, 0],
  })
  await first.evaluate(async () => {
    await db.clearStaging()
    await db.addStagingSession(session('loser'))
  })
  assert.deepEqual(await first.evaluate(() => physical()), {
    active: 0,
    live: [1, 1, 1],
    inactive: [1, 1, 0],
  })
  await second.evaluate(async () => {
    await db.clearStaging()
    db.setStagingRestoreId('restore-on-second-page')
    await db.addStagingSessions([session('a', 'shared'), session('b', 'shared')])
    await db.saveStagingFiles([{ id: 'shared', blob: new Blob(['shared bytes']) }])
    await db.updateStagingFileTypes(new Map([['shared', 'text/plain']]))
  })
  // A losing writer cannot append, switch or erase the other page's staged rows.
  await assert.rejects(
    first.evaluate(() => db.addStagingSession(session('intruder'))),
    /Another page/
  )
  await assert.rejects(
    first.evaluate(() => db.commitStaging()),
    /Another page/
  )
  await first.evaluate(() => db.clearStaging())
  assert.deepEqual(await first.evaluate(() => physical()), {
    active: 0,
    live: [1, 1, 1],
    inactive: [2, 2, 1],
  })
  // Simulate reclamation failure AFTER the durable switch. The next replacement retries it.
  const committed = await second.evaluate(async () => {
    const original = IDBObjectStore.prototype.getAllKeys
    let injected = false
    IDBObjectStore.prototype.getAllKeys = function (...args) {
      if (this.name === 'sessions') {
        injected = true
        throw new DOMException('injected old-generation cleanup', 'UnknownError')
      }
      return original.apply(this, args)
    }
    try {
      return { ids: (await db.commitStaging()).map((s) => s.id), injected }
    } finally {
      IDBObjectStore.prototype.getAllKeys = original
    }
  })
  assert.deepEqual(committed, { ids: ['a', 'b'], injected: true })
  assert.equal(await first.evaluate(() => db.readLastRestoreId()), 'restore-on-second-page')
  assert.deepEqual(await first.evaluate(() => physical()), {
    active: 1,
    live: [2, 2, 1],
    inactive: [1, 1, 1],
  })
  await first.evaluate(() => db.clearStaging())
  assert.deepEqual(await first.evaluate(() => physical()), {
    active: 1,
    live: [2, 2, 1],
    inactive: [0, 0, 0],
  })
  assert.equal(
    await first.evaluate(async () => (await db.loadSession('a')).messages[0].files[0].mimeType),
    'text/plain'
  )
  await first.evaluate(() => db.renameSession('a', 'renamed'))
  assert.deepEqual(
    await second.evaluate(async () => [
      (await db.loadSession('a')).title,
      (await db.loadSessionSummaries()).find((s) => s.id === 'a').title,
    ]),
    ['renamed', 'renamed']
  )
  await second.evaluate(() => db.deleteSession('a'))
  assert.equal(
    await first.evaluate(async () => (await db.loadFile('shared')).text()),
    'shared bytes'
  )
  await second.evaluate(() => db.saveSession(session('b'), [], ['shared']))
  assert.equal(await first.evaluate(() => db.loadFile('shared')), undefined)
  await first.evaluate(() => db.saveFiles([{ id: 'separate', blob: new Blob(['new bytes']) }]))
  assert.equal(
    await second.evaluate(async () => (await db.loadFile('separate')).text()),
    'new bytes'
  )
  // A rejected multi-row transaction must leave neither physical nor in-memory summary rows.
  await assert.rejects(
    first.evaluate(() => db.addStagingSessions([session('duplicate'), session('duplicate')])),
    /ConstraintError/
  )
  assert.deepEqual(await first.evaluate(() => db.commitStaging()), [])
  assert.equal(await second.evaluate(() => db.readLastRestoreId()), undefined)
  assert.deepEqual(await second.evaluate(() => physical()), {
    active: 0,
    live: [0, 0, 0],
    inactive: [0, 0, 0],
  })
  assert.deepEqual(errors, [])
  process.stdout.write(
    `PASS Chrome ${browser.version()}: v11 upgrade, paged reclamation (270 stale rows), two-tab staging takeover, post-commit cleanup retry, generation-aware CRUD, shared attachment reference counts, rejected-batch rollback, empty swap.\n`
  )
} finally {
  await browser.close()
}
