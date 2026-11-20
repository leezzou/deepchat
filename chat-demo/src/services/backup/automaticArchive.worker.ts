import '../../polyfills.js'
import '../../compat/webview.js'
import { useSettings, type LocalePreference } from '../settings.js'
import { loadSession } from '../chat/db.js'
import { exportArchive } from '../chat/history/exportArchive.js'
import { MAX_ARCHIVE_BYTES } from '../chat/history/limits.js'

// Only IDs cross from the chat UI. Read persisted history, convert JSON and stream ZIP
// bytes in this worker. Android can suspend/kill it without changing the last good ZIP.
async function* sessions(ids: string[]) {
  for (const id of ids) {
    const session = await loadSession(id)
    if (!session) {
      throw new Error('Session changed during backup')
    }
    yield session
  }
}
self.onmessage = async ({ data }: MessageEvent<{ ids: string[]; locale: LocalePreference }>) => {
  try {
    useSettings.setState({ locale: data.locale })
    const blob = await exportArchive(sessions(data.ids))
    if (blob.size > MAX_ARCHIVE_BYTES) {
      throw new Error('Backup exceeds the import limit')
    }
    self.postMessage({ blob })
  } catch {
    self.postMessage({ failed: true })
  }
}
