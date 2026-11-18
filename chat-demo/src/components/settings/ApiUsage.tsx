import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useIsSettingsMobile } from '../../app/viewport.js'
import { resolveLocale, useTranslate } from '../../i18n/index.js'
import { loadRecordedUsage } from '../../services/chat/db.js'
import { sumUsageDays, totalTokens } from '../../services/chat/recordedUsage.js'
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
      setSource(event instanceof CustomEvent && event.detail?.fromAccount === true ? 'account' : 'settings')
    }
    window.addEventListener(usageEvent, show)
    return () => window.removeEventListener(usageEvent, show)
  }, [])
  useLayoutEffect(() => {
    if (!mobile && leaving) setSource(null)
  }, [mobile, leaving])
  const close = () => {
    if (closing.current) return
    closing.current = true
    if (source === 'account' && hasAccountBridge) returnToAccount()
    if (mobile) setLeaving(true)
    else setSource(null)
  }
  const title = t('usageTitle')
  if (mobile) return source ? (
    <MobileUsagePage title={title} source={source} leaving={leaving} onClose={close} onExited={() => setSource(null)}>
      <UsageReport />
    </MobileUsagePage>
  ) : null
  return (
    <ModalPresence>{source ? (
      <Modal title={title} closable onClose={close} className={styles.dialog} mainClassName={styles.desktopBody}>
        <UsageReport />
      </Modal>
    ) : null}</ModalPresence>
  )
}

/** Keep the native focus trap and its transparent backdrop until the page has slid away. */
const MobileUsagePage = ({ title, source, leaving, onClose, onExited, children }: {
  title: string; source: UsageSource; leaving: boolean; onClose: () => void; onExited: () => void; children: ReactNode
}) => {
  const dialog = useRef<HTMLDialogElement>(null)
  useLayoutEffect(() => {
    const page = dialog.current!
    const previous = document.activeElement
    page.showModal()
    page.focus({ preventScroll: true })
    return () => {
      page.close()
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true })
    }
  }, [])
  const surface = useRouteMotion<HTMLDivElement>(true, leaving, onExited)
  useRouteBack(onClose)
  return createPortal(
    <dialog ref={dialog} tabIndex={-1} aria-label={title} className={styles.mobileDialog}
      data-usage-source={source} data-route-position={leaving ? 'leaving' : 'front'}
      onCancel={(event) => { event.preventDefault(); onClose() }}>
      <div ref={surface} className={settings.page} data-route-position={leaving ? 'leaving' : 'front'}
        {...(leaving ? { inert: '' } : {})}>
        <MobileSettingsHeader title={title} onBack={onClose} />
        <div className={`${settings.body} ${styles.mobileBody}`}>{children}</div>
      </div>
    </dialog>, document.body
  )
}

type Report = Awaited<ReturnType<typeof loadRecordedUsage>>
const periods = [7, 30] as const
const categories = [
  ['usageInput', 'input'],
  ['usageCacheWrite', 'cacheWrite'],
  ['usageCacheRead', 'cacheRead'],
  ['usageOutput', 'output'],
] as const

