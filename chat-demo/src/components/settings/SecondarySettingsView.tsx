import { useId, type ReactNode } from 'react'
import { IconChevronRightOutline14 } from '../base/icons.js'
import { SettingsIcon, type SettingsIconName } from './SettingsIcon.js'
import './secondarySettings.css'

export function SettingsSection({ title, children }: { title?: string; children: ReactNode }) {
  const id = useId()
  return (
    <section className="secondary-section" aria-labelledby={title ? id : undefined}>
      {title && <h2 id={id}>{title}</h2>}
      <div className="secondary-surface">{children}</div>
    </section>
  )
}

export function SettingsEmpty({
  icon,
  title,
  children,
}: {
  icon: SettingsIconName
  title: string
  children: ReactNode
}) {
  return (
    <div className="secondary-empty">
      <SettingsIcon name={icon} />
      <strong>{title}</strong>
      <p>{children}</p>
    </div>
  )
}

export function SettingsLink({
  icon,
  children,
  onClick,
  ...attributes
}: {
  icon: SettingsIconName
  children: ReactNode
  onClick: () => void
  'data-api-usage-entry'?: boolean
}) {
  return (
    <button {...attributes} type="button" className="secondary-link" onClick={onClick}>
      <SettingsIcon name={icon} />
      <span>{children}</span>
      <IconChevronRightOutline14 />
    </button>
  )
}
