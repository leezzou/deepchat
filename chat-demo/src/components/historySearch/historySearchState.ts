import { create } from 'zustand'
import type { SearchSnippet } from '../../services/chat/search.js'

export type HistoryLocation = {
  sessionId: string
  messageId: string
  query: string
  snippet: SearchSnippet
  requestId: number
}

export const useHistorySearch = create<{
  open: boolean
  location: HistoryLocation | null
}>(() => ({ open: false, location: null }))

export const openHistorySearch = () => useHistorySearch.setState({ open: true })
export const closeHistorySearch = () => useHistorySearch.setState({ open: false })
export const clearHistoryLocation = () => useHistorySearch.setState({ location: null })
let requestId = 0
export const locateHistoryMessage = (location: Omit<HistoryLocation, 'requestId'>) => {
  useHistorySearch.setState({ location: { ...location, requestId: ++requestId } })
}
