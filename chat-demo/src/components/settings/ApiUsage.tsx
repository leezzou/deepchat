import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useIsSettingsMobile } from '../../app/viewport.js'
import { resolveLocale, useTranslate } from '../../i18n/index.js'
import { USAGE_CHANGED, readUsageLedger, type UsageRow } from '../../services/usage/ledger.js'
import { summarizeUsage } from '../../services/usage/totals.js'
import { useSettings } from '../../services/settings.js'
import { hasAccountBridge, returnToAccount } from '../../shell/account.js'
import { openExternal } from '../../shell/native.js'
import { Modal, ModalPresence } from '../base/Modal.js'
import { IconChevronRightOutline14, IconRefreshOutline16 } from '../base/icons.js'
import { MobileSettingsHeader } from './MobileSettingsHeader.js'
import { useRouteBack, useRouteMotion } from './routeMotion.js'
import settings from './Settings.module.css'
import styles from './ApiUsage.module.css'

const usageEvent = 'deepchat:open-api-usage'
export const openApiUsage = () => window.dispatchEvent(new Event(usageEvent))

type UsageSource = 'settings' | 'account'

export const ApiUsageDialog = () => {
  const [source, setSource] = useState<UsageSource | null>(null)
  const [leaving, setLeaving] = useState(false)
  const closing = useRef(false)
  const mobile = useIsSettingsMobile()
  const t = useTranslate()
  useEffect(() => {
    const show = (event: Event) => {
      closing.current = false
      setLeaving(false)
      setSource(
        event instanceof CustomEvent && event.detail?.fromAccount === true ? 'account' : 'settings'
      )
    }
    window.addEventListener(usageEvent, show)
    return () => window.removeEventListener(usageEvent, show)
  }, [])
  useLayoutEffect(() => {
    if (!mobile && leaving) {
      setSource(null)
    }
  }, [mobile, leaving])
  const close = () => {
    if (closing.current) {
      return
    }
    closing.current = true
    if (source === 'account' && hasAccountBridge) {
      returnToAccount()
    }
    if (mobile) {
      setLeaving(true)
    } else {
      setSource(null)
    }
  }
  const title = t('usageTitle')
  if (mobile) {
    return source ? (
      <MobileUsagePage
        title={title}
        source={source}
        leaving={leaving}
        onClose={close}
        onExited={() => setSource(null)}
      >
        <UsageReport />
      </MobileUsagePage>
    ) : null
  }
  return (
    <ModalPresence>
      {source ? (
        <Modal
          title={title}
          closable
          onClose={close}
          className={styles.dialog}
          mainClassName={styles.desktopBody}
        >
          <UsageReport />
        </Modal>
      ) : null}
    </ModalPresence>
  )
}

/** Keep the native focus trap and its transparent backdrop until the page has slid away. */
const MobileUsagePage = ({
  title,
  source,
  leaving,
  onClose,
  onExited,
  children,
}: {
  title: string
  source: UsageSource
  leaving: boolean
  onClose: () => void
  onExited: () => void
  children: ReactNode
}) => {
  const dialog = useRef<HTMLDialogElement>(null)
  useLayoutEffect(() => {
    const page = dialog.current
    if (!page) {
      return
    }
    const previous = document.activeElement
    page.showModal()
    page.focus({ preventScroll: true })
    return () => {
      page.close()
      if (previous instanceof HTMLElement && previous.isConnected) {
        previous.focus({ preventScroll: true })
      }
    }
  }, [])
  const surface = useRouteMotion<HTMLDivElement>(true, leaving, onExited)
  useRouteBack(onClose)
  return createPortal(
    <dialog
      ref={dialog}
      tabIndex={-1}
      aria-label={title}
      className={styles.mobileDialog}
      data-usage-source={source}
      data-route-position={leaving ? 'leaving' : 'front'}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      <div
        ref={surface}
        className={settings.page}
        data-route-position={leaving ? 'leaving' : 'front'}
        {...(leaving ? { inert: '' } : {})}
      >
        <MobileSettingsHeader title={title} onBack={onClose} />
        <div className={`${settings.body} ${styles.mobileBody}`}>{children}</div>
      </div>
    </dialog>,
    document.body
  )
}

