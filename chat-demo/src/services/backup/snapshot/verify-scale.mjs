// node src/services/backup/verify-browser.mjs --snapshot-scale (fresh origin, 96 MiB V8 old space).
export async function verifySnapshotScale() {
  const { archive, backup, db, drafts, storage, store } = window.testModules
  const checks = []
  const check = (condition, label) => {
    if (!condition) {
      throw new Error(label)
    }
    checks.push(label)
  }
  const request = (req) => new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  const completed = (tx) => new Promise((resolve, reject) => {
    tx.oncomplete = resolve
    tx.onabort = () => reject(tx.error)
  })
  const conversation = (id, content) => ({
    id, title: id, createdAt: 1, updatedAt: 1,
    messages: [{ role: 'user', id: 'question', files: [], createdAt: 1, content }],
  })
  const info = { id: 'old', name: 'old.zip', createdAt: 1, sessionCount: 1, reason: 'before-import', saveStatus: 'generated' }
  const open = indexedDB.open('chat-demo-backups', 1)
  open.onupgradeneeded = () => {
    for (const name of ['snapshots', 'artifacts', 'preferences']) {
      open.result.createObjectStore(name)
    }
  }
  const v1 = await request(open)
  const seed = v1.transaction('snapshots', 'readwrite')
  for (const key of ['latest', 'previous']) {
    seed.objectStore('snapshots').put({ ...info, sessions: [conversation(key, key)], files: [], id: key }, key)
  }
  await completed(seed)
  v1.close()
  await drafts.initDrafts()
  await store.initChat()
  check(await backup.restoreSafetySnapshot() === 1 && (await db.loadSession('latest')).messages[0].content === 'latest', 'real v1 database upgraded and restored')
  const count = 36
  const bytes = 4 * 1024 * 1024
  const content = (index) => String.fromCharCode(65 + index).repeat(bytes)
  for (let index = 0; index < count; index++) {
    await db.saveSession(conversation(`scale-${index}`, content(index)))
  }
  store.useChatStore.setState({ sessions: await db.loadSessionSummaries(), sessionCache: {} })
  const replacement = new File([await archive.exportArchive([conversation('new', 'synthetic replacement')])], 'replacement.zip')
  // eslint-disable-next-line no-console
  console.info('Starting overwrite of 36 uncached sessions with 144 MiB of synthetic text')
  check(await backup.importHistory(replacement) === 1, '144 MiB old text history replaced under a 96 MiB V8 old-space limit')
  const latest = await storage.readSnapshotRecord()
  check(!('sessions' in latest) && latest.parts === count + 2 && JSON.stringify(latest).length < 512, `${latest.parts} snapshot parts and a ${JSON.stringify(latest).length}-character latest pointer`)
  const raw = await request(indexedDB.open('chat-demo-backups'))
  const get = (store, key) => request(raw.transaction(store).objectStore(store).get(key))
  const footprint = async () => JSON.stringify([
    await get('snapshots', 'latest'), await get('snapshots', 'previous'),
    await request(raw.transaction('snapshotParts').objectStore('snapshotParts').getAllKeys()),
  ])
  const before = await footprint()
  const add = IDBObjectStore.prototype.add
  IDBObjectStore.prototype.add = function (value, key) {
    if (this.name === 'snapshotParts' && key[1] === 1) {
      throw new DOMException('synthetic part failure', 'QuotaExceededError')
    }
    return add.call(this, value, key)
  }
  drafts.setDraftText('new', 'keep me') // First part commits before the injected second part fails.
  let failure
  try {
    await backup.importHistory(replacement)
  } catch (error) {
    failure = error
  } finally {
    IDBObjectStore.prototype.add = add
  }
  check(failure?.name === 'SnapshotError' && await footprint() === before && !(await get('snapshots', 'pending')), 'mid-snapshot quota failure preserves both generations and removes staged parts')
  check((await db.loadSession('new')).messages[0].content === 'synthetic replacement' && drafts.getDraft('new').text === 'keep me', 'failed overwrite leaves current records and drafts intact')
  const interrupted = raw.transaction(['snapshotParts', 'snapshots'], 'readwrite')
  interrupted.objectStore('snapshots').put({ ...info, id: 'interrupted', parts: 1 }, 'pending')
  interrupted.objectStore('snapshotParts').put({ session: conversation('abandoned', '') }, ['interrupted', 0])
  await completed(interrupted)
  check(await backup.restoreSafetySnapshot() === count + 1, 'large snapshot restored in full')
  for (let index = 0; index < count; index++) {
    if ((await db.loadSession(`scale-${index}`)).messages[0].content !== content(index)) {
      throw new Error(`Changed original text for scale-${index}`)
    }
  }
  check((await db.loadSession('latest')).messages[0].content === 'latest', 'all 144 MiB of restored message content verified plus the legacy session')
  check(!(await get('snapshotParts', ['interrupted', 0])) && !(await get('snapshots', 'pending')), 'next write reclaims a page-interrupted partial snapshot')
  raw.close()
  return checks
}
