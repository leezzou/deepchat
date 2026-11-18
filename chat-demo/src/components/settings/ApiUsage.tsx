import { useEffect, useState } from 'react'
import { resolveLocale, useTranslate } from '../../i18n/index.js'
import { loadRecordedUsage } from '../../services/chat/db.js'
import { sumUsageDays, totalTokens } from '../../services/chat/recordedUsage.js'
import { useSettings } from '../../services/settings.js'
import { openExternal } from '../../shell/native.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { IconRefreshOutline16 } from '../base/icons.js'
import styles from './ApiUsage.module.css'

const usageEvent = 'deepchat:open-api-usage'
export const openApiUsage = () => window.dispatchEvent(new Event(usageEvent))

/** Mounted with Settings so both the API Key entry and the native account entry use this page. */
export const ApiUsageDialog = () => {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const show = () => setOpen(true)
    window.addEventListener(usageEvent, show)
    return () => window.removeEventListener(usageEvent, show)
  }, [])
  return open ? <ApiUsagePage onClose={() => setOpen(false)} /> : null
}

type Report = Awaited<ReturnType<typeof loadRecordedUsage>>
const periods = [7, 30] as const

const ApiUsagePage = ({ onClose }: { onClose: () => void }) => {
  const t = useTranslate()
  const [period, setPeriod] = useState<7 | 30>(7)
  const [report, setReport] = useState<Report | 'error' | null>(null)
  const [revision, setRevision] = useState(0)
  const [linkError, setLinkError] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    void loadRecordedUsage(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) {
          setReport(data)
        }
      },
      () => {
        if (!controller.signal.aborted) {
          setReport('error')
        }
      }
    )
    return () => controller.abort()
  }, [revision])
  const refresh = () => {
    setReport(null)
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
    <Modal
      title={t('usageTitle')}
      closable
      onClose={onClose}
      className={styles.dialog}
      mainClassName={styles.content}
    >
      <div data-api-usage className={styles.report}>
        <div className={styles.official}>
          <Button data-api-usage-official variant="outlined" size="m" onClick={openPlatform}>
            {t('usageOfficial')} <span aria-hidden="true">↗</span>
          </Button>
          <p>{t('usageOfficialHint')}</p>
          {linkError && <p role="alert">{t('usageOfficialError')}</p>}
        </div>
        <h2>{t('usageLocal')}</h2>
        <p>{t('usageScope')}</p>
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
                {t('usageDays', { days })}
              </button>
            ))}
          </div>
          <button
            type="button"
            className={styles.refresh}
            onClick={refresh}
            disabled={!report}
            aria-label={t('usageRefresh')}
            title={t('usageRefresh')}
          >
            <IconRefreshOutline16 />
          </button>
        </div>
        {!report ? (
          <p role="status">{t('usageLoading')}</p>
        ) : report === 'error' ? (
          <p role="alert">{t('usageError')}</p>
        ) : (
          <UsageResults report={report} period={period} />
        )}
      </div>
    </Modal>
  )
}

const categories = [
  ['usageInput', 'input'],
  ['usageCacheWrite', 'cacheWrite'],
  ['usageCacheRead', 'cacheRead'],
  ['usageOutput', 'output'],
] as const

const UsageResults = ({ report, period }: { report: Report; period: 7 | 30 }) => {
  const t = useTranslate()
  const locale = useSettings((state) => resolveLocale(state.locale))
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' })
  const shortDate = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' })
  const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' })
  const number = new Intl.NumberFormat(locale)
  const days = report.days.slice(-period)
  const sum = sumUsageDays(days)
  const peak = Math.max(1, ...days.map(([, counts]) => Number(totalTokens(counts))))
  return (
    <>
      <p data-usage-loaded="" className={styles.range}>
        {t('usageDateRange', { start: date.format(days[0][0]), end: date.format(report.asOf) })}
      </p>
      {sum.replies ? (
        <>
          <div className={styles.total}>
            <strong>{t('usageTotal')}</strong>
            <strong data-usage-total={String(totalTokens(sum))}>
              {number.format(totalTokens(sum))}
            </strong>
          </div>
          <div className={styles.bars} aria-hidden="true">
            {days.map(([day, counts]) => (
              <span
                key={day}
                style={{ height: `${(Number(totalTokens(counts)) / peak) * 100}%` }}
              />
            ))}
          </div>
          <div className={styles.axis} aria-hidden="true">
            <span>{shortDate.format(days[0][0])}</span>
            <span>{shortDate.format(report.asOf)}</span>
          </div>
          <dl className={styles.breakdown}>
            {categories.map(([label, field]) => (
              <div key={field}>
                <dt>{t(label)}</dt>
                <dd>{number.format(sum[field])}</dd>
              </div>
            ))}
          </dl>
          <p>{t('usageCoverage', { count: number.format(sum.replies) })}</p>
          <details className={styles.daily}>
            <summary tabIndex={0}>{t('usageDaily')}</summary>
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
        <p className={styles.empty} role="status">
          {t('usageEmpty')}
        </p>
      )}
      <p>{t('usageNote')}</p>
      <p>{t('usageUpdated', { time: dateTime.format(report.asOf) })}</p>
    </>
  )
}
