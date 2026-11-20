import { useSyncExternalStore } from 'react'
import { resolveLocale } from '../../i18n/index.js'
import { getConversationRoute } from '../api/access.js'
import { useConversationModes } from '../conversationMode/storage.js'
import { useSettings } from '../settings.js'
import { useWorkBuddyState } from '../workbuddy/provider.js'
import { useDeviceVoice } from './deviceVoice.js'

export const speechLanguage = () => resolveLocale(useSettings.getState().locale)
type SessionId = string | null | undefined
export function speechIdentity(id: SessionId) {
  const route = getConversationRoute(id)
  return JSON.stringify([
    route.destination,
    route.model,
    route.missing,
    route.needsApproval,
    route.account && useSettings.getState().accountRevision,
    route.account && useSettings.getState().accountSignedIn,
    speechLanguage(),
  ])
}

export function subscribeSpeechRoute(change: () => void) {
  const listeners = [
    useSettings.subscribe(change),
    useConversationModes.subscribe(change),
    useWorkBuddyState.subscribe(change),
  ]
  return () => listeners.forEach((unsubscribe) => unsubscribe())
}

export function speechMode(id: SessionId, feature: 'tts' | 'asr') {
  const route = getConversationRoute(id)
  if (route.missing || route.needsApproval) {
    return 'blocked'
  }
  if (route.speech) {
    return 'official'
  }
  const device = useDeviceVoice.getState()
  return device.lang === speechLanguage() && device[feature] ? 'device' : 'unavailable'
}
const subscribeCapabilities = (change: () => void) => {
  const route = subscribeSpeechRoute(change)
  const device = useDeviceVoice.subscribe(change)
  return () => {
    route()
    device()
  }
}
export const useSpeechMode = (id: SessionId, feature: 'tts' | 'asr') =>
  useSyncExternalStore(subscribeCapabilities, () => speechMode(id, feature))
