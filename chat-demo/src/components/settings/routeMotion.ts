import { useLayoutEffect, useRef } from 'react'
import { popLayer, pushLayer } from '../../shell/backLayers.js'

/** Keep a layer in its original stack position, including while its visual page is leaving. */
export function useRouteBack(back: () => void) {
  const latest = useRef(back)
  latest.current = back
  useLayoutEffect(() => {
    const layer = pushLayer(() => latest.current())
    return () => popLayer(layer)
  }, [])
}

/** CSS transitions can reverse an entry from its actual on-screen position on a quick Back. */
export function useRouteMotion<T extends HTMLElement>(animateEntry: boolean, leaving: boolean, exited: () => void) {
  const ref = useRef<T>(null)
  const initialEntry = useRef(animateEntry)
  const finish = useRef(exited)
  finish.current = exited
  useLayoutEffect(() => {
    const el = ref.current!
    if (initialEntry.current && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      el.dataset.routeStart = ''
      void el.offsetWidth
      delete el.dataset.routeStart
    }
  }, [])
  useLayoutEffect(() => {
    if (!leaving) return
    const el = ref.current!
    const motion = el.getAnimations().filter((a) => 'transitionProperty' in a && a.transitionProperty === 'transform')
    if (!motion.length) {
      finish.current()
      return
    }
    let active = true
    const done = () => { if (active) { active = false; finish.current() } }
    // The fallback also releases a retained layer if WebView suspends its animation timeline.
    const timer = window.setTimeout(done, 240)
    void Promise.allSettled(motion.map((a) => a.finished)).then(done)
    return () => { active = false; window.clearTimeout(timer) }
  }, [leaving])
  return ref
}
