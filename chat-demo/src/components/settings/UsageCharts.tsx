import { useMemo, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { usageRanking, usageTimeline } from '../../services/usage/chartData.js'
import type { UsageRow } from '../../services/usage/ledger.js'
import type { summarizeUsage } from '../../services/usage/totals.js'
import styles from './UsageCharts.module.css'

type Counts = ReturnType<typeof summarizeUsage>
type Period = 1 | 7 | 30 | 'all'
type Dimension = 'provider' | 'model'
const directions = ['input', 'output'] as const
const sumReported = (a?: bigint, b?: bigint) =>
  a === undefined && b === undefined ? undefined : (a ?? 0n) + (b ?? 0n)
const fraction = (value: bigint, total: bigint) => (total > 0n ? Number(value) / Number(total) : 0)
function scaleCeiling(max: bigint) {
  if (max <= 1n) {
    return max
  }
  const unit = 10n ** BigInt(String(max).length - 1)
  for (const step of [1n, 2n, 5n, 10n]) {
    if (step * unit >= max) {
      return step * unit
    }
  }
  return max
}
export function usageRouteLabel(
  value: string,
  t: ReturnType<typeof useTranslate>,
  dimension: Dimension
) {
  if (!value || (dimension === 'provider' && value === 'legacy')) {
    return t('usageUnknown')
  }
  return dimension === 'provider' && value === 'DeepSeek account' ? t('usageAccount') : value
}

export function UsageTrend({
  rows,
  counts,
  locale,
  period,
  now,
  emptyHint,
}: {
  rows: UsageRow[]
  counts: Counts
  locale: string
  period: Period
  now: number
  emptyHint: string
}) {
  const t = useTranslate()
  const buckets = useMemo(() => usageTimeline(rows, period, now), [rows, period, now])
  const number = useMemo(() => new Intl.NumberFormat(locale), [locale])
  const compact = useMemo(
    () => new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }),
    [locale]
  )
  const tick = useMemo(
    () =>
      new Intl.DateTimeFormat(
        locale,
        period === 1
          ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }
          : { month: 'short', day: 'numeric' }
      ),
    [locale, period]
  )
  const date = useMemo(
    () =>
      new Intl.DateTimeFormat(
        locale,
        period === 1
          ? {
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
              hourCycle: 'h23',
              timeZoneName: 'short',
            }
          : { dateStyle: 'medium' }
      ),
    [locale, period]
  )
  const peak = scaleCeiling(
    buckets.reduce(
      (max, row) =>
        directions.reduce((m, key) => ((row[key] ?? 0n) > m ? (row[key] ?? 0n) : m), max),
      0n
    )
  )
  const first = buckets[0],
    last = buckets.at(-1)
  const known = counts.input.reported + counts.output.reported > 0
  const total = counts.input.value + counts.output.value
  return (
    <section className={styles.trend} data-usage-trend aria-label={t('usageTrend')}>
      <div className={styles.caption}>
        <h3>{t('usageTrend')}</h3>
        <small>{t('usageRequestsCount', { count: number.format(rows.length) })}</small>
      </div>
      <div className={styles.legend}>
        {directions.map((key) => (
          <span key={key}>
            <i data-swatch={key} aria-hidden="true" />
            {t(key === 'input' ? 'usageInput' : 'usageOutput')}{' '}
            <strong
              data-usage-metric={key}
              data-value={counts[key].reported ? String(counts[key].value) : 'missing'}
            >
              {counts[key].reported ? number.format(counts[key].value) : '—'}
            </strong>
          </span>
        ))}
      </div>
      <div
        className={styles.plot}
        role="img"
        aria-label={t('usageTrendAccessible', {
          input: counts.input.reported ? number.format(counts.input.value) : t('usageMissing'),
          output: counts.output.reported ? number.format(counts.output.value) : t('usageMissing'),
        })}
      >
        <div className={styles.yTicks}>
          <span>{peak > 0n ? compact.format(peak) : ''}</span>
          <span>{peak > 1n && peak % 2n === 0n ? compact.format(peak / 2n) : ''}</span>
          <span>0</span>
        </div>
        <div className={styles.plotArea}>
          <div className={styles.buckets}>
            {buckets.map((row) => (
              <div
                className={styles.bucket}
                data-usage-bucket=""
                data-start={row.start}
                data-end={row.end}
                data-requests={row.requests}
                key={row.start}
              >
                {directions.map((key) => {
                  const value = row[key]
                  return value !== undefined && row.requests > 0 ? (
                    <i
                      key={key}
                      data-usage-series={key}
                      data-value={String(value)}
                      style={{ height: `${fraction(value, peak) * 100}%` }}
                      title={`${tick.format(row.start)} · ${t(key === 'input' ? 'usageInput' : 'usageOutput')} · ${number.format(value)}`}
                    />
                  ) : null
                })}
              </div>
            ))}
          </div>
        </div>
        <div className={styles.xTicks}>
          <span>{first && tick.format(first.start)}</span>
          <span>{last && last.start !== first?.start && tick.format(last.end - 1)}</span>
        </div>
      </div>
      {rows.length ? (
        <div className={styles.trendFooter}>
          <span>{t('usageTotal')}</span>
          <strong data-usage-total={known ? String(total) : 'missing'}>
            {known ? number.format(total) : t('usageMissing')}
          </strong>
        </div>
      ) : (
        <p role="status" className={styles.empty}>
          {emptyHint}
        </p>
      )}
      {rows.length > 0 && !known && <p className={styles.empty}>{t('usageNoCounters')}</p>}
      {rows.length > 0 && (
        <details data-trend-table className={styles.dataTable}>
          <summary>{t('usageTrendValues')}</summary>
          <table>
            <thead>
              <tr>
                <th>{t('usageDate')}</th>
                <th>{t('usageInputShort')}</th>
                <th>{t('usageOutput')}</th>
              </tr>
            </thead>
            <tbody>
              {buckets
                .filter((row) => row.requests)
                .map((row) => (
                  <tr key={row.start}>
                    <th scope="row">
                      {date.format(row.start)}
                      {period !== 1 &&
                        midnightOf(row.start) !== midnightOf(row.end - 1) &&
                        ` – ${date.format(row.end - 1)}`}
                    </th>
                    {directions.map((key) => (
                      <td key={key}>
                        {row[key] === undefined ? t('usageMissing') : number.format(row[key])}
                      </td>
                    ))}
                  </tr>
                ))}
            </tbody>
          </table>
        </details>
      )}
    </section>
  )
}
const midnightOf = (at: number) => new Date(at).setHours(0, 0, 0, 0)

