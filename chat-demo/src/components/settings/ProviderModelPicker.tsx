import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { resolveLocale } from '../../i18n/index.js'
import { useSettings } from '../../services/settings.js'
import { loadCatalogModels, type CatalogModel } from '../../services/api/modelCatalog.js'
import {
  discoverModels,
  inspectOllama,
  type DiscoveryProfile,
  type DiscoveredModel,
} from '../../services/api/modelDiscovery.js'
import styles from './ProviderModelPicker.module.css'

type Props = {
  id?: string
  providerId: string
  value: string
  ariaLabel: string
  onChange: (id: string, contextTokens?: number) => void
  endpoint?: string
  apiKey?: string
  discover?: boolean
  onDiscovered?: (id: string, tokens: number | undefined, source: DiscoveredModel['source'], reasoning?: DiscoveredModel['reasoning']) => void
  onAvailable?: (rows: readonly DiscoveredModel[]) => void
  onCatalogReady?: () => void
}
import { isOpenAiOrigin, isOpenAiChatModel } from '../../services/api/openAiModels.js'

type Option = { id: string; name: string; catalog?: CatalogModel; live?: DiscoveredModel }
const pageSize = 35
const empty: DiscoveredModel[] = []

/** Inline disclosure keeps the search and manual input inside the current settings page. */
export function ProviderModelPicker(props: Props) {
  // Remount on endpoint/provider switch, including pending local-model inspections.
  return <Picker key={JSON.stringify([props.providerId, props.endpoint])} {...props} />
}

