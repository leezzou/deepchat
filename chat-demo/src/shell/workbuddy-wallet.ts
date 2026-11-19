import { Capacitor, registerPlugin } from '@capacitor/core'

export type WorkBuddyWalletSnapshot = {
  source: 'website' | 'account'
  state: 'unopened' | 'login-required' | 'account-page' | 'access-denied' | 'unavailable'
  balance: number | null
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
  detail: string
  httpStatus: number | null
}

export const workBuddyWalletUrl = 'https://www.workbuddy.cn/profile/usage'

const plugin = registerPlugin<{
  open(): Promise<WorkBuddyWalletSnapshot>
  status(): Promise<WorkBuddyWalletSnapshot>
  refresh(): Promise<WorkBuddyWalletSnapshot>
  setAuto(options: { enabled: boolean }): Promise<WorkBuddyWalletSnapshot>
}>('WorkBuddyWallet')

const nativeWallet = () =>
  Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable('WorkBuddyWallet')

const website: WorkBuddyWalletSnapshot = {
  source: 'website',
  state: 'unopened',
  balance: null,
  checkIn: 'unknown',
  observedAt: null,
  canAutoCheckIn: false,
  autoCheckIn: false,
  detail: '在 WorkBuddy 官网查看积分。当前签到活动见官方客户端的「Buddy 加油站」。',
  httpStatus: null,
}

/** The website owns its session. Browser tabs do not return account data to the app. */
export async function openWorkBuddyWallet(): Promise<WorkBuddyWalletSnapshot> {
  if (nativeWallet()) {
    return plugin.open()
  }
  if (Capacitor.isNativePlatform()) {
    const { Browser } = await import('@capacitor/browser')
    await Browser.open({ url: workBuddyWalletUrl })
  } else {
    window.open(workBuddyWalletUrl, '_blank', 'noopener,noreferrer')
  }
  return { ...website }
}

export async function getWorkBuddyWallet(): Promise<WorkBuddyWalletSnapshot> {
  return nativeWallet() ? plugin.status() : { ...website }
}

export async function refreshWorkBuddyWallet(): Promise<WorkBuddyWalletSnapshot> {
  return nativeWallet() ? plugin.refresh() : { ...website }
}

export async function setWorkBuddyAutoCheckIn(enabled: boolean): Promise<WorkBuddyWalletSnapshot> {
  if (nativeWallet()) {
    return plugin.setAuto({ enabled })
  }
  if (enabled) {
    throw new Error('请在 Android 应用里登录 WorkBuddy。')
  }
  return { ...website }
}