export function UsageRanks({
  dimension,
  rows,
  selected,
  onSelect,
  locale,
}: {
  dimension: Dimension
  rows: UsageRow[]
  selected: string | null
  onSelect: (id: string | null) => void
  locale: string
}) {
  const t = useTranslate()
  const ranks = useMemo(() => usageRanking(rows, dimension), [rows, dimension])
  const number = useMemo(() => new Intl.NumberFormat(locale), [locale])
  const [limit, setLimit] = useState(4)
  const max = ranks.reduce((m, row) => {
    const amount = sumReported(row.input, row.output) ?? 0n
    return amount > m ? amount : m
  }, 0n)
  const visible = ranks.filter((row, index) => index < limit || selected === row.id)
  return (
    <section className={styles.rank} data-rank-group={dimension}>
      <h3>{t(dimension === 'provider' ? 'usageProviderRank' : 'usageModelRank')}</h3>
      <ul>
        {visible.map((row) => {
          const total = sumReported(row.input, row.output)
          return (
            <li key={row.id}>
              <button
                type="button"
                data-usage-rank={dimension}
                data-rank-id={row.id}
                aria-pressed={row.id === selected}
                onClick={() => onSelect(row.id === selected ? null : row.id)}
              >
                <span className={styles.rankName}>{usageRouteLabel(row.id, t, dimension)}</span>
                <span className={styles.rankNumber}>
                  {total === undefined ? t('usageMissing') : number.format(total)}
                </span>
                <span className={styles.rankTrack} aria-hidden="true">
                  {directions.map((key) => (
                    <i
                      key={key}
                      data-swatch={key}
                      style={{ width: `${fraction(row[key] ?? 0n, max) * 100}%` }}
                    />
                  ))}
                </span>
                <small>{t('usageRequestsCount', { count: number.format(row.requests) })}</small>
              </button>
            </li>
          )
        })}
      </ul>
      {limit < ranks.length && (
        <button type="button" className={styles.more} onClick={() => setLimit((n) => n + 10)}>
          {t('usageMoreRanks', { count: Math.min(10, ranks.length - limit) })}
        </button>
      )}
    </section>
  )
}

export function CacheCharts({ counts, locale }: { counts: Counts; locale: string }) {
  const t = useTranslate()
  const number = useMemo(() => new Intl.NumberFormat(locale), [locale])
  const percent = useMemo(
    () => new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }),
    [locale]
  )
  return (
    <section className={styles.cache}>
      <h3>{t('usageCacheChart')}</h3>
      {directions.map((key) => {
        const metric = counts[key === 'input' ? 'inputHit' : 'outputHit']
        const hasRate = metric.base > 0n,
          ratio = fraction(metric.pairedHits, metric.base)
        return (
          <div
            key={key}
            data-cache-chart={key}
            data-rate={hasRate ? Number((ratio * 100).toFixed(1)) : 'missing'}
            data-paired={metric.paired}
            data-base={String(metric.base)}
            data-hits={String(metric.pairedHits)}
          >
            <div className={styles.caption}>
              <span>{t(key === 'input' ? 'usageInputRate' : 'usageOutputRate')}</span>
              <strong>
                {hasRate
                  ? percent.format(ratio)
                  : t(metric.paired ? 'usageNoBase' : 'usageMissing')}
              </strong>
            </div>
            <div className={styles.cacheTrack} data-known={hasRate} aria-hidden="true">
              {hasRate && <i data-swatch={key} style={{ width: `${ratio * 100}%` }} />}
            </div>
            <small>
              {metric.paired > 0 &&
                t('usagePairedTokens', {
                  hits: number.format(metric.pairedHits),
                  base: number.format(metric.base),
                })}{' '}
              {t('usagePairedRequests', {
                known: number.format(metric.paired),
                total: number.format(counts.requests),
              })}
            </small>
          </div>
        )
      })}
    </section>
  )
}