function Picker({
  id,
  value,
  ariaLabel,
  providerId,
  onChange,
  endpoint,
  apiKey = '',
  discover,
  onDiscovered,
  onCatalogReady,
  onAvailable,
}: Props) {
  const english = useSettings((s) => resolveLocale(s.locale) === 'en-US')
  const tr = (zh: string, en: string) => (english ? en : zh)
  const region = useId()
  const browseButton = useRef<HTMLButtonElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const resultBox = useRef<HTMLDivElement>(null)
  const [catalog, setCatalog] = useState<readonly CatalogModel[]>([])
  const [catalogState, setCatalogState] = useState<'loading' | 'ok' | 'error'>('loading')
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(pageSize)
  const [refresh, setRefresh] = useState(0)
  const [live, setLive] = useState<DiscoveredModel[]>(empty)
  const [status, setStatus] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle')
  const [errorCode, setErrorCode] = useState('')
  const [onlyAvailable, setOnlyAvailable] = useState(false)
  const [inspecting, setInspecting] = useState(false)
  const selection = useRef<AbortController>()
  const handlers = useRef({ onDiscovered, onCatalogReady, onAvailable })
  handlers.current = { onDiscovered, onCatalogReady, onAvailable }
  const connected = useMemo(
    (): DiscoveryProfile | undefined =>
      discover && endpoint ? { providerId, endpoint, apiKey } : undefined,
    [discover, providerId, endpoint, apiKey]
  )

  useEffect(() => {
    let cancelled = false
    loadCatalogModels(providerId)
      .then((rows) => {
        if (cancelled) {
          return
        }
        setCatalog(rows)
        setCatalogState('ok')
        handlers.current.onCatalogReady?.()
      })
      .catch(() => {
        if (!cancelled) {
          setCatalogState('error')
        }
      })
    return () => {
      cancelled = true
    }
  }, [providerId, refresh])

  useLayoutEffect(() => {
    setLive(empty)
    setStatus('idle')
    setInspecting(false)
    setErrorCode('')
    setOnlyAvailable(false)
    if (!connected) {
      return
    }
    const controller = new AbortController()
    let current = true
    const timeout = setTimeout(() => controller.abort(), 45_000)
    const timer = setTimeout(
      async () => {
        setStatus('loading')
        try {
          const rows = await discoverModels(connected, controller.signal)
          if (!current || controller.signal.aborted) {
            return
          }
          setLive(rows)
          handlers.current.onAvailable?.(rows)
          setStatus('ok')
        } catch (err) {
          if (!current) {
            return
          }
          setErrorCode(err instanceof Error && /^HTTP \d{3}$/u.test(err.message) ? err.message : '')
          setStatus('error')
        } finally {
          clearTimeout(timeout)
        }
      },
      refresh ? 200 : 850
    )
    return () => {
      current = false
      clearTimeout(timeout)
      clearTimeout(timer)
      controller.abort()
      selection.current?.abort()
    }
  }, [connected, refresh])

  const currentLive = useMemo(() => live.find((item) => item.id === value), [live, value])
  useEffect(() => {
    if (status === 'ok' && value.trim()) {
      // A new server response can remove a limit. Drop the stale deployment value
      // so a known ID inherits its catalog default and an unknown ID stays editable.
      handlers.current.onDiscovered?.(
        value.trim(),
        currentLive?.contextWindow,
        currentLive?.source ?? 'endpoint',
        currentLive?.reasoning
      )
    }
  }, [currentLive, value, status])
  // An unloaded Ollama model reports its architecture limit only from /api/show.
  useEffect(() => {
    if (!connected || providerId !== 'ollama' || !currentLive || currentLive.inspected) {
      setInspecting(false)
      return
    }
    const controller = new AbortController()
    selection.current = controller
    const timer = setTimeout(() => controller.abort(), 15_000)
    setInspecting(true)
    inspectOllama(connected, currentLive, controller.signal)
      .then((model) => {
        if (!controller.signal.aborted && model.inspected) {
          setLive((rows) => rows.map((r) => (r.id === model.id ? model : r)))
        }
      })
      .catch(() => {})
      .finally(() => {
        if (selection.current === controller) {
          setInspecting(false)
        }
      })
    return () => {
      clearTimeout(timer)
      controller.abort()
      if (selection.current === controller) {
        selection.current = undefined
      }
    }
  }, [connected, providerId, currentLive])

  useEffect(() => {
    if (open) {
      searchInput.current?.focus()
    }
  }, [open])
  const options = useMemo(() => {
    const index = new Map<string, Option>()
    for (const row of live) {
      index.set(row.id, { id: row.id, name: row.name, live: row })
    }
    for (const row of catalog) {
      const option = index.get(row.id)
      if (option) {
        option.catalog = row
        if (option.name === row.id) {
          option.name = row.name
        }
      } else if (!onlyAvailable) {
        index.set(row.id, { id: row.id, name: row.name, catalog: row })
      }
    }
    return [...index.values()]
  }, [catalog, live, onlyAvailable])
  const matches = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/u)
    return options.filter((r) =>
      words.every((word) => `${r.id} ${r.name}`.toLowerCase().includes(word))
    )
  }, [query, options])
  const picked = options.find((r) => r.id === value.trim())
  const capacity = (o: Option) =>
    o.live?.contextWindow ??
    (o.catalog?.scope !== 'local-reference'
      ? (o.catalog?.contextWindow ?? o.catalog?.inputLimit)
      : undefined)
  const source = (o: Option) => {
    const liveLabel =
      o.live?.source === 'instance'
        ? tr('已加载实例', 'Loaded instance')
        : o.live?.source === 'model'
          ? tr('本地模型', 'Local model')
          : tr('接口返回', 'Endpoint')
    const label = o.live
      ? liveLabel
      : o.catalog?.scope === 'local-reference'
        ? tr('本地部署参考', 'Library reference')
        : tr('离线目录', 'Offline catalog')
    const count = capacity(o)
    const input =
      o.live?.source === 'input' ||
      (!o.live?.contextWindow && !o.catalog?.contextWindow && o.catalog?.inputLimit)
    const fallback = !o.live?.contextWindow && o.live && count ? tr('目录', 'Catalog') + ' · ' : ''
    return (
      label +
      ' · ' +
      (count
        ? fallback +
          (input
            ? tr('输入上限 ', 'Input limit ')
            : o.live?.source === 'model'
              ? tr('模型规格上限 ', 'Model maximum ')
              : tr('上下文 ', 'Context ')) +
          count.toLocaleString(english ? 'en-US' : 'zh-CN')
        : tr('上下文可手填', 'Set context manually')) +
      (o.catalog?.supportsChatCompletions === false && !(endpoint && isOpenAiOrigin(endpoint) && isOpenAiChatModel(o.id))
        ? tr(' · 需其他协议', ' · Other protocol required')
        : '')
    )
  }
  const close = () => {
    setOpen(false)
    browseButton.current?.focus()
  }
  return (
    <div className={styles.picker}>
      <input
        className={styles.input}
        id={id}
        aria-label={ariaLabel}
        value={value}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        placeholder={tr('输入模型 ID', 'Enter a model ID')}
        onChange={(e) => onChange(e.target.value)}
      />
      {picked && <small className={styles.hint}>{source(picked)}</small>}
      <div className={styles.actions}>
        <button
          type="button"
          data-testid="model-picker-browse"
          ref={browseButton}
          aria-expanded={open}
          aria-controls={region}
          onClick={() => {
            setOpen(!open)
            setLimit(pageSize)
            setQuery('')
          }}
        >
          {open ? tr('收起目录', 'Hide catalog') : tr('搜索模型', 'Browse models')}{' '}
          {options.length > 0 && `(${options.length})`}
        </button>
        {endpoint && (
          <button
            type="button"
            data-testid="model-picker-refresh"
            disabled={!connected || status === 'loading'}
            onClick={() => setRefresh((n) => n + 1)}
          >
            {tr('刷新列表', 'Refresh list')}
          </button>
        )}
      </div>
      {endpoint && (
        <div className={styles.hint} aria-live="polite">
          {status === 'loading'
            ? tr('正在获取接口可用模型…', 'Fetching available models…')
            : status === 'error'
              ? `${tr('获取失败，仍可从目录选择或手填。', 'Could not fetch models. Browse the catalog or enter an ID.')} ${errorCode}`
              : status === 'ok'
                ? tr(
                    `当前接口返回 ${live.length} 个模型。`,
                    `Endpoint returned ${live.length} models.`
                  )
                : !connected
                  ? tr(
                      '填写当前接口的密钥后自动获取列表。',
                      'Enter a key for this endpoint to fetch models.'
                    )
                  : ''}
          {inspecting && tr(' 正在读取本地模型参数…', ' Reading local model settings…')}
        </div>
      )}
      {open && (
        <section
          id={region}
          aria-label={ariaLabel}
          className={styles.panel}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation()
              close()
            }
          }}
        >
          <input
            type="search"
            ref={searchInput}
            data-testid="model-picker-search"
            className={styles.input}
            autoComplete="off"
            aria-label={tr('搜索模型名称或 ID', 'Search model names or IDs')}
            placeholder={tr('搜索名称或模型 ID', 'Search name or model ID')}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setLimit(pageSize)
              if (resultBox.current) {
                resultBox.current.scrollTop = 0
              }
            }}
          />
          <div className={styles.toolbar}>
            <small role="status">
              {matches.length} {tr('项结果', 'results')}
            </small>
            {live.length > 0 && (
              <label>
                <input
                  type="checkbox"
                  checked={onlyAvailable}
                  onChange={(e) => {
                    setOnlyAvailable(e.target.checked)
                    setLimit(pageSize)
                  }}
                />
                {tr('仅接口返回', 'Endpoint only')}
              </label>
            )}
          </div>
          <div className={styles.results} ref={resultBox}>
            {matches.slice(0, limit).map((option) => (
              <button
                type="button"
                data-model-id={option.id}
                key={option.id}
                aria-pressed={value === option.id}
                className={styles.result}
                onClick={() => {
                  onChange(option.id, capacity(option))
                  close()
                }}
              >
                <span>{option.name || option.id}</span>
                {option.name !== option.id && <small>{option.id}</small>}
                <small>{source(option)}</small>
              </button>
            ))}
            {matches.length > limit && (
              <button
                type="button"
                className={styles.more}
                onClick={() => setLimit((n) => n + pageSize)}
              >
                {tr('显示更多', 'Show more')} · {matches.length - limit}
              </button>
            )}
            {!matches.length && (
              <p className={styles.hint}>
                {catalogState === 'loading'
                  ? tr('正在读取离线目录…', 'Loading offline catalog…')
                  : catalogState === 'error'
                    ? tr(
                        '目录不可用，可直接输入模型 ID。',
                        'Catalog unavailable. Enter a model ID above.'
                      )
                    : tr('没有匹配项，可直接输入模型 ID。', 'No matches. Enter a model ID above.')}
              </p>
            )}
          </div>
        </section>
      )}
    </div>
  )
}
