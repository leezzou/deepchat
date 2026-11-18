import { MODAL_EXIT_MS, useMotionPresence } from '../components/base/motionPresence.js'
import { useLayoutEffect, useRef } from 'react'
import { popLayer, pushLayer } from './backLayers.js'

export const useSurfacePresence = (open: boolean) => useMotionPresence(open, MODAL_EXIT_MS).present

export const useBackLayer = (enabled: boolean, back: () => void, priority = 0) => {
  const latest = useRef(back)
  latest.current = back
  useLayoutEffect(() => {
    if (!enabled) return
    const entry = pushLayer(() => latest.current(), priority)
    return () => popLayer(entry)
  }, [enabled, priority])
}
