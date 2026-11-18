import { useEffect, type RefObject } from 'react'
import {
  closeMobileSider,
  openMobileSider,
  useMobileSider,
} from '../components/sider/mobileSiderState.js'

import { hasPageAboveDrawer } from '../shell/backLayers.js'

const DISTANCE = 36
const EDGE_RATIO = 0.5
const NATIVE_GESTURES =
  'input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], pre, table, .katex-display, .md-mermaid-diagram, [data-horizontal-scroll]'

/** Observe horizontal swipes on the app surface. Leave scrolling, zoom and controls to the browser. */
export const useEdgeSwipe = (frameRef: RefObject<HTMLElement>, enabled: boolean) => {
  useEffect(() => {
    const frame = frameRef.current
    if (!enabled || !frame) {
      return
    }
    let start: { x: number; y: number; open: boolean; direction: number } | null = null
    const reset = () => {
      start = null
    }
    const onStart = (event: TouchEvent) => {
      reset()
      if (
        hasPageAboveDrawer() ||
        event.touches.length !== 1 ||
        !(event.target instanceof Element) ||
        event.target.closest(NATIVE_GESTURES)
      ) {
        return
      }
      const { clientX: x, clientY: y } = event.touches[0]
      const direction = document.documentElement.dir === 'rtl' ? -1 : 1
      const distanceFromEdge = direction === 1 ? x : window.innerWidth - x
      const open = useMobileSider.getState().open
      if (distanceFromEdge <= (open ? 380 : window.innerWidth * EDGE_RATIO)) {
        start = { x, y, open, direction }
      }
    }
    const onMove = (event: TouchEvent) => {
      if (!start) {
        return
      }
      if (event.touches.length !== 1 || start.open !== useMobileSider.getState().open) {
        reset()
        return
      }
      const { clientX, clientY } = event.touches[0]
      const dx = (clientX - start.x) * start.direction * (start.open ? -1 : 1)
      const dy = Math.abs(clientY - start.y)
      if (dy > 8 && dy > Math.abs(dx)) {
        reset()
      } else if (dx >= DISTANCE && dx > dy * 1.2) {
        const toggle = start.open ? closeMobileSider : openMobileSider
        reset()
        toggle()
      }
    }
    const options = { passive: true, capture: true }
    frame.addEventListener('touchstart', onStart, options)
    frame.addEventListener('touchmove', onMove, options)
    frame.addEventListener('touchend', reset, options)
    frame.addEventListener('touchcancel', reset, options)
    return () => {
      frame.removeEventListener('touchstart', onStart, true)
      frame.removeEventListener('touchmove', onMove, true)
      frame.removeEventListener('touchend', reset, true)
      frame.removeEventListener('touchcancel', reset, true)
    }
  }, [enabled, frameRef])
}
