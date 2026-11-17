/**
 * 已压缩对话的本地索引：只在 localStorage 记一份轻量清单，
 * 供「设置 → 数据管理 → 已压缩的对话」列表使用（完整消息仍在 IndexedDB 的会话里）。
 */
const KEY = 'chat-demo:compacted-index'

export type CompactionRecord = {
  sessionId: string
  title: string
  createdAt: number
  coveredMessages: number
}

const read = (): CompactionRecord[] => {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown
    if (!Array.isArray(list)) {
      return []
    }
    return list.filter(
      (item): item is CompactionRecord =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as CompactionRecord).sessionId === 'string'
    )
  } catch {
    return []
  }
}

const write = (list: CompactionRecord[]) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    // 存储不可用时只在内存里生效
  }
}

export const listCompactions = (): CompactionRecord[] =>
  read().sort((a, b) => b.createdAt - a.createdAt)

export const recordCompaction = (record: CompactionRecord) => {
  write([...read().filter((item) => item.sessionId !== record.sessionId), record])
}

export const forgetCompaction = (sessionId: string) => {
  write(read().filter((item) => item.sessionId !== sessionId))
}

/** Rebuild after history replacement so imported summaries appear and stale entries disappear. */
export const rebuildCompactionIndex = async () => {
  const { loadSessionSummaries, loadSession } = await import('./db.js')
  const records: CompactionRecord[] = []
  for (const summary of await loadSessionSummaries()) {
    const session = await loadSession(summary.id)
    if (session?.checkpoint && session.compactedThrough) {
      records.push({
        sessionId: session.id,
        title: session.title,
        createdAt: session.checkpoint.createdAt,
        coveredMessages: session.checkpoint.coveredMessages,
      })
    }
  }
  write(records)
}
