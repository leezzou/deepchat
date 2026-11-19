import { create } from 'zustand'
import { setChatSource, useSettings } from '../settings.js'
import { hasWorkBuddyBridge, manageWorkBuddy } from './bridge.js'
import { isWorkBuddyModel, type WorkBuddyModel } from './models.js'
export { WORKBUDDY_MODELS } from './models.js'
export { hasWorkBuddyBridge } from './bridge.js'

type Metadata = { model: WorkBuddyModel; revision: string }
const cache = 'chat-demo:workbuddy-route:v1'
function decode(value: unknown): Metadata | null {
  if (
    !value ||
    typeof value !== 'object' ||
    !('model' in value) ||
    !isWorkBuddyModel(value.model) ||
    !('revision' in value) ||
    typeof value.revision !== 'string' ||
    !/^[0-9a-f-]{36}$/.test(value.revision)
  ) {
    return null
  }
  return { model: value.model, revision: value.revision }
}
function initial() {
  try {
    return hasWorkBuddyBridge ? decode(JSON.parse(localStorage.getItem(cache) || 'null')) : null
  } catch {
    return null
  }
}
// Only routing metadata is mirrored. Native rechecks the account revision at dispatch.
export const useWorkBuddyState = create(() => ({ metadata: initial(), name: '', pending: false }))
function publish(value: Awaited<ReturnType<typeof manageWorkBuddy>>) {
  const metadata = decode(value)
  try {
    if (metadata) {
      localStorage.setItem(cache, JSON.stringify(metadata))
    } else {
      localStorage.removeItem(cache)
    }
  } catch {
    /* storage disabled */
  }
  useWorkBuddyState.setState({ metadata, name: value.name || '', pending: value.pending === true })
}
export async function refreshWorkBuddy() {
  publish(await manageWorkBuddy('status'))
}
export async function signInWorkBuddy() {
  publish(await manageWorkBuddy('begin'))
}
export async function completeWorkBuddy() {
  try {
    publish(await manageWorkBuddy('poll'))
  } catch (error) {
    await refreshWorkBuddy().catch(() => {})
    throw error
  }
}
export async function cancelWorkBuddySignIn() {
  publish(await manageWorkBuddy('cancelLogin'))
}
export async function disconnectWorkBuddy() {
  publish(await manageWorkBuddy('forget'))
}
export async function selectWorkBuddyModel(model: WorkBuddyModel) {
  if (!isWorkBuddyModel(model)) {
    throw new Error('WorkBuddy · Unknown model')
  }
  publish(await manageWorkBuddy('model', { model }))
}
export function activateWorkBuddy(active: boolean) {
  if (active && !useWorkBuddyState.getState().metadata) {
    throw new Error('WorkBuddy · Sign in first')
  }
  setChatSource(active ? 'workbuddy' : useSettings.getState().accountSignedIn ? 'account' : 'api')
}
