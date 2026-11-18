import clsx from 'clsx'
import { createPortal } from 'react-dom'
import { useOptionPopover } from './anchored.js'
import { IconCheckOutline16, IconChevronDownOutline14 } from './icons.js'
import styles from './Select.module.css'
import motion from './popoverMotion.module.css'

export type SelectOption<T extends string> = { value: T; label: string; lang?: string }

export const Select = <T extends string>({
  value,
  options,
  onChange,
  placeholder,
  ariaLabel,
  className,
  disabled = false,
}: {
  value: T
  options: SelectOption<T>[]
  onChange: (value: T) => void
  placeholder?: string
  ariaLabel?: string
  className?: string
  disabled?: boolean
}) => {
  const menu = useOptionPopover<HTMLButtonElement>(
    { align: 'end', maxHeight: 320, minSpace: 160 },
    disabled
  )
  const current = options.find((option) => option.value === value)
  return (
    <>
      <button
        ref={menu.anchorRef}
        type="button"
        className={clsx(styles.trigger, menu.open && styles.open, className)}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={menu.open}
        disabled={disabled}
        onClick={menu.toggle}
        onKeyDown={(event) => {
          if (!menu.open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault()
            menu.toggle()
          }
        }}
      >
        {current ? (
          <span lang={current.lang}>{current.label}</span>
        ) : (
          <span className={styles.placeholder}>{placeholder}</span>
        )}
        <span className={styles.arrow}>
          <IconChevronDownOutline14 />
        </span>
      </button>
      {menu.present
        ? createPortal(
            <div
              ref={menu.floatingRef}
              className={clsx(styles.menu, motion.popover)}
              data-state={menu.closing ? 'closing' : 'open'}
              style={menu.position ?? { visibility: 'hidden' }}
              role="listbox"
              aria-label={ariaLabel}
              onKeyDown={menu.onKeyDown}
            >
              {options.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  tabIndex={-1}
                  role="option"
                  lang={option.lang}
                  aria-selected={option.value === value}
                  className={styles.option}
                  onClick={() => menu.choose(() => onChange(option.value))}
                >
                  <span>{option.label}</span>
                  {option.value === value ? <IconCheckOutline16 /> : null}
                </button>
              ))}
            </div>,
            document.body
          )
        : null}
    </>
  )
}
