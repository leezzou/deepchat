// Run from chat-demo: node src/services/verifySafety.browser.mjs
// Real browser IndexedDB, isolated fixtures and mocked native bridge; no model requests.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { rspack } from '@rspack/core'
import { chromium } from '../../../tools/node_modules/playwright/index.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const temporary = await mkdtemp(path.join(tmpdir(), 'deepchat-safety-verification-'))
const modules = {
  drafts: 'services/chat/drafts.ts',
  storage: 'services/chat/draftStorage.ts',
  store: 'services/chat/store.ts',
  uploads: 'services/attachments.ts',
  safety: 'services/updateSafety.ts',
  installer: 'shell/installer.ts',
  edits: 'services/pendingEdits.ts',
}
await writeFile(
  path.join(temporary, 'entry.ts'),
  Object.entries(modules)
    .map(
      ([name, file]) => `import * as ${name} from ${JSON.stringify(path.join(root, 'src', file))}`
    )
    .join('\n') + `\nwindow.testModules = { ${Object.keys(modules).join(', ')} }\n`
)
const compiler = rspack({
  mode: 'development',
  entry: path.join(temporary, 'entry.ts'),
  devtool: false,
  output: { path: temporary, filename: 'test.js', publicPath: '/', chunkFilename: '[id].js' },
  resolve: {
    extensions: ['.ts', '.tsx', '.js'],
    extensionAlias: { '.js': ['.ts', '.tsx', '.js'] },
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
  compiler.run((error, stats) => {
    compiler.close(() => {})
    if (error || stats?.hasErrors()) {
      reject(error ?? new Error(stats.toString({ all: false, errors: true })))
    } else {
      resolve()
    }
  })
)
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
})
const checks = []
try {
  const context = await browser.newContext()
  const page = await context.newPage()
  const errors = []
  let unexpectedNetwork = 0
  page.on('pageerror', (error) => errors.push(error.message))
  const routeFixture = async (route) => {
    const url = new URL(route.request().url())
    if (url.hostname !== 'safety.test') {
      unexpectedNetwork++
      await route.abort()
      return
    }
    if (url.pathname === '/') {
      await route.fulfill({
        contentType: 'text/html',
        body: '<html><body><script src="/test.js"></script></body></html>',
      })
    } else {
      await route.fulfill({
        contentType: 'text/javascript',
        body: await readFile(path.join(temporary, path.basename(url.pathname))),
      })
    }
  }
  await context.route('**/*', routeFixture)
  const load = async (target = page) => {
    await target.goto('https://safety.test/')
    await target.waitForFunction(() => !!window.testModules)
    await target.evaluate(async () => {
      await window.testModules.drafts.initDrafts()
      await window.testModules.store.initChat()
    })
  }
  await load()
  checks.push(
    ...(await page.evaluate(async () => {
      const { drafts, storage, safety } = window.testModules
      const results = []
      const check = (condition, label) => {
        if (!condition) {
          throw new Error(label)
        }
        results.push(label)
      }
      await drafts.restoreDrafts([
        { id: 'new', sessionId: null, text: 'new chat draft', attachments: [] },
        {
          id: 'session:inactive',
          sessionId: 'inactive',
          text: 'inactive draft',
          attachments: [
            {
              id: 'file-one',
              name: 'notes.txt',
              type: 'text/plain',
              lastModified: 1700000000000,
              isImage: false,
              blob: new Blob(['original attachment'], { type: 'text/plain' }),
            },
          ],
        },
      ])
      const saved = await storage.readStoredDrafts()
      check(saved.drafts.length === 2, 'new and inactive-session drafts persist separately')
      check(
        (await saved.drafts[1].attachments[0].blob.text()) === 'original attachment',
        'attachment originals are stored in IndexedDB'
      )
      check(
        safety.getUpdateBlockReason() === 'updateWaitDrafts',
        'inactive-session draft blocks updates'
      )
      // Deliberately reload before the debounced IndexedDB write.
      drafts.setDraftText('inactive', 'latest synchronous journal text')
      return results
    }))
  )
  await load()
  checks.push(
    ...(await page.evaluate(async () => {
      const { drafts, uploads, safety, installer } = window.testModules
      const results = []
      const check = (condition, label) => {
        if (!condition) {
          throw new Error(label)
        }
        results.push(label)
      }
      check(
        drafts.getDraft('inactive').text === 'latest synchronous journal text',
        'immediate reload recovers newer text from journal'
      )
      const item = drafts.getDraft('inactive').attachments[0]
      check(
        item.file.name === 'notes.txt' &&
          item.file.lastModified === 1700000000000 &&
          (await item.file.text()) === 'original attachment',
        'reload reconstructs attachment filename, type, timestamp and bytes'
      )
      check(
        uploads.useUploads.getState().tasks[item.id].status === 'error',
        'recovered attachments require explicit re-upload, never silently send to another account'
      )
      const native = { downloads: 0, installs: 0, ready: false }
      window.testNative = native
      window.AndroidUpdater = { installApkWithFallback: () => { native.downloads++ } }
      check(!installer.canInstallInApp() && !installer.installApk('https://safety.test/update.apk') && native.downloads === 0,
        'old native bridge cannot bypass the final safety check by installing immediately after download')
      window.AndroidUpdater = {
        installApkWithFallback: () => {
          native.downloads++
        },
        isDownloadedUpdateReady: () => native.ready,
        installDownloadedApk: () => {
          native.installs++
        },
      }
      window.stopSafety = safety.bindUpdateSafety()
      const release = {
        version: '9.0.0',
        tag: 'v9.0.0',
        notes: '',
        pageUrl: 'https://safety.test/release',
        apkUrl: 'https://safety.test/update.apk',
        apkUrlFallback: null,
      }
      await safety.requestUpdateInstall(release)
      check(
        native.downloads === 0 && safety.useUpdateSafety.getState().status === 'waiting',
        'requested update is deferred while any draft exists'
      )
      await safety.requestSafeReload()
      check(
        safety.useUpdateSafety.getState().reloadPending && !!window.testModules,
        'resource-recovery reload also respects drafts'
      )
      safety.useUpdateSafety.setState({ reloadPending: false })
      drafts.clearAllDrafts()
      await drafts.flushDrafts()
      await safety.continueUpdateInstall()
      check(
        native.downloads === 1 && safety.useUpdateSafety.getState().status === 'downloading',
        'explicit continue begins download only after persistence'
      )
      native.ready = true
      window.dispatchEvent(new Event('deepchat:update-ready'))
      drafts.setDraftText(null, 'typed during download')
      await safety.installReadyUpdate()
      check(
        native.installs === 0 && !window.__deepchatCanInstallUpdate(),
        'draft typed during download blocks final installer and native recheck'
      )
      drafts.clearAllDrafts()
      await drafts.flushDrafts()
      await safety.installReadyUpdate()
      check(
        native.installs === 1 && window.__deepchatCanInstallUpdate(),
        'idle, persisted state permits final installation'
      )
      window.stopSafety()
      check(!window.__deepchatCanInstallUpdate, 'unmount removes native safety bridge callback')
      return results
    }))
  )
  checks.push(
    ...(await page.evaluate(async () => {
      const { drafts, store, safety, edits } = window.testModules
      const results = []
      const check = (condition, label) => {
        if (!condition) {
          throw new Error(label)
        }
        results.push(label)
      }
      store.useChatStore.setState({ streaming: { other: new AbortController() } })
      check(
        safety.getUpdateBlockReason() === 'updateWaitGenerating',
        'generation in another conversation blocks updates'
      )
      store.useChatStore.setState({ streaming: {}, compacting: { other: new AbortController() } })
      check(
        safety.getUpdateBlockReason() === 'updateWaitGenerating',
        'manual and automatic summary tasks block updates'
      )
      store.useChatStore.setState({ compacting: {}, importingHistory: true })
      check(
        safety.getUpdateBlockReason() === 'updateWaitImport',
        'history replacement blocks updates'
      )
      store.useChatStore.setState({ importingHistory: false, sessionSaveErrors: { other: true } })
      check(
        safety.getUpdateBlockReason() === 'updateWaitStorage',
        'unsaved chat errors block updates'
      )
      store.useChatStore.setState({ sessionSaveErrors: {} })
      edits.usePendingEdits.setState({ ids: new Set(['edit-message', 'recording']) })
      check(
        safety.getUpdateBlockReason() === 'updateWaitDrafts',
        'message edits and active recording block updates'
      )
      edits.usePendingEdits.setState({ ids: new Set() })
      const put = IDBObjectStore.prototype.put
      IDBObjectStore.prototype.put = function (...args) {
        if (this.transaction.db.name === 'deepchat-drafts') {
          throw new DOMException('Injected failure', 'QuotaExceededError')
        }
        return put.apply(this, args)
      }
      drafts.setDraftText(null, 'keep after failed write')
      check(
        !(await drafts.flushDrafts()) && drafts.useDrafts.getState().saveError,
        'draft quota failure remains visible and retriable'
      )
      check(
        drafts.getDraft(null).text === 'keep after failed write',
        'failed persistence never clears in-memory draft'
      )
      IDBObjectStore.prototype.put = put
      check(
        (await drafts.flushDrafts()) && !drafts.useDrafts.getState().saveError,
        'retry commits pending draft after storage recovers'
      )
      drafts.clearDraft(null)
      return results
    }))
  )
  await load()
  assert.equal(await page.evaluate(() => window.testModules.drafts.getDraft(null).text), '')
  checks.push('immediate reload after clearing does not resurrect an old draft')
  await page.evaluate(() => {
    localStorage.setItem(
      'deepchat:draft-journal:v1',
      JSON.stringify({
        savedAt: Date.now() + 1000,
        drafts: [
          {
            sessionId: null,
            text: 'recover text even with missing file',
            attachmentIds: ['never-committed'],
          },
        ],
      })
    )
  })
  await load()
  assert.deepEqual(
    await page.evaluate(() => [
      window.testModules.drafts.getDraft(null).text,
      window.testModules.drafts.useDrafts.getState().recoveryWarning,
    ]),
    ['recover text even with missing file', true]
  )
  checks.push('missing uncommitted attachment is reported while text is recovered')

  // Separate pages share real storage, but none of their Zustand snapshots or timers.
  const tabs = await browser.newContext()
  await tabs.route('**/*', routeFixture)
  const [first, second, recovered] = await Promise.all([
    tabs.newPage(), tabs.newPage(), tabs.newPage(),
  ])
  for (const tab of [first, second, recovered]) {
    tab.on('pageerror', (error) => errors.push(error.message))
  }
  await load(first)
  await load(second)
  const deferWrites = (tab) => tab.evaluate(() => {
    const timer = window.setTimeout
    window.setTimeout = (callback, delay, ...args) =>
      timer(callback, delay === 250 ? 60_000 : delay, ...args)
  })
  await deferWrites(first)
  await deferWrites(second)
  await first.evaluate(async () => {
    const { drafts } = window.testModules
    drafts.setDraftText('first', 'committed in the first tab')
    await drafts.flushDrafts()
  })
  await second.evaluate(() => {
    window.testModules.drafts.setDraftText('second', 'pending in the second tab')
  })
  await load(second)
  assert.deepEqual(await second.evaluate(async () => {
    const { drafts, storage } = window.testModules
    await drafts.flushDrafts()
    return (await storage.readStoredDrafts()).drafts.map((draft) => draft.sessionId).sort()
  }), ['first', 'second'])
  checks.push('another tab journal cannot delete an already committed draft during recovery')

  await deferWrites(second)
  await first.evaluate(() => window.testModules.drafts.setDraftText('pending-a', 'pending A'))
  await second.evaluate(() => window.testModules.drafts.setDraftText('pending-b', 'pending B'))
  await load(recovered)
  assert.deepEqual(await recovered.evaluate(() => [
    window.testModules.drafts.getDraft('pending-a').text,
    window.testModules.drafts.getDraft('pending-b').text,
  ]), ['pending A', 'pending B'])
  await recovered.evaluate(() => window.testModules.drafts.flushDrafts())
  checks.push('uncommitted journals from two pages both survive a third page hydration')

  await first.evaluate(() => {
    Date.now = () => 2_000_000_000_000
    window.testModules.drafts.setDraftText('shared', 'older pending text')
  })
  await second.evaluate(async () => {
    Date.now = () => 2_000_000_000_010
    window.testModules.drafts.setDraftText('shared', 'newer committed text')
    await window.testModules.drafts.flushDrafts()
  })
  await first.evaluate(() => window.testModules.drafts.flushDrafts())
  assert.equal(await recovered.evaluate(async () =>
    (await window.testModules.storage.readStoredDrafts()).drafts.find(
      (draft) => draft.sessionId === 'shared'
    ).text
  ), 'newer committed text')
  checks.push('a delayed flush from another page cannot roll back a newer row')

  await first.evaluate(() => {
    Date.now = () => 2_000_000_000_015
    window.testModules.drafts.setDraftText('shared', 'stale text before deletion')
    window.staleJournal = window.testModules.storage.readDraftJournal().find(
      (entry) => entry.sessionId === 'shared'
    )
  })
  await second.evaluate(async () => {
    Date.now = () => 2_000_000_000_020
    window.testModules.drafts.clearDraft('shared')
    await window.testModules.drafts.flushDrafts()
  })
  await first.evaluate(async () => {
    await window.testModules.drafts.flushDrafts()
    // Also test a surviving stale journal, independently of post-commit cleanup.
    window.testModules.storage.writeDraftJournal([window.staleJournal])
  })
  await load(recovered)
  assert.equal(await recovered.evaluate(() => window.testModules.drafts.getDraft('shared').text), '')
  assert.equal(await recovered.evaluate(async () =>
    (await window.testModules.storage.readStoredDrafts()).drafts.some(
      (draft) => draft.sessionId === 'shared'
    )
  ), false)
  checks.push('a persisted deletion blocks both stale tab flushes and stale recovery journals')

  await second.evaluate(async () => {
    Date.now = () => 2_000_000_000_030
    window.testModules.drafts.setDraftText('shared', 'intentional new draft')
    await window.testModules.drafts.flushDrafts()
  })
  await load(recovered)
  assert.equal(await recovered.evaluate(() => window.testModules.drafts.getDraft('shared').text),
    'intentional new draft')
  checks.push('a newer intentional edit can replace a deletion tombstone')

  assert.deepEqual(await recovered.evaluate(async () => {
    const { drafts, storage } = window.testModules
    const put = IDBObjectStore.prototype.put
    drafts.setDraftText('failed-race', 'before failed write')
    IDBObjectStore.prototype.put = function (...args) {
      if (this.transaction.db.name === 'deepchat-drafts' && this.name === 'drafts') {
        IDBObjectStore.prototype.put = put
        drafts.setDraftText('failed-race', 'typed during the failed write')
        throw new DOMException('Injected race', 'QuotaExceededError')
      }
      return put.apply(this, args)
    }
    const failed = !(await drafts.flushDrafts())
    const retried = await drafts.flushDrafts()
    return [failed, retried, (await storage.readStoredDrafts()).drafts.find(
      (draft) => draft.sessionId === 'failed-race'
    ).text]
  }), [true, true, 'typed during the failed write'])
  checks.push('retry after an interrupted write preserves edits made during that write')

  assert.equal(await first.evaluate(async () => {
    const { drafts, storage } = window.testModules
    Date.now = () => 2_000_000_000_100
    for (let index = 0; index < 200; index++) {
      drafts.setDraftText('continuous', `continuous typing ${index}`)
    }
    const entries = storage.readDraftJournal().filter((entry) => entry.sessionId === 'continuous')
    await drafts.flushDrafts()
    return entries.length
  }), 1)
  checks.push('continuous typing retains one journal per writer rather than one per keystroke')
  await second.evaluate(async () => {
    Date.now = () => 2_000_000_000_100
    window.testModules.drafts.setDraftText('continuous', 'later edit at the same wall clock')
    await window.testModules.drafts.flushDrafts()
  })
  assert.equal(await recovered.evaluate(async () =>
    (await window.testModules.storage.readStoredDrafts()).drafts.find(
      (draft) => draft.sessionId === 'continuous'
    ).text
  ), 'later edit at the same wall clock')
  checks.push('another page observes the committed logical clock before its next edit')

  await first.evaluate(() => {
    const { drafts } = window.testModules
    drafts.useDrafts.setState((state) => ({ drafts: new Map(state.drafts).set('attachment-race', {
      text: 'original file still pending',
      attachments: [{
        id: 'late-file',
        file: new File(['late original bytes'], 'late.txt', { type: 'text/plain' }),
        isImage: false,
        previewUrl: null,
      }],
    }) }))
  })
  await load(recovered)
  await recovered.evaluate(() => window.testModules.drafts.flushDrafts())
  assert.equal(await recovered.evaluate(() => window.testModules.drafts.getDraft(
    'attachment-race'
  ).attachments.length), 0)
  await first.evaluate(() => window.testModules.drafts.flushDrafts())
  assert.equal(await recovered.evaluate(async () =>
    (await window.testModules.storage.readStoredDrafts()).drafts.find(
      (draft) => draft.sessionId === 'attachment-race'
    ).attachments[0].blob.text()
  ), 'late original bytes')
  await load(recovered)
  assert.equal(await recovered.evaluate(() => window.testModules.drafts.getDraft(
    'attachment-race'
  ).attachments.length), 1)
  checks.push('text recovery winning a transaction race does not discard the original tab attachment')

  assert.deepEqual(await recovered.evaluate(async () => {
    const { storage } = window.testModules
    const before = await storage.readStoredDrafts()
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (value, ...args) {
      if (this.transaction.db.name === 'deepchat-drafts' && value?.id === 'session:atomic-b') {
        throw new DOMException('Injected synchronous clone failure', 'DataCloneError')
      }
      return put.call(this, value, ...args)
    }
    let failed = false
    try {
      await storage.writeStoredDrafts(['atomic-a', 'atomic-b'].map((id) => ({
        id: `session:${id}`,
        sessionId: id,
        text: 'must roll back together',
        attachments: [],
        revision: { at: storage.readDraftClock() + 1, writer: 'atomic-fixture' },
        deleted: false,
      })))
    } catch {
      failed = true
    } finally {
      IDBObjectStore.prototype.put = put
    }
    const after = await storage.readStoredDrafts()
    return [failed, after.savedAt === before.savedAt, after.drafts.some(
      (draft) => draft.sessionId?.startsWith('atomic-')
    )]
  }), [true, true, false])
  checks.push('synchronous row-write failure aborts every row and metadata in the transaction')

  await recovered.evaluate(() => {
    localStorage.setItem('deepchat:draft-journal:v1', JSON.stringify({
      savedAt: 2_000_000_001_000,
      drafts: [{ sessionId: 'legacy', text: 'legacy recovery', attachmentIds: [] }],
    }))
  })
  await load(recovered)
  assert.deepEqual(await recovered.evaluate(() => [
    window.testModules.drafts.getDraft('legacy').text,
    window.testModules.drafts.getDraft('first').text,
    window.testModules.drafts.getDraft('shared').text,
  ]), ['legacy recovery', 'committed in the first tab', 'intentional new draft'])
  checks.push('legacy snapshot migration keeps committed drafts absent from its old snapshot')
  await tabs.close()

  assert.equal(unexpectedNetwork, 0)
  checks.push('all recovery and update checks made zero external requests')
  assert.equal(errors.length, 0, errors.join('\n'))
  process.stdout.write(JSON.stringify({ passed: checks.length, checks, temporary }, null, 2) + '\n')
} finally {
  await browser.close()
}
