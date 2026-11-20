import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
const { chromium } = createRequire(new URL('../../../../../tools/package.json', import.meta.url))('playwright')
const project = new URL('../../../../', import.meta.url)

// ZIP_SCALE_FILE can be a 2 GiB STORE archive, or a single DEFLATE member expanding to 2 GiB of zeros.
test('OPFS and IDB spools commit independent Blobs and clean up after CRC/writer failures', async () => {
  const profile = await mkdtemp(path.join(tmpdir(), 'zip-spool-browser-'))
  let browser
  try {
    browser = await chromium.launchPersistentContext(profile, {
      headless: true, ...(process.env.CHROME_EXECUTABLE_PATH ? { executablePath: process.env.CHROME_EXECUTABLE_PATH } : {})
    })
    const page = await browser.newPage()
    const files = new Map([
      ['/spool.js', new URL('./spool.ts', import.meta.url)],
      ['/zipReader.js', new URL('./zipReader.ts', import.meta.url)],
      ['/archiveSource.js', new URL('./archiveSource.ts', import.meta.url)],
      ['/idb.js', new URL('node_modules/idb/build/index.js', project)],
      ['/fflate.js', new URL('node_modules/fflate/esm/browser.js', project)],
    ])
    await page.route('https://localhost/**', async route => {
      const file = files.get(new URL(route.request().url()).pathname)
      if (!file) return route.fulfill({ contentType: 'text/html', body: '<input type=file>' })
      let body = await readFile(file, 'utf8')
      if (file.pathname.endsWith('.ts')) body = stripTypeScriptTypes(body).replaceAll("from 'idb'", "from './idb.js'").replaceAll("from 'fflate'", "from './fflate.js'")
      return route.fulfill({ contentType: 'application/javascript', body })
    })
    await page.goto('https://localhost/')
    if (process.env.ZIP_SCALE_FILE) await page.locator('input').setInputFiles(process.env.ZIP_SCALE_FILE)
    const report = await page.evaluate(async runScale => {
      const { spoolBlob } = await import('/spool.js')
      const { readEntry, readDirectory, readArchive } = await import('/zipReader.js')
      const { openDB } = await import('/idb.js')
      const db = await openDB('spool-test', 1, { upgrade(database) { database.createObjectStore('persisted') } })
      const read = async (blob, start, length = 1) => new Uint8Array(await blob.slice(start, start + length).arrayBuffer())
      const dirName = 'deepchat-history-spool-v1'
      const root = await navigator.storage.getDirectory()
      const dir = await root.getDirectoryHandle(dirName, { create: true })
      const scratch = async () => { const names = []; for await (const key of dir.keys()) names.push(key); return names }
      const assert = (ok, label) => { if (!ok) throw new Error(label) }
      const checked = []
      try {
        if (runScale) {
          const file = document.querySelector('input').files[0]
          for await (const entry of readArchive(file, await readDirectory(file))) {
            const owned = await readEntry(entry)
            try { await db.put('persisted', owned.blob.slice(0, owned.blob.size, 'application/octet-stream'), 'scale') }
            finally { await owned.dispose() }
            const saved = await db.get('persisted', 'scale')
            assert((file.size === 2 ** 31 || entry.size === 2 ** 31) && saved.size === entry.size && (await read(saved, saved.size - 1))[0] === 0, '2 GiB committed size/tail')
            await db.delete('persisted', 'scale')
          }
          checked.push('2 GiB scale fixture + IDB commit + disposed tail read')
        }
        async function* parts() {
          for (let n = 0; n < 12; n++) yield new Uint8Array(768 * 1024).fill(n)
        }
        const noSpool = async () => assert((await scratch()).length === 0, 'Empty scratch directory')
        for (const mode of ['OPFS', 'IndexedDB']) {
          if (mode === 'IndexedDB') Object.defineProperty(FileSystemFileHandle.prototype, 'createWritable', { configurable: true, value: undefined })
          const { zipSync } = await import('/fflate.js')
          const payload = new Uint8Array(12 * 768 * 1024)
          for (let n = 0; n < 12; n++) payload.fill(n, n * 768 * 1024, (n + 1) * 768 * 1024)
          const zip = zipSync({ 'image.test': payload }, { level: 0 })
          const owned = await spoolBlob((async function* () { yield zip })())
          try {
            assert((await scratch()).length === (mode === 'OPFS' ? 1 : 0), `Temporary lease ${mode}`)
            const source = { size: zip.length, name: 'fixture.zip', readRange: (at, n) => read(owned.blob, at, n) }
            for await (const entry of readArchive(source, await readDirectory(source))) {
              const attachment = await readEntry(entry)
              try { await db.put('persisted', attachment.blob.slice(0, entry.size, 'image/test'), mode) }
              finally { await attachment.dispose() }
            }
          } finally { await owned.dispose() }
          const saved = await db.get('persisted', mode)
          assert(saved.size === 12 * 768 * 1024 && saved.type === 'image/test', 'Saved metadata')
          for (let n = 0; n < 12; n++) assert((await read(saved, n * 768 * 1024))[0] === n, 'Verified each part')
          await noSpool()
          async function* broken() { yield* parts(); throw new Error('CRC test') }
          let failed = false
          try { await spoolBlob(broken()) } catch (e) { failed = e.message === 'CRC test' }
          assert(failed, 'Propagated failure'); await noSpool()
          if (mode === 'OPFS') {
            const write = FileSystemWritableFileStream.prototype.write
            FileSystemWritableFileStream.prototype.write = async () => { throw new DOMException('fixture', 'QuotaExceededError') }
            try {
              let quota = false
              try { await spoolBlob(parts()) } catch (error) { quota = error.name === 'QuotaExceededError' }
              assert(quota, 'Write quota error preserved')
              await noSpool()
            } finally { FileSystemWritableFileStream.prototype.write = write }
          } else {
            const scratchDb = await openDB(dirName, 1)
            assert(await scratchDb.count('part') === 0, 'No leftover IDB part'); scratchDb.close()
          }
          checked.push(mode)
        }
      } finally { db.close() }
      return checked
    }, Boolean(process.env.ZIP_SCALE_FILE))
    assert.ok(report.includes('OPFS') && report.includes('IndexedDB'))
    await page.reload()
    await page.evaluate(async () => {
      const { openDB } = await import('/idb.js')
      const db = await openDB('spool-test', 1)
      try {
        for (const mode of ['OPFS', 'IndexedDB']) {
          const attachment = await db.get('persisted', mode)
          const bytes = new Uint8Array(await attachment.arrayBuffer())
          if (bytes.length !== 12 * 768 * 1024 || !bytes.every((b, i) => b === Math.floor(i / (768 * 1024)))) {
            throw new Error('Persisted attachment changed after reopening')
          }
        }
      } finally { db.close() }
    })
    console.log('Verified', report.join(', '), 'and reopened attachment bytes')
  } finally {
    await browser?.close()
    assert.ok(path.dirname(profile) === tmpdir() && path.basename(profile).startsWith('zip-spool-browser-'))
    await rm(profile, { recursive: true, force: true })
  }
})
