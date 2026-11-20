import { Capacitor, registerPlugin } from '@capacitor/core'

export type WorkBuddyWalletSnapshot = {
  source: 'signed-out' | 'account'
  state: 'login-required' | 'account-page' | 'access-denied' | 'unavailable'
  balance: number | null
  revision?: string
  checkIn:
    | 'unknown'
    | 'available'
    | 'checked-in'
    | 'inactive'
    | 'ineligible'
    | 'pending-confirmation'
  observedAt: number | null
  canAutoCheckIn: boolean
  autoCheckIn: boolean
}

const plugin = registerPlugin<{
  status(): Promise<WorkBuddyWalletSnapshot>
  refresh(): Promise<WorkBuddyWalletSnapshot>
  setAuto(options: { enabled: boolean }): Promise<WorkBuddyWalletSnapshot>
}>('WorkBuddyWallet')

const nativeWallet = () =>
  Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable('WorkBuddyWallet')

const signedOut: WorkBuddyWalletSnapshot = {
  source: 'signed-out',
  state: 'login-required',
  balance: null,
  checkIn: 'unknown',
  observedAt: null,
  canAutoCheckIn: false,
  autoCheckIn: false,
}

export async function getWorkBuddyWallet(): Promise<WorkBuddyWalletSnapshot> {
  return nativeWallet() ? plugin.status() : { ...signedOut }
}

export async function refreshWorkBuddyWallet(): Promise<WorkBuddyWalletSnapshot> {
  return nativeWallet() ? plugin.refresh() : { ...signedOut }
}

export async function setWorkBuddyAutoCheckIn(enabled: boolean): Promise<WorkBuddyWalletSnapshot> {
  if (nativeWallet()) {
    return plugin.setAuto({ enabled })
  }
  if (enabled) {
    throw new Error('请在 Android 应用里登录 WorkBuddy。')
  }
  return { ...signedOut }
}
