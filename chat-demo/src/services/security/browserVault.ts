import { openDB, type DBSchema } from 'idb'

interface Envelope {
  key: CryptoKey
  iv: Uint8Array<ArrayBuffer>
  ciphertext: ArrayBuffer
  revision: string
}
interface VaultDB extends DBSchema {
  profiles: { key: string; value: Envelope }
}
const open = () =>
  openDB<VaultDB>('deepchat-browser-credentials', 1, {
    upgrade(db) {
      db.createObjectStore('profiles')
    },
  })
let expected: string | null = null
export const browserProfileVault = {
  async read() {
    const db = await open()
    try {
      const record = await db.get('profiles', 'v1')
      expected = record?.revision ?? null
      if (!record) {
        return null
      }
      const data = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: record.iv },
        record.key,
        record.ciphertext
      )
      return new TextDecoder().decode(data)
    } finally {
      db.close()
    }
  },
  async write(value: string) {
    const original = expected
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ])
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      new TextEncoder().encode(value)
    )
    const revision = Array.from(iv).join('.')
    const db = await open()
    try {
      const tx = db.transaction('profiles', 'readwrite')
      const current = await tx.store.get('v1')
      if ((current?.revision ?? null) !== original) {
        throw new Error('changed')
      }
      await tx.store.put({ key, iv, ciphertext, revision }, 'v1')
      await tx.done
      expected = revision
    } finally {
      db.close()
    }
  },
}
