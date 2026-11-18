import { hasAccountBridge } from '../../shell/account.js'
import { useSettings } from '../settings.js'
import { getApiConfig, type ApiRuntimeConfig } from './origin.js'

/** Snapshot both the credential choice and its destination before any asynchronous work. */
export type ChatAccess =
  | { source: 'account' }
  | { source: 'api'; key: string; config: ApiRuntimeConfig }

export const accountOrigin = 'https://api.deepseek.com'
export const accessOrigin = (access: ChatAccess) =>
  access.source === 'account' ? accountOrigin : access.config.origin

export function getChatAccess(): ChatAccess | null {
  const state = useSettings.getState()
  if (hasAccountBridge && state.chatSource === 'account') {
    return state.accountSignedIn ? { source: 'account' } : null
  }
  return state.apiKey ? { source: 'api', key: state.apiKey, config: getApiConfig() } : null
}

export function requireChatAccess(): ChatAccess {
  const access = getChatAccess()
  if (!access) throw new Error('请先登录 DeepSeek 账号或选择 API Key。')
  return access
}
