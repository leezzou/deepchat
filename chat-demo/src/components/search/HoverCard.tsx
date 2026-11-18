import { useEffect, type HTMLAttributes, type MutableRefObject, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useAnchoredPosition, useDelayedOpen, useDismiss } from '../base/anchored.js'
import { POPOVER_EXIT_MS, useMotionPresence } from '../base/motionPresence.js'
import motion from '../base/popoverMotion.module.css'
import styles from './HoverCard.module.css'

const ENTER_DELAY = 300
const LEAVE_DELAY = 100
const GAP = 6

export type HoverCardTrigger = (props: {
  domRef: MutableRefObject<HTMLSpanElement | null>
  domProps: Omit<HTMLAttributes<HTMLSpanElement>, 'children' | 'className' | 'style'> | undefined
}) => ReactNode

/** 悬停 300ms 后在触发元素下方显示卡片（放不下则上方），鼠标可移入卡片 */
export const HoverCard = ({
  renderTrigger,
  children,
}: {
  renderTrigger: HoverCardTrigger
  children: ReactNode
}) => {
  const { open, schedule, cancel } = useDelayedOpen()
  const { present, closing } = useMotionPresence(open, POPOVER_EXIT_MS)
  const { anchorRef, floatingRef, position } = useAnchoredPosition<HTMLSpanElement, HTMLDivElement>(
    present,
    { align: 'center', offset: GAP }
  )

  useDismiss(present, [anchorRef, floatingRef], () => schedule(false, 0))
  useEffect(() => () => cancel(), [cancel])

  return (
    <>
      {renderTrigger({
        domRef: anchorRef,
        domProps: {
          onMouseEnter: () => schedule(true, ENTER_DELAY),
          onMouseLeave: () => schedule(false, LEAVE_DELAY),
        },
      })}
      {present
        ? createPortal(
            <div
              ref={floatingRef}
              className={`${styles.card} ${motion.popover}`}
              data-state={closing ? 'closing' : 'open'}
              style={position ?? { top: 0, left: 0, visibility: 'hidden' }}
              onMouseEnter={cancel}
              onMouseLeave={() => schedule(false, LEAVE_DELAY)}
            >
              {children}
            </div>,
            document.body
          )
        : null}
    </>
  )
}
