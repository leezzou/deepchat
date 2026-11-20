import { create } from 'zustand'
import { setChatSource, useSettings } from '../settings.js'
import { hasWorkBuddyBridge, manageWorkBuddy } from './bridge.js'
import {
  getNextWorkBuddyPriceChange,
  isWorkBuddyModel,
  repriceWorkBuddyCatalog,
  setWorkBuddyCatalog,
  validWorkBuddyId,
  type WorkBuddyModel,
} from './models.js'
export { WORKBUDDY_MODELS } from './models.js'
export { hasWorkBuddyBridge } from './bridge.js'

type Metadata = { model: WorkBuddyModel; revision: string }
const cache = 'chat-demo:workbuddy-route:v1'
function decode(value: unknown): Metadata | null {
  if (
    !value ||
    typeof value !== 'object' ||
    !('model' in value) ||
    !validWorkBuddyId(value.model) ||
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
export const useWorkBuddyState = create(() => ({
  metadata: initial(),
  models: setWorkBuddyCatalog(null),
  name: '',
  pending: false,
  catalogLoading: false,
  catalogError: false,
  catalogStale: true,
  catalogUpdatedAt: 0,
}))
const catalogTTL = 5 * 60_000
let retryAfter = 0
let activeRevision = useWorkBuddyState.getState().metadata?.revision
let catalogRequest: { revision: string; promise: Promise<void> } | undefined
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
  const revision = metadata?.revision
  if (revision !== activeRevision) {
    activeRevision = revision
    retryAfter = 0
    catalogRequest = undefined
  }
  const now = Date.now()
  const timestamp = value.catalogUpdatedAt
  const updatedAt =
    metadata && typeof timestamp === 'number' && Number.isSafeInteger(timestamp) && timestamp > 0
      ? timestamp
      : 0
  const catalogError = Boolean(metadata && value.catalogError)
  if (!catalogError || value.catalogRefresh) {
    retryAfter = 0
  } else if (retryAfter <= now) {
    retryAfter = now + 30_000
  }
  const models = setWorkBuddyCatalog(metadata ? value.catalog : null)
  useWorkBuddyState.setState({
    metadata,
    models,
    name: value.name || '',
    pending: value.pending === true,
    catalogUpdatedAt: updatedAt,
    catalogStale:
      !metadata ||
      Boolean(
        value.catalogStale || catalogError || !updatedAt || Date.now() - updatedAt >= catalogTTL
      ),
    catalogLoading: Boolean(revision && catalogRequest?.revision === revision),
    catalogError,
  })
  if (metadata && value.catalogRefresh) {
    void refreshWorkBuddyCatalog()
  }
}
export async function refreshWorkBuddyCatalog(force = false): Promise<void> {
  const state = useWorkBuddyState.getState()
  const revision = state.metadata?.revision
  if (!revision || !hasWorkBuddyBridge) {
    return
  }
  if (catalogRequest?.revision === revision) {
    return catalogRequest.promise
  }
  const now = Date.now()
  if (
    !force &&
    (now < retryAfter ||
      (!state.catalogStale &&
        now >= state.catalogUpdatedAt &&
        now - state.catalogUpdatedAt < catalogTTL))
  ) {
    return
  }
  const promise = manageWorkBuddy('catalog', { revision })
    .then((next) => {
      if (useWorkBuddyState.getState().metadata?.revision !== revision) {
        return
      }
      if (next.revision === revision) {
        publish(next)
      } else if (!next.revision && next.type === 'status') {
        publish(next)
      }
    })
    .catch(() => {
      if (useWorkBuddyState.getState().metadata?.revision === revision) {
        retryAfter = Date.now() + 30_000
        useWorkBuddyState.setState({ catalogError: true, catalogStale: true })
      }
    })
    .finally(() => {
      if (catalogRequest?.promise === promise) {
        catalogRequest = undefined
        useWorkBuddyState.setState({ catalogLoading: false })
      }
    })
  catalogRequest = { revision, promise }
  useWorkBuddyState.setState({
    catalogLoading: true,
    catalogStale: state.catalogStale || now - state.catalogUpdatedAt >= catalogTTL,
  })
  return promise
}

/** Owned by the app lifecycle. Background pages do no catalog work. Returning to the foreground first rechecks the account. */
export function watchWorkBuddyCatalog() {
  let boundaryTimer: ReturnType<typeof setTimeout> | undefined
  const reprice = () => useWorkBuddyState.setState({ models: repriceWorkBuddyCatalog() })
  const scheduleBoundary = () => {
    clearTimeout(boundaryTimer)
    const delay = getNextWorkBuddyPriceChange() - Date.now()
    if (Number.isFinite(delay) && document.visibilityState !== 'hidden') {
      boundaryTimer = setTimeout(reprice, Math.min(2_000_000_000, Math.max(1, delay)))
    }
  }
  const unsubscribe = useWorkBuddyState.subscribe((state, previous) => {
    if (state.models !== previous.models) {
      scheduleBoundary()
    }
  })
  const resume = () => {
    clearTimeout(boundaryTimer)
    if (document.visibilityState !== 'hidden') {
      reprice()
      void refreshWorkBuddy().catch(() => {})
    }
  }
  const timer = setInterval(() => {
    if (document.visibilityState !== 'hidden') {
      void refreshWorkBuddyCatalog().catch(() => {})
    }
  }, 30_000)
  document.addEventListener('visibilitychange', resume)
  window.addEventListener('online', resume)
  resume()
  return () => {
    unsubscribe()
    clearTimeout(boundaryTimer)
    clearInterval(timer)
    document.removeEventListener('visibilitychange', resume)
    window.removeEventListener('online', resume)
  }
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
  const revision = useWorkBuddyState.getState().metadata?.revision
  if (!revision) {
    throw new Error('WorkBuddy · Sign in first')
  }
  publish(await manageWorkBuddy('model', { model, revision }))
}
export function activateWorkBuddy(active: boolean) {
  if (active && !useWorkBuddyState.getState().metadata) {
    throw new Error('WorkBuddy · Sign in first')
  }
  setChatSource(active ? 'workbuddy' : useSettings.getState().accountSignedIn ? 'account' : 'api')
}