const UsageReport = () => {
  const t = useTranslate()
  const [period, setPeriod] = useState<7 | 30>(7)
  const [report, setReport] = useState<Report | 'error' | null>(null)
  const [revision, setRevision] = useState(0)
  const [loading, setLoading] = useState(true)
  const [linkError, setLinkError] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    void loadRecordedUsage(controller.signal)
      .then(
        (data) => {
          if (!controller.signal.aborted) setReport(data)
        },
        () => {
          if (!controller.signal.aborted) setReport('error')
        }
      )
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [revision])
  const refresh = () => {
    setLoading(true)
    setRevision((value) => value + 1)
  }
  const openPlatform = async () => {
    setLinkError(false)
    try {
      await openExternal('https://platform.deepseek.com/usage')
    } catch {
      setLinkError(true)
    }
  }
  return (
    <div data-api-usage className={styles.report}>
      <div className={styles.group}>
        <button
          type="button"
          data-api-usage-official
          className={styles.official}
          onClick={openPlatform}
        >
          <span>
            <strong>{t('usageOfficial')}</strong>
            <small>{t('usageOfficialHint')}</small>
          </span>
          <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path
              d="M5 15 15 5m-8 0h8v8"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        {linkError && (
          <p className={styles.status} role="alert">
            {t('usageOfficialError')}
          </p>
        )}
      </div>
      <section>
        <h2>{t('usageLocal')}</h2>
        <div className={styles.group}>
          <div className={styles.controls}>
            <div role="group" aria-label={t('usagePeriod')} className={styles.periods}>
              {periods.map((days) => (
                <button
                  key={days}
                  type="button"
                  data-usage-days={days}
                  aria-pressed={days === period}
                  onClick={() => setPeriod(days)}
                >
                  <span>{t('usageDays', { days })}</span>
                </button>
              ))}
            </div>
            <button
              type="button"
              className={styles.refresh}
              onClick={refresh}
              disabled={loading}
              aria-label={t('usageRefresh')}
              title={t('usageRefresh')}
            >
              <IconRefreshOutline16 />
            </button>
          </div>
          {report === null ? (
            <p className={styles.status} role="status">
              {t('usageLoading')}
            </p>
          ) : report === 'error' ? (
            <p className={styles.status} role="alert">
              {t('usageError')}
            </p>
          ) : (
            <UsageResults report={report} period={period} />
          )}
        </div>
      </section>
      <div className={styles.group}>
        <details className={styles.details}>
          <summary tabIndex={0}>
            {t('usageAbout')}
            <IconChevronRightOutline14 />
          </summary>
          <div className={styles.note}>
            <p>{t('usageScope')}</p>
            <p>{t('usageNote')}</p>
          </div>
        </details>
      </div>
      {report && report !== 'error' && <Updated time={report.asOf} />}
    </div>
  )
}

const Updated = ({ time }: { time: number }) => {
  const t = useTranslate()
  const locale = useSettings((state) => resolveLocale(state.locale))
  const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' })
  return <p className={styles.updated}>{t('usageUpdated', { time: dateTime.format(time) })}</p>
}

const UsageResults = ({ report, period }: { report: Report; period: 7 | 30 }) => {
  const t = useTranslate()
  const locale = useSettings((state) => resolveLocale(state.locale))
  const date = new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric' })
  const shortDate = new Intl.DateTimeFormat(locale, { month: 'numeric', day: 'numeric' })
  const number = new Intl.NumberFormat(locale)
  const days = report.days.slice(-period)
  const sum = sumUsageDays(days)
  const peak = Math.max(1, ...days.map(([, counts]) => Number(totalTokens(counts))))
  return (
    <>
      <p data-usage-loaded="" className={styles.range}>
        {date.formatRange(days[0][0], report.asOf)}
      </p>
      {sum.replies ? (
        <>
          <div className={styles.overview}>
            <div className={styles.total}>
              <span>{t('usageTotal')}</span>
              <strong data-usage-total={String(totalTokens(sum))}>
                {number.format(totalTokens(sum))}
              </strong>
            </div>
            <div className={styles.chart} aria-hidden="true">
              {days.map(([day, counts]) => (
                <div key={day}>
                  <span style={{ height: `${(Number(totalTokens(counts)) / peak) * 100}%` }} />
                </div>
              ))}
            </div>
            <div className={styles.axis} aria-hidden="true">
              <span>{shortDate.format(days[0][0])}</span>
              <span>{shortDate.format(days.at(-1)![0])}</span>
            </div>
          </div>
          <dl className={styles.breakdown}>
            {categories.map(([label, field]) => (
              <div key={field}>
                <dt>{t(label)}</dt>
                <dd>{number.format(sum[field])}</dd>
              </div>
            ))}
          </dl>
          <div className={styles.coverage}>
            <span>{t('usageCoverage')}</span>
            <span>{number.format(sum.replies)}</span>
          </div>
          <details className={styles.details}>
            <summary tabIndex={0}>
              {t('usageDaily')}
              <IconChevronRightOutline14 />
            </summary>
            <table aria-label={t('usageDaily')}>
              <thead>
                <tr>
                  <th scope="col">{t('usageDate')}</th>
                  <th scope="col">{t('usageTotal')}</th>
                </tr>
              </thead>
              <tbody>
                {days
                  .slice()
                  .reverse()
                  .map(([day, counts]) => (
                    <tr key={day}>
                      <th scope="row">{date.format(day)}</th>
                      <td>
                        {counts.replies ? number.format(totalTokens(counts)) : t('usageNoRecord')}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </details>
        </>
      ) : (
        <div className={styles.empty} role="status">
          <strong>{t('usageEmpty')}</strong>
          <p>{t('usageEmptyHint')}</p>
        </div>
      )}
    </>
  )
}
