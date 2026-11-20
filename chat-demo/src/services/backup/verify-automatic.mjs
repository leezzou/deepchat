// Runs after the real ten-round fixture in verify-browser.mjs, in the same isolated browser.
export async function verifyAutomatic() {
  const { backup, storage, store, db, automatic, toast } = window.testModules
  const checks = []
  function check(condition, text) {
    if (!condition) {
      throw new Error(text)
    }
    checks.push(text)
  }
  const artifacts = () => storage.readBackupArtifacts()
  const prefs = () => storage.readBackupPreferences()
  const safetyId = (await storage.readSnapshotRecord()).id
  const original = (await artifacts()).automatic
  const manual = (await artifacts()).manual
  const connection = await new Promise((resolve, reject) => {
    const request = indexedDB.open('chat-demo-backups')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  function seedLegacy(artifact, preference) {
    const tx = connection.transaction(['artifacts', 'preferences'], 'readwrite')
    tx.objectStore('artifacts').delete('automatic')
    tx.objectStore('artifacts').put(artifact, 'latest')
    tx.objectStore('preferences').put(preference, 'settings')
    return new Promise((resolve, reject) => {
      tx.oncomplete = resolve
      tx.onabort = () => reject(tx.error)
    })
  }
  const counts = (prefix, amount) =>
    Promise.all(
      Array.from({ length: amount }, (_, i) => backup.recordCompletedBackupRound(`${prefix}-${i}`))
    )

  try {
    await counts('quota', 9)
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (value, key) {
      // Fail after the artifact was queued, on the *last* write in its transaction.
      if (
        this.transaction.db.name === 'chat-demo-backups' &&
        this.name === 'preferences' &&
        value.completedRounds === 0
      ) {
        throw new DOMException('Injected quota failure', 'QuotaExceededError')
      }
      return put.call(this, value, key)
    }
    let failed = false
    try {
      await backup.recordCompletedBackupRound('quota-10')
    } catch {
      failed = true
    } finally {
      IDBObjectStore.prototype.put = put
    }
    check(
      failed &&
        (await artifacts()).automatic.id === original.id &&
        (await prefs()).completedRounds === 10,
      'quota failure rolls back both the ZIP replacement and the successful-generation counter'
    )
    check(
      await backup.recordCompletedBackupRound('quota-retry'),
      'next completed round retries after capacity recovers'
    )
    const retained = (await artifacts()).automatic

    // Withhold the worker result without stopping the event loop. Exercise the real abort and queue.
    const ActualWorker = window.Worker
    for (const action of ['disable', 'delete']) {
      await backup.setAutomaticBackup(false)
      await backup.setAutomaticBackup(true)
      await counts(action, 9)
      let started
      const paused = new Promise((resolve) => {
        started = resolve
      })
      window.Worker = class extends ActualWorker {
        postMessage() {
          started()
        }
      }
      try {
        const writing = backup.recordCompletedBackupRound(`${action}-10`)
        await paused
        check(
          backup.useBackupState.getState().operation === null,
          `${action}: pending worker keeps foreground settings available`
        )
        const queued = backup.recordCompletedBackupRound(`${action}-queued`)
        if (action === 'disable') {
          await backup.setAutomaticBackup(false)
        } else {
          await backup.deleteAutomaticBackup()
        }
        check(
          !(await writing) && !(await queued),
          `${action}: running and queued work cannot recreate the copy`
        )
        const p = await prefs()
        check(
          p.recentRoundIds.length === 0 && p.completedRounds === 0,
          `${action}: persisted counter and recent round IDs are cleared`
        )
        if (action === 'disable') {
          await counts('private', 12)
          check(
            !(await prefs()).recentRoundIds.length &&
              (await artifacts()).automatic.id === retained.id,
            'disabled completions store no identifiers and preserve the existing copy'
          )
        } else {
          check(
            !(await artifacts()).automatic && p.autoEnabled,
            'deletion removes only the automatic copy and preserves opt-in'
          )
        }
      } finally {
        window.Worker = ActualWorker
      }
    }
    check(
      (await artifacts()).manual.id === manual.id &&
        (await storage.readSnapshotRecord()).id === safetyId &&
        !!(await db.loadSession('original')),
      'privacy actions preserve the manual ZIP, operation safety snapshot and conversations'
    )

    const legacy = { ...original, id: 'older-automatic' }
    const off = { autoEnabled: false, completedRounds: 8, recentRoundIds: ['old-private-id'] }
    await seedLegacy(legacy, off)
    check(
      (await artifacts()).automatic.id === legacy.id && !(await artifacts()).manual,
      'legacy mixed-slot ZIP is identified by reason'
    )
    const privatePrefs = await prefs()
    check(
      !privatePrefs.autoEnabled &&
        !privatePrefs.recentRoundIds.length &&
        !privatePrefs.completedRounds,
      'upgrade respects legacy opt-out and scrubs identifiers collected by earlier versions'
    )
    await backup.exportHistory()
    check(
      (await artifacts()).automatic.id === legacy.id &&
        (await artifacts()).manual.reason === 'manual',
      'first manual export preserves a legacy automatic copy'
    )
    await seedLegacy(legacy, off)
    await backup.deleteAutomaticBackup()
    check(
      !(await artifacts()).automatic && !(await prefs()).autoEnabled,
      'in-place deletion handles an unmodified legacy slot and preserves opt-out'
    )

    // Simulate independently opened windows using their own transactions and the same old ticket.
    await backup.setAutomaticBackup(true)
    await Promise.all(Array.from({ length: 12 }, () => storage.countAutomaticRound('same-id')))
    check(
      (await prefs()).completedRounds === 1,
      'simultaneous transactions count the same user round once'
    )
    await Promise.all(
      Array.from({ length: 9 }, (_, i) => storage.countAutomaticRound(`parallel-${i}`))
    )
    const revision = (await prefs()).revision ?? 0
    const commits = await Promise.all([
      storage.commitAutomaticBackup(original, revision),
      storage.commitAutomaticBackup(legacy, revision),
    ])
    check(
      commits.filter(Boolean).length === 1 && (await prefs()).completedRounds === 0,
      'only one concurrent automatic writer can consume the threshold'
    )
    await backup.deleteAutomaticBackup()
    await counts('next-period', 9)
    await storage.countAutomaticRound('next-period-10')
    check(
      !(await storage.commitAutomaticBackup(original, revision)) && !(await artifacts()).automatic,
      'an obsolete writer remains rejected even after a new ten-round period'
    )

    // A private in-flight request does not become eligible just because the setting was re-enabled.
    await backup.setAutomaticBackup(false)
    const stop = automatic.initializeAutoBackup()
    try {
      const session = await db.loadSession('original')
      const id = session.id
      const controller = new AbortController()
      const reply = {
        ...session.messages.find((m) => m.role === 'assistant'),
        id: 'private-reply',
        status: 'pending',
      }
      const update = (status, streaming) =>
        store.useChatStore.setState({
          streaming,
          sessionCache: {
            [id]: { ...session, messages: [...session.messages, { ...reply, status }] },
          },
        })
      update('pending', { [id]: controller })
      await backup.setAutomaticBackup(true)
      update('done', {})
      await backup.recordCompletedBackupRound('public-round')
      check(
        (await prefs()).completedRounds === 1 &&
          (await prefs()).recentRoundIds[0] === 'public-round',
        'a request started with backup disabled stays private across a setting change'
      )

      const live = async (tag) => {
        const user = { ...session.messages.find((m) => m.role === 'user'), id: tag }
        const msg = { ...reply, id: `a-${tag}`, contextUserId: tag, parentId: tag }
        store.useChatStore.setState({
          streaming: { [id]: new AbortController() },
          sessionCache: {
            [id]: { ...session, messages: [user, { ...msg, status: 'pending' }] },
          },
        })
        store.useChatStore.setState({
          streaming: {},
          sessionCache: {
            [id]: { ...session, messages: [user, { ...msg, status: 'done' }] },
          },
        })
        await backup.recordCompletedBackupRound(`${id}:${tag}`) // duplicate: queue barrier only
      }
      await counts('background', 8)
      Object.defineProperty(document, 'hidden', { configurable: true, value: true })
      document.dispatchEvent(new Event('visibilitychange'))
      try {
        await live('hidden-completion')
      } finally {
        delete document.hidden
        document.dispatchEvent(new Event('visibilitychange'))
      }
      check(
        (await artifacts()).automatic && !toast.useToast.getState().message,
        'hidden completion commits locally without leaving a stale notice on return'
      )
      await counts('notice', 9)
      const existing = toast.showToast('Active user feedback')
      await live('visible-completion')
      check(
        toast.useToast.getState().id === existing,
        'automatic completion preserves competing user feedback'
      )
      toast.dismissToast(existing)
    } finally {
      stop()
    }
  } finally {
    connection.close()
  }
  return checks
}