type Period = 1 | 7 | 30 | 'all'
type Totals = ReturnType<typeof summarizeUsage>
const periods: Period[] = [1, 7, 30, 'all']
const purposeNames = {
  chat: 'usageChat',
  regenerate: 'usageRegenerate',
  continue: 'usageContinue',
  summary: 'usageSummary',
  title: 'usageTitleRequest',
  'search-plan': 'usageSearchPlan',
  legacy: 'usageLegacy',
} as const
const statusNames = {
  done: 'usageDone',
  failed: 'usageFailed',
  stopped: 'usageStopped',
  pending: 'usagePending',
  interrupted: 'usageInterrupted',
} as const
// A legacy receipt can lack a model ID. Keep that filter separate from All models.
const unknownModel = '\u0001unknown'
const pageSize = 10
const midnight = (at: number, offset = 0) => {
  const date = new Date(at)
  return +new Date(date.getFullYear(), date.getMonth(), date.getDate() + offset)
}
const displayRoute = (id: string, t: ReturnType<typeof useTranslate>) =>
  id === 'legacy' || !id ? t('usageUnknown') : id === 'DeepSeek account' ? t('usageAccount') : id
const unique = (values: string[]) => Array.from(new Set(values)).sort((a, b) => a.localeCompare(b))

function UsageReport() {
  const t = useTranslate()
  const locale = useSettings((s) => resolveLocale(s.locale))
  const [period, setPeriod] = useState<Period>(7)
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const [snapshot, setSnapshot] = useState<{ rows: UsageRow[]; at: number }>()
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(true)
  const [revision, refresh] = useState(0)
  const [linkError, setLinkError] = useState(false)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const changed = () => {
      clearTimeout(timer)
      timer = setTimeout(() => refresh((n) => n + 1), 150)
    }
    window.addEventListener(USAGE_CHANGED, changed)
    return () => {
      window.removeEventListener(USAGE_CHANGED, changed)
      clearTimeout(timer)
    }
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    void readUsageLedger(controller.signal)
      .then((rows) => {
        if (!controller.signal.aborted) {
          setSnapshot({ rows, at: Date.now() })
          setError(false)
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setError(true)
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false)
        }
      })
    return () => controller.abort()
  }, [revision])
  const providers = useMemo(() => unique((snapshot?.rows ?? []).map((r) => r.provider)), [snapshot])
  const models = useMemo(
    () =>
      unique(
        (snapshot?.rows ?? [])
          .filter((r) => !provider || r.provider === provider)
          .map((r) => r.model)
      ),
    [provider, snapshot]
  )
  const rows = useMemo(() => {
    if (!snapshot) {
      return []
    }
    const start = period === 'all' ? -Infinity : midnight(snapshot.at, 1 - period)
    return snapshot.rows.filter(
      (r) =>
        r.at >= start &&
        r.at <= snapshot.at &&
        (!provider || provider === r.provider) &&
        (!model || model === (r.model || unknownModel))
    )
  }, [snapshot, period, provider, model])
  const dateTime = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }),
    [locale]
  )
  return (
    <div data-api-usage className={styles.report}>
      <section>
        <div className={styles.sectionHeader}>
          <h2>{t('usageLocal')}</h2>
          <button
            type="button"
            className={styles.refresh}
            disabled={loading}
            onClick={() => refresh((n) => n + 1)}
            aria-label={t('usageRefresh')}
            title={t('usageRefresh')}
          >
            <IconRefreshOutline16 />
          </button>
        </div>
        <div className={styles.group}>
          <div role="group" aria-label={t('usagePeriod')} className={styles.periods}>
            {periods.map((p) => (
              <button
                type="button"
                data-usage-days={p}
                key={p}
                aria-pressed={period === p}
                onClick={() => setPeriod(p)}
              >
                <span>
                  {p === 1
                    ? t('usageToday')
                    : p === 'all'
                      ? t('usageAllTime')
                      : t('usageDays', { days: p })}
                </span>
              </button>
            ))}
          </div>
          {snapshot && (
            <div className={styles.filters}>
              <label>
                {t('usageProvider')}
                <select
                  data-usage-filter="provider"
                  value={provider}
                  onChange={(e) => {
                    setProvider(e.target.value)
                    setModel('')
                  }}
                >
                  <option value="">{t('usageAllProviders')}</option>
                  {providers.filter(Boolean).map((id) => (
                    <option key={id} value={id}>
                      {displayRoute(id, t)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t('usageModel')}
                <select
                  data-usage-filter="model"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                >
                  <option value="">{t('usageAllModels')}</option>
                  {models.map((id) => (
                    <option key={id} value={id || unknownModel}>
                      {displayRoute(id, t)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
          {error && (
            <p role="alert" className={styles.status}>
              {t('usageError')}
            </p>
          )}
          {!error && !snapshot && (
            <p role="status" className={styles.status}>
              {t('usageLoading')}
            </p>
          )}
          {snapshot && (
            <div data-usage-loaded="">
              {rows.length ? (
                <ReportResults
                  key={JSON.stringify([period, provider, model])}
                  rows={rows}
                  locale={locale}
                />
              ) : (
                <div className={styles.empty} role="status">
                  <strong>{t('usageEmpty')}</strong>
                  <p>{t(snapshot.rows.length ? 'usageFilteredEmpty' : 'usageEmptyHint')}</p>
                </div>
              )}
            </div>
          )}
        </div>
      </section>
      <div className={styles.group}>
        <details className={styles.details}>
          <summary>
            {t('usageAbout')}
            <IconChevronRightOutline14 />
          </summary>
          <div className={styles.note}>
            <p>{t('usageScope')}</p>
            <p>{t('usageNote')}</p>
          </div>
        </details>
        <button
          type="button"
          data-api-usage-official
          className={styles.official}
          onClick={() => {
            setLinkError(false)
            void openExternal('https://platform.deepseek.com/usage').catch(() => setLinkError(true))
          }}
        >
          <span>
            <strong>{t('usageOfficial')}</strong>
            <small>{t('usageOfficialHint')}</small>
          </span>
          <IconChevronRightOutline14 />
        </button>
        {linkError && (
          <p className={styles.status} role="alert">
            {t('usageOfficialError')}
          </p>
        )}
      </div>
      {snapshot && (
        <p className={styles.updated}>
          {t('usageUpdated', { time: dateTime.format(snapshot.at) })}
        </p>
      )}
    </div>
  )
}

const fields = [
  ['input', 'usageInput'],
  ['inputHit', 'usageInputHit'],
  ['inputRate', 'usageInputRate'],
  ['output', 'usageOutput'],
  ['outputHit', 'usageOutputHit'],
  ['outputRate', 'usageOutputRate'],
  ['cacheWrite', 'usageCacheWrite'],
] as const
function Metrics({ counts, locale }: { counts: Totals; locale: string }) {
  const t = useTranslate()
  const number = useMemo(() => new Intl.NumberFormat(locale), [locale])
  const percent = useMemo(
    () => new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }),
    [locale]
  )
  return (
    <dl className={styles.breakdown}>
      {fields.map(([key, label]) => {
        const isRate = key === 'inputRate' || key === 'outputRate'
        const field = key === 'inputRate' ? 'inputHit' : key === 'outputRate' ? 'outputHit' : key
        const count = counts[field]
        let value: string,
          text: string,
          reported = count.reported
        if (isRate) {
          const cache = counts[key === 'inputRate' ? 'inputHit' : 'outputHit']
          reported = cache.paired
          const ratio = cache.base > 0n ? Number(cache.pairedHits) / Number(cache.base) : undefined
          value = ratio == null ? 'missing' : String(Number((ratio * 100).toFixed(1)))
          text =
            ratio == null ? t(reported ? 'usageNoBase' : 'usageMissing') : percent.format(ratio)
        } else {
          value = reported ? String(count.value) : 'missing'
          text = reported ? number.format(count.value) : t('usageMissing')
        }
        return (
          <div key={key}>
            <dt>{t(label)}</dt>
            <dd data-usage-metric={key} data-value={value}>
              {text}
              {reported > 0 && reported < counts.requests && (
                <small>{t('usagePartial', { known: reported, total: counts.requests })}</small>
              )}
            </dd>
          </div>
        )
      })}
    </dl>
  )
}

function Pager({
  index,
  pages,
  setIndex,
}: {
  index: number
  pages: number
  setIndex: (i: number) => void
}) {
  const t = useTranslate()
  if (pages <= 1) {
    return null
  }
  return (
    <div className={styles.pager}>
      <button type="button" disabled={index === 0} onClick={() => setIndex(index - 1)}>
        {t('usagePrevious')}
      </button>
      <span aria-live="polite">{t('usagePage', { page: index + 1, pages })}</span>
      <button type="button" disabled={index + 1 === pages} onClick={() => setIndex(index + 1)}>
        {t('usageNext')}
      </button>
    </div>
  )
}
function ReportResults({ rows, locale }: { rows: UsageRow[]; locale: string }) {
  const t = useTranslate()
  const [requestPage, setRequestPage] = useState(0)
  const [dayPage, setDayPage] = useState(0)
  const counts = useMemo(() => summarizeUsage(rows), [rows])
  const byDay = useMemo(() => {
    const days = new Map<number, UsageRow[]>()
    for (const row of rows) {
      const at = midnight(row.at)
      const group = days.get(at)
      if (group) {
        group.push(row)
      } else {
        days.set(at, [row])
      }
    }
    return Array.from(days, ([at, records]) => ({ at, counts: summarizeUsage(records) }))
  }, [rows])
  const format = useMemo(() => new Intl.NumberFormat(locale), [locale])
  const date = useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }), [locale])
  const time = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'medium' }),
    [locale]
  )
  const requestsPages = Math.ceil(rows.length / pageSize),
    daysPages = Math.ceil(byDay.length / pageSize)
  const ri = Math.min(requestPage, requestsPages - 1),
    di = Math.min(dayPage, daysPages - 1)
  const hasTokens = counts.input.reported + counts.output.reported > 0
  const total = counts.input.value + counts.output.value
  return (
    <>
      <div data-usage-summary>
        <div className={styles.overview}>
          <span>{t('usageTotal')}</span>
          <strong data-usage-total={hasTokens ? String(total) : 'missing'}>
            {hasTokens ? format.format(total) : t('usageMissing')}
          </strong>
          <small>{t('usageRequestsCount', { count: format.format(counts.requests) })}</small>
        </div>
        <Metrics counts={counts} locale={locale} />
        <p className={styles.explainer}>{t('usageRateNote')}</p>
      </div>
      <details className={styles.details}>
        <summary>
          {t('usageDaily')}
          <IconChevronRightOutline14 />
        </summary>
        <div className={styles.rows}>
          {byDay.slice(di * pageSize, (di + 1) * pageSize).map((day) => (
            <details key={day.at} className={styles.entry}>
              <summary>
                <span>{date.format(day.at)}</span>
                <small>
                  {t('usageRequestsCount', { count: format.format(day.counts.requests) })}
                </small>
              </summary>
              <Metrics counts={day.counts} locale={locale} />
            </details>
          ))}
          <Pager index={di} pages={daysPages} setIndex={setDayPage} />
        </div>
      </details>
      <details data-usage-requests className={styles.details}>
        <summary>
          {t('usageRequests')}
          <IconChevronRightOutline14 />
        </summary>
        <div className={styles.rows}>
          {rows.slice(ri * pageSize, (ri + 1) * pageSize).map((row) => (
            <details
              data-usage-row
              key={row.id}
              data-provider={row.provider}
              data-model={row.model}
              data-status={row.status}
              data-purpose={row.purpose}
              className={styles.entry}
            >
              <summary>
                <span>
                  <strong>{displayRoute(row.model, t)}</strong>
                  <small>
                    {displayRoute(row.provider, t)} · {t(purposeNames[row.purpose])} ·{' '}
                    {t(statusNames[row.status])}
                  </small>
                  <time dateTime={new Date(row.at).toISOString()}>{time.format(row.at)}</time>
                </span>
                <IconChevronRightOutline14 />
              </summary>
              <Metrics counts={summarizeUsage([row])} locale={locale} />
            </details>
          ))}
          <Pager index={ri} pages={requestsPages} setIndex={setRequestPage} />
        </div>
      </details>
    </>
  )
}
