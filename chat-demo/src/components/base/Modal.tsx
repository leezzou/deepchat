import clsx from 'clsx'
import {
  createContext,
  useContext,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import { isTopLayer, popLayer, pushLayer } from '../../shell/backLayers.js'
import { IconCloseOutline16 } from './icons.js'
import { IconButton } from './IconButton.js'
import { afterMotionExit, MODAL_EXIT_MS, useMotionPresence } from './motionPresence.js'
import styles from './Modal.module.css'

const Presence = createContext<boolean | null>(null)

/** Wrap the conditional that owns a dialog, including a component that renders a Modal.
 * Keeping the last live element preserves its content even when a confirm clears the source data. */
export const ModalPresence = ({
  children,
  onExited,
}: {
  children: ReactNode
  onExited?: () => void
}) => {
  const open = Boolean(children)
  const { present, closing } = useMotionPresence(open, MODAL_EXIT_MS, onExited)
  const last = useRef<ReactNode>(null)
  useLayoutEffect(() => {
    if (open || !present) {
      last.current = children
    }
  }, [children, open, present])
  return present ? (
    <Presence.Provider value={closing}>{open ? children : last.current}</Presence.Provider>
  ) : null
}

// A dialog can replace another while its opener is still mounted in the outgoing dialog.
const focusOrigins = new WeakMap<Element, () => HTMLElement | null>()
const controls =
  'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), summary, [tabindex="0"]'

export const Modal = ({
  title,
  children,
  footer,
  closable = false,
  placement = 'center',
  confirmation = false,
  className,
  mainClassName,
  onClose,
}: {
  title: ReactNode
  children?: ReactNode
  footer?: ReactNode
  closable?: boolean
  placement?: 'center' | 'bottom'
  confirmation?: boolean
  className?: string
  mainClassName?: string
  onClose: () => void
}) => {
  const t = useTranslate()
  const titleId = useId()
  const overlayRef = useRef<HTMLDivElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const layerRef = useRef<(() => void) | null>(null)
  const managedExit = useContext(Presence)
  const [localExit, setLocalExit] = useState(false)
  const closing = managedExit ?? localExit
  const requestClose = () => {
    if (closing) {
      return
    }
    if (managedExit === null) {
      setLocalExit(true)
    } else {
      onClose()
    }
  }
  const closeRef = useRef(requestClose)
  closeRef.current = requestClose
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useLayoutEffect(() => {
    if (!localExit) {
      return
    }
    return afterMotionExit(MODAL_EXIT_MS, () => {
      setLocalExit(false)
      onCloseRef.current()
    })
  }, [localExit])

  useLayoutEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) {
      return
    }
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const parent = previous?.closest('[data-modal-surface]')
    const previousOrigin = parent ? focusOrigins.get(parent) : undefined
    const returnTo = () =>
      previous?.isConnected && !previous.closest('[inert], [data-modal-state="closing"]')
        ? previous
        : (previousOrigin?.() ?? null)
    focusOrigins.set(dialog, returnTo)
    const layer = pushLayer(() => closeRef.current())
    layerRef.current = layer
    const cancel = confirmation
      ? dialog.querySelector<HTMLButtonElement>(
          '[data-dialog-footer] button:first-child:not(:disabled)'
        )
      : null
    ;(cancel ?? dialog).focus({ preventScroll: true })
    const onTab = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || event.defaultPrevented || !isTopLayer(layer)) {
        return
      }
      const stops = [...dialog.querySelectorAll<HTMLElement>(controls)].filter(
        (element) =>
          element.tabIndex >= 0 &&
          !element.closest('[inert]') &&
          element.getClientRects().length > 0
      )
      const first = stops[0]
      const last = stops.at(-1)
      const active = document.activeElement
      if (!first || dialog.dataset.modalState === 'closing') {
        event.preventDefault()
        dialog.focus({ preventScroll: true })
      } else if (
        !dialog.contains(active) ||
        active === dialog ||
        active === (event.shiftKey ? first : last)
      ) {
        event.preventDefault()
        ;(event.shiftKey ? last : first)?.focus({ preventScroll: true })
      }
    }
    const viewport = window.visualViewport
    const fitViewport = () => {
      if (!viewport || viewport.scale !== 1) {
        return
      }
      overlayRef.current?.style.setProperty('--dialog-height', `${viewport.height}px`)
      overlayRef.current?.style.setProperty('--dialog-top', `${viewport.offsetTop}px`)
    }
    fitViewport()
    viewport?.addEventListener('resize', fitViewport)
    viewport?.addEventListener('scroll', fitViewport)
    document.addEventListener('keydown', onTab)
    return () => {
      const restore =
        isTopLayer(layer) &&
        (dialog.contains(document.activeElement) || document.activeElement === document.body)
      popLayer(layer)
      layerRef.current = null
      viewport?.removeEventListener('resize', fitViewport)
      viewport?.removeEventListener('scroll', fitViewport)
      document.removeEventListener('keydown', onTab)
      if (restore) {
        returnTo()?.focus({ preventScroll: true })
      }
    }
  }, [confirmation])

  return createPortal(
    <Presence.Provider value={null}>
      <div
        ref={overlayRef}
        className={styles.overlay}
        data-placement={placement}
        data-modal-state={closing ? 'closing' : 'open'}
        onMouseDown={(event) => {
          if (
            event.target === event.currentTarget &&
            layerRef.current &&
            isTopLayer(layerRef.current)
          ) {
            requestClose()
          }
        }}
        onClickCapture={(event) => {
          if (closing) {
            event.preventDefault()
            event.stopPropagation()
          }
        }}
        onKeyDownCapture={(event) => {
          if (closing) {
            event.preventDefault()
            event.stopPropagation()
          }
        }}
      >
        <div
          ref={dialogRef}
          data-confirmation={confirmation || undefined}
          data-modal-surface=""
          data-modal-state={closing ? 'closing' : 'open'}
          className={clsx(styles.content, className)}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
        >
          <div className={styles.header}>
            <div id={titleId} className={styles.title}>
              {title}
            </div>
            {closable ? (
              <IconButton
                className={styles.close}
                tone="primary"
                icon={<IconCloseOutline16 />}
                aria-label={t('close')}
                onClick={requestClose}
              />
            ) : null}
          </div>
          {children ? <div className={clsx(styles.main, mainClassName)}>{children}</div> : null}
          {footer ? (
            <div data-dialog-footer="" className={styles.footer}>
              {footer}
            </div>
          ) : null}
        </div>
      </div>
    </Presence.Provider>,
    document.body
  )
}

/** A decision uses the same surface and motion in every feature. The safe action comes first. */
export const ConfirmationModal = (props: {
  title: ReactNode
  children: ReactNode
  footer: ReactNode
  onClose: () => void
}) => {
  const mobile = useIsMobile()
  return <Modal {...props} confirmation placement={mobile ? 'bottom' : 'center'} />
}
