import { useChatStore } from '../chat/store.js'
import { getVisibleMessages } from '../chat/branches.js'
import { buildReplyView } from '../chat/view.js'
import { useSettings } from '../settings.js'
import { speechIdentity, speechMode } from './speechRoute.js'
import { toggleReadAloud } from './readAloud.js'

/** Observe the live request lifecycle. Loaded history and background sessions never trigger narration. */
export function bindAutoRead(onError: (error: unknown) => void) {
  let pending: { session: string; id: string; route: string } | undefined
  return useChatStore.subscribe((state, previous) => {
    const id = state.activeId
    if (id !== previous.activeId || state.importingHistory) {
      pending = undefined
    }
    if (!id || state.importingHistory || state.streaming[id] === previous.streaming[id]) {
      return
    }
    const session = state.sessionCache[id]
    const last = session && getVisibleMessages(session).at(-1)
    if (state.streaming[id]) {
      pending =
        last?.role === 'assistant'
          ? { session: id, id: last.id, route: speechIdentity(id) }
          : undefined
      return
    }
    const started = pending
    pending = undefined
    if (
      !started ||
      started.session !== id ||
      last?.role !== 'assistant' ||
      last.id !== started.id ||
      last.status !== 'done' ||
      last.stopReason === 'refusal' ||
      started.route !== speechIdentity(id) ||
      document.hidden ||
      !useSettings.getState().autoRead
    ) {
      return
    }
    const mode = speechMode(id, 'tts')
    if (mode !== 'official' && mode !== 'device') {
      return
    }
    const text = buildReplyView(last, false).answer?.text
    if (text) {
      toggleReadAloud(last.id, text, onError, id)
    }
  })
}
