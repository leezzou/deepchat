import { useEffect } from 'react'
import type { WorkBuddyModelInfo } from '../../services/workbuddy/models.js'
import { refreshWorkBuddyCatalog, useWorkBuddyState } from '../../services/workbuddy/provider.js'
import { Select } from '../base/Select.js'
import { IconRefreshOutline16 } from '../base/icons.js'
import './workBuddyModelPicker.css'

export function workBuddyModelOption(row: WorkBuddyModelInfo, en: boolean, cached: boolean) {
  const { id, name, rate } = row
  const model = name.toLowerCase() === id.toLowerCase() ? name : `${name} (${id})`
  let price = en ? 'Rate unknown' : '费率未知'
  if (rate?.free) {
    price = en ? 'Free' : '免费'
  } else if (rate?.multiplier !== undefined) {
    price = `${rate.multiplier}× ${en ? 'Tencent credits' : '腾讯积分'}`
  }
  const cachedLabel = cached && row.source === 'account' ? (en ? 'Cached' : '缓存') : ''
  return {
    value: id,
    label: [model, price, cachedLabel].filter(Boolean).join(' · '),
    content: (
      <span className="wb-priced-option" title={id}>
        <span>{model}</span>
        <span className="wb-rate" data-free={rate?.free || undefined}>
          {price}
        </span>
        {cachedLabel && <small>{cachedLabel}</small>}
      </span>
    ),
  }
}

export function WorkBuddyModelPicker({
  value,
  onChange,
  en,
  label,
  disabled,
}: {
  value: string
  onChange: (id: string) => void
  en: boolean
  label: string
  disabled?: boolean
}) {
  const { metadata, models, catalogLoading, catalogStale, catalogUpdatedAt, catalogError } =
    useWorkBuddyState()
  const revision = metadata?.revision
  useEffect(() => {
    if (revision) {
      void refreshWorkBuddyCatalog().catch(() => {})
    }
  }, [revision])
  const options = models.map((row) => workBuddyModelOption(row, en, catalogStale))
  const missing = Boolean(value && !models.some((row) => row.id === value))
  const time = catalogUpdatedAt
    ? new Date(catalogUpdatedAt).toLocaleString(en ? 'en-US' : 'zh-CN', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : ''
  const source = time
    ? `${en ? 'Synced' : '上次同步'} ${time}`
    : en
      ? 'Awaiting Tencent rates'
      : '等待腾讯费率'
  const status = catalogLoading
    ? en
      ? 'Refreshing rates…'
      : '正在刷新费率…'
    : catalogError
      ? `${en ? 'Refresh failed' : '刷新失败'} · ${source}`
      : source
  return (
    <div className="wb-model-picker" data-wb-model-picker>
      <Select
        key={revision ?? 'signed-out'}
        className="wb-model-select"
        value={value}
        ariaLabel={label}
        disabled={disabled || !revision || !models.length}
        placeholder={
          missing
            ? `${value} · ${en ? 'Unavailable' : '当前不可选'}`
            : en
              ? 'No available models'
              : '暂无可用模型'
        }
        options={options}
        onChange={(id) => {
          const current = useWorkBuddyState.getState()
          if (
            current.metadata?.revision === revision &&
            current.models.some((row) => row.id === id)
          ) {
            onChange(id)
          }
        }}
      />
      <div className="wb-model-sync">
        <small role="status">{status}</small>
        <button
          type="button"
          disabled={!revision || catalogLoading}
          onClick={() => void refreshWorkBuddyCatalog(true).catch(() => {})}
        >
          <IconRefreshOutline16 />
          {en ? 'Refresh rates' : '刷新费率'}
        </button>
      </div>
    </div>
  )
}
