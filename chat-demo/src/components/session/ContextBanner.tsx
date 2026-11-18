import { useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { exportHistory } from '../../services/chat/backup.js'
import {
  buildCheckpointText,
  MIN_COMPACT_RATIO,
  compactSession,
  contextWindowTokens,
  sessionContextTokens,
  sessionContext,
} from '../../services/chat/compact.js'
import type { Message, Session } from '../../services/chat/types.js'
import {
  cancelCompaction,
  retainContextRounds,
  setContextRoundIncluded,
  updateCheckpointText,
  useChatStore,
} from '../../services/chat/store.js'
import { getVisibleMessages } from '../../services/chat/branches.js'
import { getContextRounds, getReplyText } from '../../services/chat/reply.js'
import { setAutoCompact, useContextPreferences } from '../../services/chat/contextPreferences.js'
import { useSettings } from '../../services/settings.js'
import { usePendingEdit } from '../../services/pendingEdits.js'
import { saveBlob } from '../../shell/saveFile.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import styles from './ContextBanner.module.css'

const RING_SIZE = 30
const RING_RADIUS = 12
const CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

/**
 * 上下文额度圆环（仿 DSH）：显示当前用量百分比，点击打开操作面板。
 * 达到 80% 时提示摘要；在原操作面板内管理逐轮上下文。
 */
export const ContextBanner = ({ session }: { session: Session }) => {
  const t = useTranslate()
  const [requesting, setRequesting] = useState(false)
  const compacting = useChatStore((state) => Boolean(state.compacting[session.id]))
  const busy = useChatStore((state) =>
    Boolean(state.streaming[session.id] || state.compacting[session.id] || state.importingHistory)
  )
  const contextError = useChatStore((state) => state.contextErrors[session.id])
  const autoCompact = useContextPreferences((state) => state.autoCompact)
  const [visibleRounds, setVisibleRounds] = useState(20)
  // API 配置切换后立即重新计算窗口和百分比。
  useSettings((state) => state.apiProfiles)
  useSettings((state) => state.activeProfileId)
  useSettings((state) => state.chatSource)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [summaryOpen, setSummaryOpen] = useState(false)
  const [editingSummary, setEditingSummary] = useState(false)
  usePendingEdit(editingSummary)
  const [summaryDraft, setSummaryDraft] = useState('')
  const [panelOpen, setPanelOpen] = useState(false)
  const [backingUp, setBackingUp] = useState(false)
  const latest = useChatStore((state) => state.sessionCache[session.id]) ?? session

  const path = getVisibleMessages(latest)
  const stableMessages = path.filter(
    (message) =>
      message.role === 'user' || (message.status !== 'streaming' && message.status !== 'pending')
  )
  const budgetCache = useRef<{
    messages: Message[]
    checkpoint: Session['checkpoint']
    through?: string
    excluded?: string[]
    tokens: number
  } | null>(null)
  const cached = budgetCache.current
  if (
    !cached ||
    cached.checkpoint !== latest.checkpoint ||
    cached.through !== latest.compactedThrough ||
    cached.excluded !== latest.excludedContextRoundIds ||
    stableMessages.length !== cached.messages.length ||
    stableMessages.some((message, index) => message !== cached.messages[index])
  ) {
    budgetCache.current = {
      messages: stableMessages,
      checkpoint: latest.checkpoint,
      through: latest.compactedThrough,
      excluded: latest.excludedContextRoundIds,
      tokens: sessionContextTokens(latest, path),
    }
  }
  const tokens = budgetCache.current?.tokens ?? 0
  const pressure = tokens / contextWindowTokens()
  const percent = Math.min(100, Math.round(pressure * 100))
  const warn = pressure >= MIN_COMPACT_RATIO
  // While a reply streams, the ring needs its budget but not the management panel's rounds.
  const rounds = panelOpen ? getContextRounds(path) : []
  const excluded = new Set(panelOpen ? latest.excludedContextRoundIds : [])
  const context = panelOpen ? sessionContext(latest, path) : undefined
  const covered = new Set(
    context?.checkpoint
      ? (latest.checkpoint?.coveredMessageIds ??
          path.slice(0, context.boundary + 1).map((message) => message.id))
      : []
  )
  const can = warn && rounds.some(([user]) => !excluded.has(user.id))
  const stroke = warn ? '#F5A623' : '#426EFE'
  const dash = Math.max(percent, 3)

  const runCompaction = async () => {
    if (requesting || busy) {
      return
    }
    setRequesting(true)
    try {
      const result = await compactSession(latest.id)
      if (result.ok) {
        setConfirmOpen(false)
        setPanelOpen(false)
        showToast({ key: 'contextCompacted', params: { count: result.covered } })
      } else {
        showToast({ key: 'contextCompactFailed', params: { message: result.message.slice(0, 80) } })
      }
    } finally {
      setRequesting(false)
    }
  }

  const backupFirst = async () => {
    if (backingUp) {
      return
    }
    setBackingUp(true)
    try {
      const { name, blob } = await exportHistory()
      const result = await saveBlob(name, blob)
      showToast({
        key: result.status === 'shared' ? 'contextBackupShared' : 'contextBackupRequested',
      })
    } catch {
      showToast({ key: 'historyExportFailed', params: { message: '' } })
    } finally {
      setBackingUp(false)
    }
  }

  const renderSummary = () => {
    const checkpoint = latest.checkpoint
    if (!checkpoint) {
      return null
    }
    const body = checkpoint.text
      .replace(/^[\s\S]*?<compacted-summary>/, '')
      .replace(/<\/compacted-summary>[\s\S]*$/, '')
      .trim()
    const close = () => {
      setSummaryOpen(false)
      setEditingSummary(false)
    }
    return (
      <Modal
        title={t('contextSummaryTitle')}
        className={styles.dialog}
        mainClassName={styles.dialogMain}
        onClose={close}
        footer={
          editingSummary ? (
            <>
              <Button variant="outlined" size="m" onClick={() => setEditingSummary(false)}>
                {t('cancel')}
              </Button>
              <Button
                variant="primary"
                size="m"
                disabled={busy || !summaryDraft.trim()}
                onClick={() => {
                  if (!summaryDraft.trim() || busy) {
                    return
                  }
                  updateCheckpointText(latest.id, buildCheckpointText(summaryDraft))
                  setEditingSummary(false)
                  showToast({ key: 'contextSummarySaved' })
                }}
              >
                {t('save')}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outlined" size="m" onClick={close}>
                {t('close')}
              </Button>
              <Button
                variant="primary"
                size="m"
                disabled={busy}
                onClick={() => {
                  setSummaryDraft(body)
                  setEditingSummary(true)
                }}
              >
                {t('contextSummaryEdit')}
              </Button>
            </>
          )
        }
      >
        <div className={styles.summaryBody}>
          <div className={styles.summaryMeta}>
            {t('contextSummaryMeta', {
              time: new Date(checkpoint.createdAt).toLocaleString(),
              count: checkpoint.coveredMessages,
            })}
          </div>
          {editingSummary ? (
            <>
              <textarea
                className={styles.summaryEditor}
                value={summaryDraft}
                onChange={(event) => setSummaryDraft(event.target.value)}
                spellCheck={false}
                aria-label={t('contextSummaryTitle')}
              />
              <div className={styles.riskNote}>{t('contextSummaryEditHint')}</div>
            </>
          ) : (
            <div className={styles.summaryText}>{body}</div>
          )}
        </div>
      </Modal>
    )
  }

  const renderConfirm = () => (
    <Modal
      title={t('contextRiskTitle')}
      className={styles.dialog}
      mainClassName={styles.dialogMain}
      onClose={() => setConfirmOpen(false)}
      footer={
        <>
          <Button
            variant="outlined"
            size="m"
            onClick={() => {
              if (compacting) {
                cancelCompaction(latest.id)
              }
              setConfirmOpen(false)
            }}
          >
            {t('cancel')}
          </Button>
          <Button
            variant="dangerOutlined"
            size="m"
            disabled={busy || requesting}
            onClick={() => void runCompaction()}
          >
            {compacting ? t('contextCompacting') : t('contextRiskConfirm')}
          </Button>
        </>
      }
    >
      <div className={styles.riskBody}>
        <p className={styles.riskIntro}>{t('contextOriginalsPreserved')}</p>
        <p className={styles.riskNote}>{t('contextSummaryRisk')}</p>
        <button
          type="button"
          className={styles.backupButton}
          disabled={backingUp}
          onClick={() => void backupFirst()}
        >
          {backingUp ? t('contextBackingUp') : t('contextRiskBackup')}
        </button>
      </div>
    </Modal>
  )

  return (
    <>
      <div className={styles.ringRow}>
        {compacting || contextError ? (
          <button type="button" className={styles.statusButton} onClick={() => setPanelOpen(true)}>
            {compacting ? t('contextCompacting') : t('contextManage')}
          </button>
        ) : null}
        <button
          type="button"
          className={styles.ring}
          aria-label={`${t('contextManage')}: ${t('contextUsed', { percent })}`}
          aria-haspopup="dialog"
          onClick={() => setPanelOpen(true)}
        >
          <svg width={RING_SIZE} height={RING_SIZE} viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}>
            <circle
              cx={RING_SIZE / 2}
              cy={RING_SIZE / 2}
              r={RING_RADIUS}
              fill="none"
              stroke="var(--ctx-track, #ededed)"
              strokeWidth={2.4}
            />
            <circle
              cx={RING_SIZE / 2}
              cy={RING_SIZE / 2}
              r={RING_RADIUS}
              fill="none"
              stroke={stroke}
              strokeWidth={2.4}
              strokeLinecap="round"
              strokeDasharray={`${(dash / 100) * CIRCUMFERENCE} ${CIRCUMFERENCE}`}
              transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
            />
          </svg>
          <span className={styles.ringText}>{percent}</span>
        </button>
      </div>
      {panelOpen ? (
        <Modal
          title={t('contextPanelTitle')}
          className={styles.dialog}
          mainClassName={styles.dialogMain}
          onClose={() => setPanelOpen(false)}
          footer={
            <>
              <Button variant="outlined" size="m" onClick={() => setPanelOpen(false)}>
                {t('close')}
              </Button>
              {can ? (
                <Button
                  variant="primary"
                  size="m"
                  disabled={busy}
                  onClick={() => {
                    setPanelOpen(false)
                    setConfirmOpen(true)
                  }}
                >
                  {t('contextCompact')}
                </Button>
              ) : null}
            </>
          }
        >
          <div className={styles.panelBody}>
            <p className={styles.panelPercent}>{t('contextUsed', { percent })}</p>
            <p className={styles.panelHint}>
              {t('contextEstimateHint', {
                tokens: tokens.toLocaleString(),
                window: contextWindowTokens().toLocaleString(),
              })}
            </p>
            <div className={styles.presets}>
              <Button
                variant="outlined"
                size="m"
                disabled={busy}
                onClick={() => retainContextRounds(latest.id, 5)}
              >
                {t('contextRecentFive')}
              </Button>
              <Button
                variant="outlined"
                size="m"
                disabled={busy}
                onClick={() => retainContextRounds(latest.id, 10)}
              >
                {t('contextRecentTen')}
              </Button>
              <Button
                variant="outlined"
                size="m"
                disabled={busy}
                onClick={() => retainContextRounds(latest.id, 'all')}
              >
                {t('contextRestoreAll')}
              </Button>
            </div>
            <label className={styles.autoRow}>
              <input
                type="checkbox"
                checked={autoCompact}
                disabled={busy}
                onChange={(event) => setAutoCompact(event.target.checked)}
              />
              <span>{t('contextAutoSummary')}</span>
            </label>
            <p className={styles.panelHint}>{t('contextAutoSummaryHint')}</p>
            <p className={styles.panelHint}>{t('contextOriginalsPreserved')}</p>
            {busy ? (
              <p role="status" className={styles.panelHint}>
                {compacting ? t('contextCompacting') : t('contextControlsBusy')}
              </p>
            ) : null}
            {compacting ? (
              <Button variant="outlined" size="m" onClick={() => cancelCompaction(latest.id)}>
                {t('cancel')}
              </Button>
            ) : null}
            {contextError ? (
              <p role="status" className={styles.error}>
                {t('contextAutoFailed', { message: contextError })}
              </p>
            ) : null}
            {latest.checkpoint && !context?.checkpoint ? (
              <p className={styles.panelHint}>{t('contextSummaryInactive')}</p>
            ) : null}
            {latest.checkpoint ? (
              <button
                type="button"
                className={styles.backupButton}
                onClick={() => {
                  setPanelOpen(false)
                  setSummaryOpen(true)
                }}
              >
                {t('contextSummaryView')}
              </button>
            ) : null}
            <p className={styles.selectionCount}>
              {t('contextSelectionCount', {
                count: rounds.filter(([user]) => !excluded.has(user.id)).length,
                total: rounds.length,
              })}
            </p>
            <p className={styles.panelHint}>{t('contextSelectionHint')}</p>
            <div className={styles.rounds}>
              {rounds.length === 0 ? (
                <p className={styles.panelHint}>{t('contextNoRounds')}</p>
              ) : null}
              {rounds
                .map((round, index) => ({ round, index }))
                .slice(-visibleRounds)
                .reverse()
                .map(({ round: [user, reply], index }) => (
                  <div key={user.id} className={styles.round}>
                    <label className={styles.roundLabel}>
                      <input
                        type="checkbox"
                        disabled={busy}
                        checked={!excluded.has(user.id)}
                        onChange={(event) =>
                          setContextRoundIncluded(latest.id, user.id, event.target.checked)
                        }
                      />
                      <span className={styles.roundContent}>
                        <span className={styles.roundMeta}>
                          {t('contextRoundLabel', { number: index + 1 })} ·{' '}
                          {t(
                            excluded.has(user.id)
                              ? 'contextRoundExcluded'
                              : covered.has(user.id)
                                ? 'contextRoundSummarized'
                                : 'contextRoundIncluded'
                          )}
                        </span>
                        <span className={styles.roundPreview}>
                          {user.content ||
                            t('contextRoundFiles', {
                              names: user.files.map((file) => file.name).join(', '),
                            })}
                        </span>
                      </span>
                    </label>
                    <details className={styles.original}>
                      <summary>{t('contextOriginals')}</summary>
                      <div className={styles.originalText}>{user.content}</div>
                      {user.files.length ? (
                        <div className={styles.originalText}>
                          {t('contextRoundFiles', {
                            names: user.files.map((file) => file.name).join(', '),
                          })}
                        </div>
                      ) : null}
                      <div className={styles.originalText}>{getReplyText(reply)}</div>
                    </details>
                  </div>
                ))}
            </div>
            {rounds.length > visibleRounds ? (
              <Button
                variant="outlined"
                size="m"
                onClick={() => setVisibleRounds((count) => count + 20)}
              >
                {t('contextMoreRounds')}
              </Button>
            ) : null}
          </div>
        </Modal>
      ) : null}
      {confirmOpen ? renderConfirm() : null}
      {summaryOpen ? renderSummary() : null}
    </>
  )
}
