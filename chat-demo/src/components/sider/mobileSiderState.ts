import { create } from 'zustand'
import { newChat, selectSession, useChatStore } from '../../services/chat/store.js'
import { readLibrary, getSessionFolderId } from '../../services/library/index.js'
import { restoreHistorySearch } from '../historySearch/historySearchState.js'

type Chat = { id: string | null; draftFolder: string | null }
type SidebarView = { folder: string | undefined; favorites: boolean }
type Origin = { chat: Chat; drawer: boolean; view: SidebarView; search?: string; resume?: () => void }
const currentChat = (): Chat => ({
  id: useChatStore.getState().activeId,
  draftFolder: getSessionFolderId(null),
})

export const useMobileSider = create(() => ({
  open: false,
  view: { folder: undefined, favorites: false } as SidebarView,
  parents: [] as Origin[],
}))

export const setSidebarView = (view: SidebarView) => useMobileSider.setState({ view })

export const openMobileSider = () => useMobileSider.setState({ open: true })
export const closeMobileSider = () => useMobileSider.setState({ open: false })

// Snapshot before selecting a result: favorites and search can change the active
// conversation asynchronously. Commit only after that navigation succeeds.
export const captureChatOrigin = (): Origin => ({
  chat: currentChat(),
  drawer: useMobileSider.getState().open,
  view: useMobileSider.getState().view,
})

export const rememberChat = (origin = captureChatOrigin()) =>
  useMobileSider.setState(({ parents }) => ({ parents: [...parents, origin], open: false }))

export const backFromChat = () => {
  const { parents } = useMobileSider.getState()
  const origin = parents.at(-1)
  if (!origin || useChatStore.getState().importingHistory) return
  const { id, draftFolder } = origin.chat
  if (id && useChatStore.getState().sessions.some((session) => session.id === id)) {
    selectSession(id)
  } else if (useChatStore.getState().activeId !== null || draftFolder !== getSessionFolderId(null)) {
    const folder = readLibrary().folders.some((item) => item.id === draftFolder) ? draftFolder : null
    newChat(folder)
  }
  useMobileSider.setState({ parents: parents.slice(0, -1), open: origin.drawer, view: origin.view })
  if (origin.search !== undefined) restoreHistorySearch(origin.search)
  origin.resume?.()
}
