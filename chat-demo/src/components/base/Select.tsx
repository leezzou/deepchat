import clsx from 'clsx'
import { useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useIsSettingsMobile } from '../../app/viewport.js'
import { Modal, ModalPresence } from './Modal.js'
import { useTranslate } from '../../i18n/index.js'
import { useOptionPopover } from './anchored.js'
import { IconCheckOutline16, IconChevronDownOutline14 } from './icons.js'
import styles from './Select.module.css'
import motion from './popoverMotion.module.css'

export type SelectOption<T extends string> = { value: T; label: string; lang?: string }

type SelectProps<T extends string> = {
  value: T
  options: SelectOption<T>[]
  onChange: (value: T) => void
  placeholder?: string
  ariaLabel?: string
  className?: string
  disabled?: boolean
}

export const Select = <T extends string>(props: SelectProps<T>) => {
  const mobile = useIsSettingsMobile()
  return mobile ? <TouchSelect {...props} /> : <DesktopSelect {...props} />
}

const TouchSelect = <T extends string>({
  value,
  options,
  onChange,
  placeholder,
  ariaLabel,
  className,
  disabled,
}: SelectProps<T>) => {
  const [open, setOpen] = useState(false)
  const listId = useId()
  const listRef = useRef<HTMLDivElement>(null)
  const pendingChoice = useRef<SelectOption<T> | null>(null)
  const t = useTranslate()
  const current = options.find((item) => item.value === value)
  useLayoutEffect(() => {
    if (disabled) {
      setOpen(false)
    } else if (open) {
      const selected = listRef.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')
      selected?.focus({ preventScroll: true })
      selected?.scrollIntoView({ block: 'nearest' })
    }
  }, [open, disabled])
  return (
    <>
      <button
        type="button"
        className={clsx(styles.trigger, className)}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => setOpen(true)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            setOpen(true)
          }
        }}
      >
        <span lang={current?.lang}>{current?.label ?? placeholder}</span>
        <span className={styles.arrow}>
          <IconChevronDownOutline14 />
        </span>
      </button>
      <ModalPresence
        onExited={() => {
          const choice = pendingChoice.current
          pendingChoice.current = null
          if (choice && !disabled && options.some((option) => option.value === choice.value)) {
            onChange(choice.value)
          }
        }}
      >
        {open && !disabled && (
          <Modal
            placement="bottom"
            closable
            title={ariaLabel || placeholder || t('chooseOption')}
            onClose={() => setOpen(false)}
          >
            <div
              ref={listRef}
              id={listId}
              role="listbox"
              aria-label={ariaLabel || t('chooseOption')}
              className={styles.sheetList}
              onKeyDown={(event) => {
                const rows = Array.from(
                  event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]')
                )
                const index = rows.indexOf(document.activeElement as HTMLButtonElement)
                const next = {
                  ArrowDown: (index + 1) % rows.length,
                  ArrowUp: (index + rows.length - 1) % rows.length,
                  Home: 0,
                  End: rows.length - 1,
                }[event.key]
                if (next !== undefined) {
                  event.preventDefault()
                  rows[next]?.focus()
                }
              }}
            >
              {options.map((option) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={option.value === value}
                  key={option.value}
                  className={styles.sheetOption}
                  lang={option.lang}
                  onClick={() => {
                    pendingChoice.current = option
                    setOpen(false)
                  }}
                >
                  <span>{option.label}</span>
                  <span className={styles.mark}>
                    {option.value === value && <IconCheckOutline16 />}
                  </span>
                </button>
              ))}
            </div>
          </Modal>
        )}
      </ModalPresence>
    </>
  )
}

const DesktopSelect = <T extends string>({
  value,
  options,
  onChange,
  placeholder,
  ariaLabel,
  className,
  disabled = false,
}: SelectProps<T>) => {
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
