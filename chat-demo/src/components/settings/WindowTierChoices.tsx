import styles from './ContextModelSettings.module.css'

export function WindowTierChoices({
  tiers,
  selected,
  en,
  disabled,
  onSelect,
}: {
  tiers?: number[]
  selected?: number
  en: boolean
  disabled?: boolean
  onSelect: (tokens: number) => void
}) {
  if (!tiers?.length) {
    return null
  }
  return (
    <div
      className={styles.tiers}
      role="group"
      aria-label={en ? 'Context window tiers' : '上下文窗口档位'}
    >
      {tiers.map((tokens) => (
        <button
          type="button"
          key={tokens}
          data-context-tier={tokens}
          disabled={disabled}
          aria-pressed={selected === tokens}
          onClick={() => onSelect(tokens)}
        >
          {tokens.toLocaleString(en ? 'en-US' : 'zh-CN')}
          {tokens === tiers.at(-1) && <small>{en ? 'Highest' : '最高'}</small>}
        </button>
      ))}
    </div>
  )
}
