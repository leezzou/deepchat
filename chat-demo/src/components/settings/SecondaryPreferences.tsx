import { useEffect, useId, useState } from 'react'
import { resolveLocale, useTranslate, type TranslationKey } from '../../i18n/index.js'
import { forgetCompaction, listCompactions } from '../../services/chat/compactionIndex.js'
import { clearCompaction, ensureSessionLoaded, useChatStore } from '../../services/chat/store.js'
import { setFontScale, useSettings } from '../../services/settings.js'
import { Button } from '../base/Button.js'
import { IconChevronRightOutline14 } from '../base/icons.js'
import { showToast } from '../base/toastState.js'
import { SettingsEmpty, SettingsSection } from './SecondarySettingsView.js'
import '../library/localSwitch.css'

const levels = [0.85, 0.925, 1, 1.075, 1.15, 1.225, 1.3]
export const fontSizeLabelKeys: TranslationKey[] = [
  'fontSizeSmall',
  'fontSizeSmallMedium',
  'fontSizeStandard',
  'fontSizeMediumLarge',
  'fontSizeLarge',
  'fontSizeLarge2',
  'fontSizeXLarge',
]
export const nearestFontLevel = (scale: number) =>
  levels.reduce(
    (best, value, i) => (Math.abs(value - scale) < Math.abs(levels[best] - scale) ? i : best),
    0
  )

export function MobileFontSizeContent() {
  const t = useTranslate()
  const en = useSettings((s) => resolveLocale(s.locale) === 'en-US')
  const scale = useSettings((s) => s.fontScale)
  const [follow, setFollow] = useState(
    () => localStorage.getItem('chat-demo:font-follow-system') === 'true'
  )
  const level = nearestFontLevel(scale)
  const setSystem = (next: boolean) => {
    setFollow(next)
    localStorage.setItem('chat-demo:font-follow-system', String(next))
    if (next) {
      setFontScale(1)
    }
  }
  return (
    <div className="secondary-page secondary-font">
      <SettingsSection title={en ? 'Chat preview' : '对话预览'}>
        <div className="secondary-font-preview" style={{ fontSize: `${16 * scale}px` }}>
          <p>{t('fontSizePreviewBubble')}</p>
          <p>{t('fontSizePreviewLine1')}</p>
        </div>
      </SettingsSection>
      <SettingsSection>
        <label className="secondary-switch-row">
          <span>{t('fontSizeFollowSystem')}</span>
          <input
            className="dc-local-switch"
            type="checkbox"
            role="switch"
            checked={follow}
            onChange={(e) => setSystem(e.target.checked)}
          />
        </label>
        <div className="secondary-font-scale">
          <label htmlFor="chat-font-range">
            {en ? 'Chat text' : '聊天字号'}
            <span>{t(fontSizeLabelKeys[level])}</span>
          </label>
          <div>
            <span aria-hidden="true">A</span>
            <input
              id="chat-font-range"
              type="range"
              min={0}
              max={levels.length - 1}
              step={1}
              value={level}
              aria-label={t('settingsFontSize')}
              aria-valuetext={t(fontSizeLabelKeys[level])}
              disabled={follow}
              onChange={(e) => setFontScale(levels[Number(e.target.value)])}
            />
            <span aria-hidden="true">A</span>
          </div>
        </div>
      </SettingsSection>
    </div>
  )
}

export function MobileCompactedContent({ onOpenChat }: { onOpenChat: (id: string) => void }) {
  const t = useTranslate()
  const lang = useSettings((s) => resolveLocale(s.locale))
  const en = lang === 'en-US'
  const [records, setRecords] = useState(listCompactions)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [reading, setReading] = useState(false)
  const id = useId()
  const session = useChatStore((s) => (expanded ? s.sessionCache[expanded] : undefined))
  const checkpoint = session?.checkpoint?.text
    .replace(/^[\s\S]*?<compacted-summary>/, '')
    .replace(/<\/compacted-summary>[\s\S]*$/, '')
    .trim()
  useEffect(() => {
    if (!expanded) {
      return
    }
    let current = true
    setReading(true)
    void ensureSessionLoaded(expanded).finally(() => {
      if (current) {
        setReading(false)
      }
    })
    return () => {
      current = false
    }
  }, [expanded])
  const restore = (sessionId: string) => {
    clearCompaction(sessionId)
    const record = useChatStore.getState().sessionCache[sessionId]
    if (!record || record.checkpoint || record.compactedThrough) {
      showToast(
        en ? 'Try again after the current operation finishes.' : '当前操作结束后，请再试一次。'
      )
      return
    }
    forgetCompaction(sessionId)
    setRecords(listCompactions())
    setExpanded(null)
    showToast({ key: 'compactedRestored' })
  }
  return (
    <div className="secondary-page">
      <SettingsSection title={records.length ? (en ? 'Saved summaries' : '对话摘要') : undefined}>
        {!records.length && (
          <SettingsEmpty icon="summaries" title={en ? 'No summaries yet' : '还没有对话摘要'}>
            {t('compactedEmpty')}
          </SettingsEmpty>
        )}
        {records.map((record, index) => (
          <div className="secondary-record" key={record.sessionId}>
            <button
              type="button"
              aria-expanded={expanded === record.sessionId}
              aria-controls={`${id}-${index}`}
              onClick={() => setExpanded(expanded === record.sessionId ? null : record.sessionId)}
            >
              <span>
                <strong>{record.title}</strong>
                <small>
                  {t('compactedMeta', {
                    time: new Date(record.createdAt).toLocaleDateString(lang),
                    count: record.coveredMessages,
                  })}
                </small>
              </span>
              <IconChevronRightOutline14 />
            </button>
            <div
              id={`${id}-${index}`}
              hidden={expanded !== record.sessionId}
              className="secondary-record-body"
            >
              {expanded === record.sessionId && (
                <>
                  <p role="status">
                    {reading && !session
                      ? en
                        ? 'Loading summary…'
                        : '正在读取摘要…'
                      : checkpoint || t('contextSummaryMissing')}
                  </p>
                  <div className="secondary-actions">
                    <Button variant="outlined" onClick={() => onOpenChat(record.sessionId)}>
                      {t('compactedOpen')}
                    </Button>
                    <Button
                      variant="outlined"
                      disabled={!session || reading}
                      onClick={() => restore(record.sessionId)}
                    >
                      {t('compactedRestore')}
                    </Button>
                  </div>
                </>
              )}
            </div>
          </div>
        ))}
      </SettingsSection>
    </div>
  )
}
