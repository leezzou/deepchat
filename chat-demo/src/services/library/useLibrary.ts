import { useSyncExternalStore } from 'react'
import { readLibrary, subscribeLibrary } from './index.js'

export const useLibrarySnapshot = () =>
  useSyncExternalStore(subscribeLibrary, readLibrary, readLibrary)
