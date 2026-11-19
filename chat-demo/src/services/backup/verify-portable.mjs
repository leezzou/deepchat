// Invoked by verify-browser.mjs --portable. Two isolated Chrome profiles, real HTTPS PUT/GET/DELETE.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:https'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

export async function verifyPortable(browser, temporary) {
  const key = path.join(temporary, 'tls.key'),
    cert = path.join(temporary, 'tls.crt')
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-keyout',
      key,
      '-out',
      cert,
    ],
    { stdio: 'ignore' }
  )
  const remote = new Map()
  const calls = []
  let cutDownload = false
  const server = createServer(
    { key: await readFile(key), cert: await readFile(cert) },
    async (req, res) => {
      const url = req.url
      try {
        if (url.startsWith('/dav/')) {
          calls.push(req.method)
          assert.equal(req.headers.cookie, undefined)
          if (
            req.headers.authorization !==
            'Basic ' + Buffer.from('test:TEST_DAV_SECRET').toString('base64')
          ) {
            res.writeHead(401).end()
            return
          }
          if (req.method === 'PUT') {
            const chunks = []
            for await (const chunk of req) {
              chunks.push(chunk)
            }
            remote.set(url, Buffer.concat(chunks))
            res.writeHead(201).end()
            return
          }
          if (!remote.has(url)) {
            res.writeHead(404).end()
            return
          }
          if (req.method === 'DELETE') {
            remote.delete(url)
            res.writeHead(204).end()
            return
          }
          if (cutDownload) {
            res.writeHead(200, { 'content-length': remote.get(url).byteLength })
            res.write(remote.get(url).subarray(0, 16))
            res.socket.destroy()
            return
          }
          res.end(remote.get(url))
          return
        }
        if (url === '/') {
          res.setHeader('content-type', 'text/html')
          res.end('<script src="/test.js"></script>')
          return
        }
        if (!/^\/[\w.-]+\.js$/.test(url)) {
          res.writeHead(404).end()
          return
        }
        res.setHeader('content-type', 'text/javascript')
        res.end(await readFile(path.join(temporary, path.basename(url))))
      } catch {
        res.writeHead(500).end()
      }
    }
  )
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `https://127.0.0.1:${server.address().port}`
  const contexts = []
  async function device() {
    const context = await browser.newContext({ ignoreHTTPSErrors: true })
    contexts.push(context)
    const page = await context.newPage()
    await page.goto(origin)
    await page.evaluate(async () => {
      const m = window.testModules
      await m.metadata.recoverPortableRestore()
      await Promise.all([m.store.initChat(), m.drafts.initDrafts()])
      window.davAccount = {
        folder: location.origin + '/dav/',
        username: 'test',
        password: 'TEST_DAV_SECRET',
      }
      window.phrase = 'independent secret 123'
      window.restore = async (pass = phrase) => {
        const data = await m.crypto.openBackup(await m.dav.getEncryptedBackup(davAccount), pass)
        return m.backup.restorePortableHistory(data.file, data.metadata)
      }
      window.seed = async (id) => {
        const session = {
          id,
          title: id,
          createdAt: 1,
          updatedAt: 2,
          rootMessageId: 'question',
          messages: [
            {
              id: 'question',
              role: 'user',
              parentId: null,
              selectedChildId: 'answer',
              createdAt: 1,
              content: id,
              files: [],
            },
            {
              id: 'answer',
              role: 'assistant',
              parentId: 'question',
              createdAt: 2,
              status: 'done',
              prefix: false,
              model: null,
              blocks: [{ type: 'text', text: 'reply ' + id }],
            },
          ],
        }
        await m.db.saveSession(session)
        m.store.useChatStore.setState({
          sessions: [session],
          sessionCache: { [id]: session },
          ready: true,
        })
        m.library.createFolder(id, id, true)
        m.library.addMemory('memory ' + id, id)
        m.library.toggleFavorite(id, 'answer', 'reply ' + id)
        const template = m.modes.savePromptTemplate('template ' + id, 'instruction ' + id)
        m.modes.setConversationMode(id, { templateId: template, profileId: 'local-profile-id' })
        m.drafts.setDraftText(id, 'local draft ' + id)
      }
      window.inspect = async () => ({
        history: (await m.db.loadSessionSummaries()).map((x) => x.id),
        library: m.library.exportLibrarySnapshot(),
        modes: m.modes.exportConversationModes(),
        drafts: m.drafts.captureDrafts().map((row) => row.text),
      })
    })
    return page
  }
  try {
    const source = await device()
    await source.evaluate(async () => {
      const m = window.testModules
      await seed('source')
      m.settings.useSettings.setState({ apiKey: 'TEST_API_SECRET', accountName: 'TEST_ACCOUNT_ID' })
      await m.dav.testDavConnection(davAccount)
      const data = await m.backup.exportPortableHistory()
      // Previous releases serialized the selected built-in as an ID. Emulate that archive on the wire.
      data.metadata.modes.sessions[0].templateId = 'translation'
      const plaintext = (await data.zip.text()) + JSON.stringify(data.metadata)
      for (const marker of [
        'TEST_API_SECRET',
        'TEST_ACCOUNT_ID',
        'TEST_DAV_SECRET',
        'local draft source',
      ]) {
        if (plaintext.includes(marker)) {
          throw Error('unexpected credential or draft')
        }
      }
      await m.dav.putEncryptedBackup(
        davAccount,
        await m.crypto.sealBackup(data.zip, data.metadata, phrase)
      )
    })
    assert.deepEqual(calls, ['PUT', 'GET', 'DELETE', 'PUT'])
    const sealed = remote.get('/dav/deepchat-backup.dcb')
    assert.equal(sealed.subarray(0, 8).toString(), 'DCHATBK1')
    for (const marker of [
      'source',
      'memory source',
      'TEST_API_SECRET',
      'TEST_DAV_SECRET',
      'independent secret',
    ]) {
      assert.equal(sealed.includes(marker), false)
    }
    const clean = await device()
    assert.deepEqual((await clean.evaluate(() => inspect())).history, [])
    assert.equal(await clean.evaluate(() => restore()), 1)
    const restored = await clean.evaluate(() => inspect())
    assert.deepEqual(restored.history, ['source'])
    assert.equal(restored.library.favorites[0].messageId, 'answer')
    assert.equal(restored.library.memories[0].text, 'memory source')
    assert.equal(restored.library.memories[0].sessionId, 'source')
    assert.equal(
      restored.library.folders.find((folder) => folder.name === 'source').shareMemory,
      true
    )
    assert.equal(restored.modes.templates[0].prompt, 'instruction source')
    assert.deepEqual(restored.modes.sessions[0], {
      sessionId: 'source',
      profileId: 'local-profile-id',
    })
    assert.equal(
      await clean.evaluate(async () => (await testModules.db.loadSession('source')).messages[1].id),
      'answer'
    )
    assert.deepEqual(restored.drafts, [])
    const dest = await device()
    await dest.evaluate(() => seed('original'))
    const before = await dest.evaluate(() => inspect())
    await assert.rejects(
      dest.evaluate(() => restore('wrong-password')),
      /decrypt/
    )
    cutDownload = true
    await assert.rejects(
      dest.evaluate(() => restore()),
      /network/
    )
    cutDownload = false
    assert.deepEqual(await dest.evaluate(() => inspect()), before)
    await dest.evaluate(() => {
      const put = IDBObjectStore.prototype.put
      IDBObjectStore.prototype.put = function (value, key) {
        if (this.name === 'historyMeta' && key === 'active') {
          IDBObjectStore.prototype.put = put
          throw Error('injected failed generation flip')
        }
        return put.call(this, value, key)
      }
    })
    await assert.rejects(
      dest.evaluate(() => restore()),
      /injected/
    )
    assert.deepEqual(await dest.evaluate(() => inspect()), before)
    const cancelled = await dest.evaluate(async () => {
      const { file, metadata } = await testModules.crypto.openBackup(
        await testModules.dav.getEncryptedBackup(davAccount),
        phrase
      )
      try {
        await testModules.backup.restorePortableHistory(file, metadata, () => false)
        return false
      } catch {
        return true
      }
    })
    assert.equal(cancelled, true)
    assert.deepEqual(await dest.evaluate(() => inspect()), before)
    assert.equal(await dest.evaluate(() => restore()), 1)
    assert.equal(await dest.evaluate(() => testModules.backup.restoreSafetySnapshot()), 1)
    assert.deepEqual(await dest.evaluate(() => inspect()), before)
    // Simulate process loss after metadata writes and before IDB pointer flip. Restart uses the journal.
    await dest.evaluate(async () => {
      const m = testModules
      await m.db.clearStaging()
      const next = m.metadata.capturePortableMetadata(['original'])
      next.library.memories = []
      await m.metadata.stagePortableMetadata(next, ['original'], ['original'])
    })
    await dest.reload()
    const recovered = await dest.evaluate(async () => {
      await testModules.metadata.recoverPortableRestore()
      return testModules.library.exportLibrarySnapshot()
    })
    assert.deepEqual(recovered, before.library)
    // Kill the page after the history transaction, before draft reconciliation.
    await dest.evaluate(async () => {
      const m = testModules
      await m.drafts.initDrafts()
      await m.db.clearStaging()
      const target = m.metadata.capturePortableMetadata([])
      target.library.memories = []
      await m.metadata.stagePortableMetadata(target, [], ['original'])
      await m.db.commitStaging()
    })
    await dest.reload()
    assert.deepEqual(
      await dest.evaluate(async () => {
        const m = testModules
        await m.metadata.recoverPortableRestore()
        return [
          await m.db.loadSessionSummaries(),
          m.drafts.captureDrafts(),
          m.library.exportLibrarySnapshot().memories,
        ]
      }),
      [[], [], []]
    )
    process.stdout.write(
      'PASS: real HTTPS connection probe, encrypted upload, fresh-profile restore, stable favorite IDs, template/memory/credential boundary, wrong password, interrupted download, failed DB commit, unmounted cancellation, safety snapshot undo, restart rollback\n'
    )
  } finally {
    for (const context of contexts) {
      await context.close()
    }
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
}
