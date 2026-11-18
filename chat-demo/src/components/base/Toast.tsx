import clsx from 'clsx'
import { useLayoutEffect, useRef } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { IconToastError16 } from './icons.js'
import { POPOVER_EXIT_MS, useMotionPresence } from './motionPresence.js'
import { useToast } from './toastState.js'
import styles from './Toast.module.css'

export const Toast = () => {
  const t = useTranslate()
  const { id, message } = useToast()
  const { present, closing } = useMotionPresence(message !== null, POPOVER_EXIT_MS)
  const last = useRef(message)
  useLayoutEffect(() => {
    if (message !== null || !present) {
      last.current = message
    }
  }, [message, present])
  const visible = message ?? last.current
  if (!present || !visible) {
    return null
  }
  const error = typeof visible !== 'string' && visible.type === 'error'
  return (
    <div
      key={id}
      className={clsx(styles.toast, error && styles.error)}
      data-state={closing ? 'closing' : 'open'}
      role="status"
    >
      {error ? (
        <span className={styles.icon}>
          <IconToastError16 />
        </span>
      ) : null}
      {typeof visible === 'string' ? (
        visible
      ) : (
        <span className={styles.content}>
          {t(visible.key, visible.params)}
          {visible.link ? (
            <a className={styles.link} href={visible.link.href} target="_blank" rel="noreferrer">
              {t(visible.link.key)}
            </a>
          ) : null}
        </span>
      )}
    </div>
  )
}
