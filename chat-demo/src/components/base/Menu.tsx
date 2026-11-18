import clsx from 'clsx'
import { type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useOptionPopover } from './anchored.js'
import styles from './Menu.module.css'
import motion from './popoverMotion.module.css'

export type MenuOption = {
  key: string
  label: string
  icon: ReactNode
  danger?: boolean
  onSelect: () => void
}

export const Menu = ({
  options,
  children,
}: {
  options: MenuOption[]
  children: (props: { open: boolean; toggle: () => void }) => ReactNode
}) => {
  const menu = useOptionPopover<HTMLSpanElement>({ align: 'start', alignOffset: -5, offset: 4 })
  return (
    <>
      <span ref={menu.anchorRef} className={styles.anchor}>
        {children({ open: menu.open, toggle: menu.toggle })}
      </span>
      {menu.present
        ? createPortal(
            <div
              ref={menu.floatingRef}
              className={clsx(styles.menu, motion.popover)}
              data-state={menu.closing ? 'closing' : 'open'}
              style={menu.position ?? { visibility: 'hidden' }}
              role="menu"
              onKeyDown={menu.onKeyDown}
            >
              {options.map((option) => (
                <button
                  key={option.key}
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  className={clsx(styles.option, option.danger && styles.danger)}
                  onClick={() => menu.choose(option.onSelect)}
                >
                  <span className={styles.icon}>{option.icon}</span>
                  {option.label}
                </button>
              ))}
            </div>,
            document.body
          )
        : null}
    </>
  )
}
