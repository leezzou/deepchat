type Layer = { close: () => void; priority: number }
const layers: Layer[] = []
let syncHistory: (() => void) | undefined

export const pushLayer = (close: () => void, priority = 0) => {
  layers.push({ close, priority })
  syncHistory?.()
  return close
}

export const popLayer = (entry: () => void) => {
  const index = layers.findIndex(({ close }) => close === entry)
  if (index >= 0) layers.splice(index, 1)
  syncHistory?.()
}

const topLayer = () => layers.reduce<Layer | undefined>(
  (top, layer) => !top || layer.priority >= top.priority ? layer : top, undefined
)

export const isTopLayer = (entry: () => void) => topLayer()?.close === entry

export const hasPageAboveDrawer = () => layers.some(({ priority }) => priority > -10)

export const closeTopLayer = () => {
  const layer = topLayer()
  if (!layer) return false
  layer.close()
  return true
}

/** All Back sources dispatch once. An exiting surface keeps its layer until unmount. */
export const bindLayerNavigation = (native: boolean) => {
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || event.isComposing || !layers.length || event.defaultPrevented) return
    event.preventDefault()
    event.stopImmediatePropagation()
    if (!event.repeat) closeTopLayer()
  }
  document.addEventListener('keydown', onKey, true)

  // A single same-document history entry protects the actual page URL while surfaces are open.
  // The active surface may have several internal pages, each handled by its own Back callback.
  const marker = '__deepchatNavigation'
  let retiring = false
  let active = true
  const sync = () => {
    if (native || !active || retiring) return
    if (layers.length && !history.state?.[marker]) {
      history.pushState({ ...history.state, [marker]: true }, '')
    } else if (!layers.length && history.state?.[marker]) {
      retiring = true
      history.back()
    }
  }
  const scheduleSync = () => queueMicrotask(sync)
  const onPop = () => {
    if (!retiring && !history.state?.[marker]) closeTopLayer()
    retiring = false
    scheduleSync()
  }
  syncHistory = scheduleSync
  if (!native) window.addEventListener('popstate', onPop)
  scheduleSync()
  return () => {
    active = false
    syncHistory = undefined
    window.removeEventListener('popstate', onPop)
    document.removeEventListener('keydown', onKey, true)
  }
}
