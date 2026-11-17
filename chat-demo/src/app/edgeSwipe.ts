import { useEffect } from 'react'

// 左三分之一屏内向右滑都能打开（Android 系统边缘返回手势会抢走真正的贴边滑动）
const EDGE_RATIO = 0.5
// 阈值调低，快滑也能触发（用户反馈原来不灵敏）
const OPEN_DISTANCE = 36
const CLOSE_DISTANCE = 36

/**
 * 移动端手势：从屏幕左缘向右滑打开对话抽屉，抽屉打开时向左滑关闭。
 * 只处理单指、水平位移明显大于垂直位移的情况，避免和纵向滚动打架。
 */
export const useEdgeSwipe = (enabled: boolean, open: boolean, onOpen: () => void, onClose: () => void) => {
  useEffect(() => {
    if (!enabled) {
      return
    }
    let tracking = false
    let startX = 0
    let startY = 0
    let mode: 'open' | 'close' | null = null

    const onStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        tracking = false
        return
      }
      const touch = event.touches[0]
      startX = touch.clientX
      startY = touch.clientY
      if (open) {
        // 抽屉打开时，从左半屏任意位置向左滑都能关闭
        mode = touch.clientX <= 380 ? 'close' : null
      } else {
        mode = touch.clientX <= window.innerWidth * EDGE_RATIO ? 'open' : null
      }
      tracking = mode !== null
    }

    const onMove = (event: TouchEvent) => {
      if (!tracking || !mode || event.touches.length !== 1) {
        return
      }
      const touch = event.touches[0]
      const dx = touch.clientX - startX
      const dy = touch.clientY - startY
      // 明确横向时才接管，接管后阻止滚动，避免 WebView 抢走手势
      if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy) * 1.2) {
        if (event.cancelable) {
          event.preventDefault()
        }
      } else if (Math.abs(dy) > Math.abs(dx)) {
        tracking = false
        return
      }
      if (mode === 'open' && dx >= OPEN_DISTANCE) {
        tracking = false
        onOpen()
      } else if (mode === 'close' && dx <= -CLOSE_DISTANCE) {
        tracking = false
        onClose()
      }
    }

    const onEnd = () => {
      tracking = false
      mode = null
    }

    document.addEventListener('touchstart', onStart, { passive: true, capture: true })
    document.addEventListener('touchmove', onMove, { passive: false, capture: true })
    document.addEventListener('touchend', onEnd, { passive: true, capture: true })
    document.addEventListener('touchcancel', onEnd, { passive: true, capture: true })
    return () => {
      document.removeEventListener('touchstart', onStart, true)
      document.removeEventListener('touchmove', onMove, true)
      document.removeEventListener('touchend', onEnd, true)
      document.removeEventListener('touchcancel', onEnd, true)
    }
  }, [enabled, open, onOpen, onClose])
}
