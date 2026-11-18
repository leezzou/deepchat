import assert from 'node:assert/strict'
import test from 'node:test'
import { zipSync } from 'fflate'
import { ArchiveError, readArchive, readDirectory, readEntry } from './zipReader.ts'

// Single STORE entry with a conventional ZIP32 directory and streaming local header.
function fixture({ placeholder = false, descriptor = false, mismatch, signature = true } = {}) {
  const data = new TextEncoder().encode('多字节正文🙂')
  const plain = Buffer.from(zipSync({ 'text.txt': data }, { level: 0 }))
  const nameEnd = 30 + plain.readUInt16LE(26)
  const directoryOffset = plain.readUInt32LE(plain.length - 6)
  const local = Buffer.from(plain.subarray(0, nameEnd))
  const crc = local.readUInt32LE(14)
  const directory = Buffer.from(plain.subarray(directoryOffset))
  const extra = Buffer.alloc(20)
  extra.writeUInt16LE(1)
  extra.writeUInt16LE(16, 2)
  const size = descriptor ? 0 : data.length
  extra.writeUInt32LE(size, 4)
  extra.writeUInt32LE(size, 12)
  local.writeUInt16LE(extra.length, 28)
  local.writeUInt32LE(placeholder ? 0xffffffff : size, 18)
  local.writeUInt32LE(placeholder ? 0xffffffff : size, 22)
  let trailer = Buffer.alloc(0)
  if (descriptor) {
    local.writeUInt16LE(local.readUInt16LE(6) | 8, 6)
    local.writeUInt32LE(0, 14)
    directory.writeUInt16LE(directory.readUInt16LE(8) | 8, 8)
    const shift = signature ? 4 : 0
    trailer = Buffer.alloc(20 + shift)
    if (signature) {
      trailer.writeUInt32LE(0x08074b50)
    }
    trailer.writeUInt32LE(crc, shift)
    trailer.writeUInt32LE(data.length, shift + 4)
    trailer.writeUInt32LE(data.length, shift + 12)
    if (mismatch === 'descriptor') {
      trailer.writeUInt32LE(1, shift + 16)
    }
  }
  if (mismatch === 'size') {
    extra.writeUInt32LE(size + 1, 4)
  }
  if (mismatch === 'high') {
    extra.writeUInt32LE(1, 8)
  }
  directory.writeUInt32LE(directoryOffset + extra.length + trailer.length, directory.length - 6)
  return new File([local, extra, data, trailer, directory], 'stream.zip')
}
async function read(file) {
  const result = []
  for await (const entry of readArchive(file, await readDirectory(file))) {
    result.push(await (await readEntry(entry)).text())
  }
  return result
}
for (const placeholder of [false, true]) {
  for (const options of [
    {},
    { descriptor: true, signature: true },
    { descriptor: true, signature: false },
  ]) {
    test(`reads local wide sizes ${JSON.stringify({ placeholder, ...options })}`, async () => {
      assert.deepEqual(await read(fixture({ placeholder, ...options })), ['多字节正文🙂'])
    })
  }
}
for (const mismatch of ['size', 'high', 'descriptor']) {
  test(`rejects inconsistent local ${mismatch}`, async () => {
    await assert.rejects(
      read(fixture({ mismatch, descriptor: mismatch === 'descriptor' })),
      ArchiveError
    )
  })
}
