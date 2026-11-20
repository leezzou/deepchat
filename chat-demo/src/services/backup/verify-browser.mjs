// Run from chat-demo: node src/services/backup/verify-browser.mjs
// Uses the workspace's existing Playwright and Chrome; does not start a server or use real user data.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { rspack } from '@rspack/core'
import { chromium } from '../../../../tools/node_modules/playwright/index.mjs'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const temporary = await mkdtemp(path.join(tmpdir(), 'deepchat-backup-verification-'))
const entry = path.join(temporary, 'entry.ts')
const modules = {
  backup: 'services/chat/backup.ts', db: 'services/chat/db.ts', store: 'services/chat/store.ts',
  drafts: 'services/chat/drafts.ts', storage: 'services/backup/storage.ts', automatic: 'services/backup/automatic.ts',
  toast: 'components/base/toastState.ts', settings: 'services/settings.ts', archive: 'services/chat/history/exportArchive.ts',
  toArchive: 'services/chat/history/toArchive.ts', toLocal: 'services/chat/history/toLocal.ts',
  schema: 'services/chat/history/schema.ts', zip: 'services/chat/history/zipWriter.ts',
  ...(process.argv.includes('--portable') && { crypto: 'services/backup/portableCrypto.ts', dav: 'services/backup/webDav.ts', metadata: 'services/backup/portableMetadata.ts', library: 'services/library/index.ts', modes: 'services/conversationMode/storage.ts' }),
}
await writeFile(entry, Object.entries(modules).map(([name, file]) =>
  `import * as ${name} from ${JSON.stringify(path.join(root, 'src', file))}`
).join('\n') + `\nwindow.testModules = { ${Object.keys(modules).join(', ')} }\n`)
const compiler = rspack({
  mode: 'development', entry, devtool: false,
  output: { path: temporary, filename: 'test.js', publicPath: '/', chunkFilename: '[id].js' },
  resolve: { extensions: ['.ts', '.tsx', '.js'], extensionAlias: { '.js': ['.ts', '.tsx', '.js'] } },
  module: { rules: [{ test: /\.tsx?$/, loader: 'builtin:swc-loader', options: { jsc: { parser: { syntax: 'typescript', tsx: true } } } }] },
  plugins: [new rspack.DefinePlugin({ __API_ORIGIN__: JSON.stringify('https://example.invalid') })],
})
await new Promise((resolve, reject) => compiler.run((error, stats) => {
  compiler.close(() => {})
  if (error || stats?.hasErrors()) {reject(error ?? new Error(stats.toString({ all: false, errors: true })))}
  else {resolve()}
}))
const snapshotScale = process.argv.includes('--snapshot-scale')
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: snapshotScale ? ['--js-flags=--max-old-space-size=96'] : [],
})
try {
  if (process.argv.includes('--portable')) {
    await (await import('./verify-portable.mjs')).verifyPortable(browser,temporary)
  } else {
  const page = await browser.newPage()
  const pageErrors = []
  if (snapshotScale) {page.on('console', (message) => process.stderr.write(`${message.text()}\n`))}
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.route('https://backup.test/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname
    if (pathname === '/') {await route.fulfill({ contentType: 'text/html', body: '<html><body><script src="/test.js"></script></body></html>' })}
    else {await route.fulfill({ contentType: 'text/javascript', body: await readFile(path.join(temporary, path.basename(pathname))) })}
  })
  await page.goto('https://backup.test/')
  await page.waitForFunction(() => !!window.testModules)
  const results = snapshotScale ? await Promise.race([
    page.evaluate((await import('./snapshot/verify-scale.mjs')).verifySnapshotScale),
    page.waitForEvent('crash', { timeout: 90000 }).then(() => { throw new Error('Renderer crashed during snapshot-scale check') }),
  ]) : await page.evaluate(async () => {
    const { backup, db, store, drafts, storage, automatic, settings, toArchive, toLocal, schema, zip } = window.testModules
    const results = []
    const check = (condition, label) => { if (!condition) {throw new Error(label);} results.push(label) }
    const reject = async (action, label) => { let failed = false; try { await action() } catch { failed = true } check(failed, label) }
    await drafts.initDrafts()
    await store.initChat()
    const fixture = {
      id: 'original', title: 'Original conversation', createdAt: 1700000000000, updatedAt: 1700000000010,
      rootMessageId: 'u-old',
      messages: [
        { id: 'u-old', parentId: null, selectedChildId: 'a-old', role: 'user', createdAt: 1700000000000, content: 'preserve original question', files: [
          { id: 'attachment', name: 'notes.txt', mimeType: 'text/plain', isImage: false, serverId: null, size: 8 },
        ] },
        { id: 'a-old', parentId: 'u-old', contextUserId: 'u-old', selectedChildId: 'u-new', role: 'assistant', createdAt: 1700000000001, model: 'deepseek-flash', prefix: false, status: 'done', blocks: [{ type: 'text', text: 'preserve original answer' }] },
        { id: 'u-new', parentId: 'a-old', selectedChildId: 'a-new', role: 'user', createdAt: 1700000000002, content: 'excluded round', files: [] },
        { id: 'a-new', parentId: 'u-new', role: 'assistant', createdAt: 1700000000003, model: null, prefix: false, status: 'done', blocks: [{ type: 'text', text: 'excluded answer' }] },
      ],
      checkpoint: { text: 'summary', createdAt: 1700000000009, coveredMessages: 2, coveredMessageIds: ['u-old', 'a-old'] },
      compactedThrough: 'a-old', excludedContextRoundIds: ['u-new'],
    }
    await db.saveSession(fixture, [{ id: 'attachment', blob: new Blob(['original'], { type: 'text/plain' }) }])
    store.useChatStore.setState({ ready: true, sessions: [{ id: fixture.id, title: fixture.title, createdAt: fixture.createdAt, updatedAt: fixture.updatedAt }], sessionCache: { [fixture.id]: fixture } })
    drafts.setDraftText('original', 'unsent draft')
    settings.useSettings.setState({ apiKey: 'SECRET_NOT_FOR_BACKUP' })
    const mapped = toArchive.toSessionFile(fixture, () => null)
    const restored = toLocal.toLocalSession(schema.readSessionFile(mapped)).session
    check(restored.messages.length === 4 && restored.messages[0].content === fixture.messages[0].content, 'ZIP metadata conversion retains original messages')
    check(restored.excludedContextRoundIds[0] === '3' && restored.compactedThrough === '2' && restored.checkpoint.coveredMessageIds.join(',') === '1,2', 'context references survive archive ID remapping')
    check(restored.messages[1].contextUserId === '1', 'original question anchors survive ID remapping')
    const orphan = { ...fixture, rootMessageId: 'a-old', messages: [{ ...fixture.messages[1], parentId: null, selectedChildId: undefined, contextUserId: 'deleted-user' }], checkpoint: undefined, compactedThrough: undefined, excludedContextRoundIds: undefined }
    const restoredOrphan = toLocal.toLocalSession(schema.readSessionFile(toArchive.toSessionFile(orphan, () => null))).session
    check(restoredOrphan.messages[0].contextUserId === null && restoredOrphan.messages[0].role === 'assistant', 'deleted-question answers remain explicitly orphaned after round trip')
    const malformed = structuredClone(mapped)
    malformed.deepchat_context.excluded_round_ids = [999]
    await reject(() => schema.readSessionFile(malformed), 'invalid context references are rejected')
    const generated = await backup.exportHistory()
    check(generated.saveStatus === 'generated' && (await storage.readBackup()).id === generated.id, 'generation persists a local backup without claiming saved')
    check(!(await generated.blob.text()).includes('SECRET_NOT_FOR_BACKUP'), 'API credentials are excluded')
    const originalClick = HTMLAnchorElement.prototype.click
    HTMLAnchorElement.prototype.click = () => {}
    await backup.saveLatestBackup()
    check((await storage.readBackup()).saveStatus === 'download-requested', 'browser delivery records download requested, never saved')
    await backup.confirmBackupSaved(generated.id)
    check((await storage.readBackup()).saveStatus === 'confirmed', 'only explicit confirmation marks saved')
    HTMLAnchorElement.prototype.click = originalClick
    await backup.clearHistory()
    const snapshot = await storage.readSafetySnapshot()
    check(store.useChatStore.getState().sessions.length === 0 && snapshot.sessions[0].id === 'original', 'clear captures original history before replacement')
    check(await snapshot.files[0].blob.text() === 'original' && snapshot.drafts[0].text === 'unsent draft', 'safety snapshot preserves non-image originals and drafts')
    await backup.restoreSafetySnapshot()
    check((await db.loadSession('original')).checkpoint.text === 'summary' && drafts.getDraft('original').text === 'unsent draft', 'restore recovers history, metadata and unsent draft')
    check((await storage.readSafetySnapshot()).reason === 'before-restore' && (await storage.readSafetySnapshot()).sessions.length === 0, 'restore first preserves current state for undo')
    const beforeFailure = await storage.readSafetySnapshot()
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function(value, key) {
      if (this.transaction.db.name === 'chat-demo-backups' && this.name === 'snapshots' && key === 'latest') {throw new DOMException('Injected quota failure', 'QuotaExceededError')}
      return put.call(this, value, key)
    }
    await reject(() => backup.clearHistory(), 'snapshot write failure aborts clear')
    await reject(() => backup.importHistory(new File([generated.blob], generated.name)), 'snapshot write failure aborts valid import')
    await reject(() => backup.restoreSafetySnapshot(), 'snapshot write failure aborts restore')
    IDBObjectStore.prototype.put = put
    check(!!await db.loadSession('original') && (await storage.readSafetySnapshot()).id === beforeFailure.id, 'failed snapshot retains current history and previous snapshot')
    const invalid = new File([await zip.writeArchive([
      { name: 'manifest.json', blob: new Blob([JSON.stringify({ export_format_version: 3 })]) },
      { name: 'chat_sessions/broken.json', blob: new Blob(['{bad json']) },
    ])], 'bad.zip')
    await reject(() => backup.importHistory(invalid), 'malformed archive is rejected before snapshot replacement')
    check(!!await db.loadSession('original') && (await storage.readSafetySnapshot()).id === beforeFailure.id, 'bad archive leaves history and safety snapshot intact')
    await backup.importHistory(new File([generated.blob], generated.name))
    const imported = await db.loadSession('original')
    check(imported.excludedContextRoundIds[0] === '3' && imported.checkpoint.coveredMessageIds.join(',') === '1,2', 'full ZIP import preserves context metadata')
    check((await storage.readSafetySnapshot()).sessions[0].messages[0].id === 'u-old', 'valid import captures untouched source session')
    await backup.restoreSafetySnapshot()
    const stop = automatic.initializeAutoBackup()
    await backup.loadBackupState()
    check((await storage.readBackupPreferences()).completedRounds === 0, 'auto initialization ignores existing completed history')
    const send = async (index, status = 'done') => {
      const controller = new AbortController()
      const user = { id: `round-${index}`, role: 'user', content: 'question', files: [], createdAt: Date.now(), parentId: null }
      const reply = { id: `reply-${index}`, role: 'assistant', createdAt: Date.now(), parentId: user.id, model: null, prefix: false, status: 'pending', blocks: [] }
      const session = { ...fixture, checkpoint: undefined, compactedThrough: undefined, excludedContextRoundIds: undefined, rootMessageId: user.id, messages: [user, reply] }
      store.useChatStore.setState({ sessionCache: { original: session }, streaming: { original: controller } })
      store.useChatStore.setState({ sessionCache: { original: { ...session, messages: [user, { ...reply, status, blocks: [{ type: 'text', text: 'answer' }] }] } }, streaming: {} })
      await backup.confirmBackupSaved(generated.id) // manual operation waits for subscriber's queued task
    }
    await send('error', 'error')
    await send('stopped', 'stopped')
    check((await storage.readBackupPreferences()).completedRounds === 0, 'errors and stopped requests do not count as completed rounds')
    for (let index = 1; index <= 9; index++) {await send(index)}
    check((await storage.readBackupPreferences()).completedRounds === 9, 'no automatic backup before ten completed rounds')
    check(!(await storage.readBackupArtifacts()).automatic, 'nine rounds leave the automatic slot empty')
    await send(10)
    const automaticBackup = (await storage.readBackupArtifacts()).automatic
    check(automaticBackup?.reason === 'automatic' && automaticBackup.saveStatus === 'generated', 'tenth completed round generates a local backup without downloading')
    check((await storage.readBackup()).id === generated.id, 'automatic write preserves the manual export')
    check((await storage.readBackupPreferences()).completedRounds === 0, 'automatic counter resets only after successful generation')
    await send(10)
    check((await storage.readBackupPreferences()).completedRounds === 0, 'retry of the same user round does not count twice')
    stop()
    return results
  })
  if (!snapshotScale) {
    results.push(...await page.evaluate((await import('./verify-automatic.mjs')).verifyAutomatic))
  }
  assert.equal(pageErrors.length, 0, pageErrors.join('\n'))
  process.stdout.write(JSON.stringify({ passed: results.length, checks: results, temporary }, null, 2) + '\n')
  }
} finally {
  await browser.close()
}
