import { create } from 'zustand'
import type { BackupMetadata } from './storage.js'

export const useBackupState = create<{
  ready: boolean
  operation: 'generating' | 'saving' | 'snapshot' | 'restoring' | null
  latest: BackupMetadata | null
  safety: BackupMetadata | null
  autoEnabled: boolean
  completedRounds: number
  error: 'load' | 'automatic' | null
}>(() => ({
  ready: false,
  operation: null,
  latest: null,
  safety: null,
  autoEnabled: true,
  completedRounds: 0,
  error: null,
}))
