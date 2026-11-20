import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { ChatAccess } from '../api/access.js'
import { providerPresets } from '../api/providerPresets.js'
import { endpointProvider } from '../api/modelWindows.js'
import { createId } from '../../utils/id.js'
import { usageMetrics } from './totals.js'

export const USAGE_CHANGED = 'deepchat:usage-updated'
export type UsagePurpose =
  | 'chat'
  | 'regenerate'
  | 'continue'
  | 'title'
  | 'summary'
  | 'search-plan'
  | 'legacy'
export type UsageStatus = 'pending' | 'done' | 'failed' | 'stopped' | 'interrupted'
export type UsageRow = {
  id: string
  at: number
  provider: string
  model: string
  purpose: UsagePurpose
  status: UsageStatus
  input?: number
  output?: number
  inputHit?: number
  outputHit?: number
  cacheWrite?: number
}
interface LedgerDB extends DBSchema {
  requests: { key: string; value: UsageRow }
  meta: { key: string; value: boolean }
}
let connection: Promise<IDBPDatabase<LedgerDB>> | undefined
const database = () =>
  (connection ??= openDB<LedgerDB>('deepchat-usage', 1, {
    upgrade(db) {
      db.createObjectStore('requests', { keyPath: 'id' })
      db.createObjectStore('meta')
    },
  }).catch((error: unknown) => {
    connection = undefined
    throw error
  }))

function providerName(access: ChatAccess) {
  if (access.source === 'account') {
    return 'DeepSeek account'
  }
  if (access.source === 'workbuddy') {
    return 'WorkBuddy'
  }
  const preset = endpointProvider(access.config.origin, access.config.providerId)
  const name = providerPresets.find((p) => p.value === preset)?.label
  if (name) {
    return name
  }
  // A custom gateway's path or query can include private tenant names or keys.
  try {
    return new URL(access.config.origin).hostname || 'Custom API'
  } catch {
    return 'Custom API'
  }
}
let writes: Promise<void> = Promise.resolve()
let failedWrite = false
const persist = (row: UsageRow) => {
  if (typeof indexedDB === 'undefined') {
    return
  }
  const snapshot = { ...row }
  writes = writes
    .then(async () => {
      await (await database()).put('requests', snapshot)
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event(USAGE_CHANGED))
      }
    })
    .catch(() => {
      failedWrite = true
    })
}

/** Start after dispatch. Each network attempt has its own id, including continuations and title requests. */
export function beginUsage(access: ChatAccess, model: string, purpose: UsagePurpose) {
  const row: UsageRow = {
    id: createId(),
    at: Date.now(),
    provider: providerName(access),
    model,
    purpose,
    status: 'pending',
  }
  let counts: Record<string, number> = {}
  persist(row)
  return {
    sample(usage: object | undefined) {
      if (!usage) {
        return
      }
      const next = usageMetrics(usage, counts)
      counts = next.counts
      if (
        Object.entries(next.metrics).some(([key, value]) => row[key as keyof UsageRow] !== value)
      ) {
        Object.assign(row, next.metrics)
        persist(row)
      }
    },
    close(status: UsageStatus) {
      row.status = status
      persist(row)
    },
  }
}

/** Migrate v53 message receipts once. A deterministic key also makes simultaneous first opens idempotent. */
export async function migrateUsage(signal: AbortSignal) {
  const db = await database()
  if (await db.get('meta', 'legacy')) {
    return
  }
  const { loadLegacyUsageRows } = await import('../chat/db.js')
  const rows = await loadLegacyUsageRows(signal)
  signal.throwIfAborted()
  const tx = db.transaction(['requests', 'meta'], 'readwrite')
  if (!(await tx.objectStore('meta').get('legacy'))) {
    for (const row of rows) {
      void tx.objectStore('requests').put(row)
    }
    await tx.objectStore('meta').put(true, 'legacy')
  }
  await tx.done
}

export async function readUsageLedger(signal: AbortSignal): Promise<UsageRow[]> {
  await migrateUsage(signal)
  await writes
  signal.throwIfAborted()
  if (failedWrite) {
    failedWrite = false
    throw new Error('Usage storage unavailable')
  }
  const rows = await (await database()).getAll('requests')
  signal.throwIfAborted()
  return rows.sort((a, b) => b.at - a.at || b.id.localeCompare(a.id))
}
