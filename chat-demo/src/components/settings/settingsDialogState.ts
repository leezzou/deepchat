import { create } from 'zustand'
import { getChatAccess, getConversationRoute } from '../../services/api/access.js'
import { hasAccountBridge } from '../../shell/account.js'

export type SettingsSection = 'general' | 'apiKey' | 'data' | 'memory' | 'security' | 'webdav' | 'contextModels'
export type SettingsVisit = {
  id: number
  section: SettingsSection
  status: 'open' | 'covered' | 'closing'
}

// A compacted conversation can cover its settings visit. Keep that visit's actual
// pages mounted while the chat opens its own drawer, settings or other children.
export const useSettingsDialog = create(() => ({ visits: [] as SettingsVisit[] }))
let nextVisit = 0
export const openSettings = (section: SettingsSection) => {
  useSettingsDialog.setState(({ visits }) => {
    if (visits.some((visit) => visit.status === 'open')) return { visits }
    return { visits: [...visits, { id: ++nextVisit, section, status: 'open' }] }
  })
}

const setStatus = (id: number, status: SettingsVisit['status']) =>
  useSettingsDialog.setState(({ visits }) => ({
    visits: visits.map((visit) => visit.id === id ? { ...visit, status } : visit),
  }))

export const closeSettings = () => {
  const current = useSettingsDialog.getState().visits.find((visit) => visit.status === 'open')
  if (current) setStatus(current.id, 'closing')
}

export const coverSettings = (id: number) => {
  setStatus(id, 'covered')
  return () => setStatus(id, 'open')
}

export const finishSettingsExit = (id: number) =>
  useSettingsDialog.setState(({ visits }) => ({ visits: visits.filter((visit) => visit.id !== id) }))

/** 没有 API Key 时打开设置并选中 API Key 所在的「数据管理」，返回是否已有 Key */
export const ensureApiKey = (sessionId?: string | null) => {
  if (getChatAccess(sessionId)) {
    return true
  }
  openSettings(hasAccountBridge || getConversationRoute(sessionId).workbuddy ? 'general' : 'apiKey')
  return false
}
