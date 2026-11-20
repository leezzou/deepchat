import { openDB, type DBSchema } from 'idb'

/** Keep the lease until all consumers (including IndexedDB transactions) finish. */
export type OwnedBlob = { blob: Blob; dispose(): Promise<void> }
const directoryName = 'deepchat-history-spool-v1'
const lockName = (name: string) => `${directoryName}/${name}`
const freshName = () => Array.from(crypto.getRandomValues(new Uint32Array(4)), n => n.toString(16).padStart(8, '0')).join('')
let sweep: Promise<void> | undefined

const remove = async (directory: FileSystemDirectoryHandle, name: string) => {
  try {
    await directory.removeEntry(name)
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error
  }
}

async function* boundedParts(source: AsyncIterable<Uint8Array>, limit: number) {
  // Network readers may supply arbitrarily large chunks. Writers bound each operation.
  for await (const chunk of source) {
    for (let i = 0; i < chunk.length; i += limit) yield chunk.subarray(i, i + limit)
  }
}

const spoolFile = async (
  directory: FileSystemDirectoryHandle, source: AsyncIterable<Uint8Array>, locks: LockManager
): Promise<OwnedBlob> => {
  // Reclaim files from a crashed page. A lease also protects a file owned by a different tab.
  sweep ??= (async () => {
    for await (const name of (directory as FileSystemDirectoryHandle & { keys(): AsyncIterable<string> }).keys()) {
      if (/^[0-9a-f]{32}$/.test(name)) {
        await locks.request(lockName(name), { ifAvailable: true }, async lock => {
          if (lock) await remove(directory, name)
        })
      }
    }
  })().catch(error => { sweep = undefined; throw error })
  await sweep
  const name = freshName()
  let release!: () => void
  const lifetime = new Promise<void>(resolve => { release = resolve })
  let ready!: (owned: OwnedBlob) => void
  let fail!: (error: unknown) => void
  const result = new Promise<OwnedBlob>((resolve, reject) => { ready = resolve; fail = reject })
  const holding = locks.request(lockName(name), async () => {
    const handle = await directory.getFileHandle(name, { create: true })
    try {
      const writer = await handle.createWritable()
      try {
        for await (const chunk of boundedParts(source, 1024 * 1024)) await writer.write(chunk as Uint8Array<ArrayBuffer>)
        await writer.close()
      } catch (error) {
        await writer.abort().catch(() => {})
        throw error
      }
      ready({ blob: await handle.getFile(), dispose: async () => { release(); await holding } })
      await lifetime
    } finally {
      await remove(directory, name)
    }
  })
  void holding.catch(fail)
  return result
}

interface Scratch extends DBSchema {
  part: { key: string; value: Blob }
}

/** Older WebViews: round-trip bounded parts through disk, retaining only composite Blob handles. */
export const spoolIndexedDB = async (source: AsyncIterable<Uint8Array>): Promise<OwnedBlob> => {
  const db = await openDB<Scratch>(directoryName, 1, { upgrade(db) { db.createObjectStore('part') } })
  const owner = freshName()
  const take = async () => {
    const tx = db.transaction('part', 'readwrite')
    const value = await tx.store.get(owner)
    if (value) await tx.store.delete(owner)
    await tx.done
    return value
  }
  const blockSize = 2 * 1024 * 1024
  const bins: (Blob | undefined)[] = []
  const buffer = new Uint8Array(blockSize)
  let used = 0
  const flush = async () => {
    // One scratch row per writer. A new import may reclaim that row between transactions.
    // Retrying the current bounded part is sufficient in that case.
    const part = new Blob([buffer.subarray(0, used)])
    let disk: Blob | undefined
    do {
      await db.put('part', part, owner)
      disk = await take()
    } while (!disk)
    // Binary merging keeps O(log(parts)) JS handles; payloads are owned by Blob storage.
    let i = 0
    while (bins[i]) {
      disk = new Blob([bins[i]!, disk]); bins[i++] = undefined
    }
    bins[i] = disk
    used = 0
  }
  try {
    // Reclaim a single unconsumed part left by each interrupted writer.
    await db.clear('part')
    for await (const chunk of source) {
      for (let i = 0; i < chunk.length;) {
        const n = Math.min(chunk.length - i, blockSize - used)
        buffer.set(chunk.subarray(i, i + n), used); i += n; used += n
        if (used === blockSize) await flush()
      }
    }
    if (used) await flush()
    return { blob: new Blob(bins.reverse().filter((part): part is Blob => !!part)), dispose: async () => {} }
  } finally {
    try { await take() } finally { db.close() }
  }
}

/** Consume once, with backpressure. Write/CRC/network errors clean up the partial result. */
export const spoolBlob = async (source: AsyncIterable<Uint8Array>): Promise<OwnedBlob> => {
  const nav = globalThis.navigator
  if (nav?.storage?.getDirectory && nav.locks && typeof globalThis.FileSystemFileHandle?.prototype.createWritable === 'function') {
    const root = await nav.storage.getDirectory()
    const directory = await root.getDirectoryHandle(directoryName, { create: true })
    return spoolFile(directory, source, nav.locks)
  }
  return spoolIndexedDB(source)
}
