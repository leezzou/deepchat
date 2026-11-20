import { ContextModelSettings } from './ContextModelSettings.js'
import { HelpDialog } from './HelpDialog.js'
import clsx from 'clsx'
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  IconCheckOutline16,
  IconChevronRightOutline14,
  IconRightUpOutline14,
  IconUploadOutline14,
} from '../base/icons.js'
import {
  SnapshotError,
  clearHistory,
  useBackupState,
} from '../../services/chat/backup.js'
import { PostCommitRecoveryError } from '../../services/backup/portableMetadata.js'
import { useIsSettingsMobile } from '../../app/viewport.js'
import { useChatStore } from '../../services/chat/store.js'
import { regionCodes, getRegionName, provinces } from '../../services/location.js'
import {
  createApiProfile,
  isChineseBrowser,
  setAutoCollapseThinking,
  setLocale,
  setLocation,
  setThemePreference,
  setTtsVoice,
  useSettings,
  type ApiProfile,
  type ThemePreference,
} from '../../services/settings.js'
import { useUpdateNotice } from '../../services/updateWatcher.js'
import { SettingsUpdate } from './SettingsUpdate.js'
import { ApiProfileList, ApiKeyGuide, ApiProfileForm, DesktopApiProfiles } from './ApiProfileSettings.js'
import { MobileCompactedContent, MobileFontSizeContent, fontSizeLabelKeys, nearestFontLevel } from './SecondaryPreferences.js'
import { AccountSettings } from './AccountSettings.js'
import {
  resolveLocale,
  useTranslate,
  type TranslationKey,
  type TranslationMessage,
} from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { ConfirmationModal, Modal, ModalPresence } from '../base/Modal.js'
import { Select } from '../base/Select.js'
import { showToast } from '../base/toastState.js'
import { syncLockAppearance } from '../../services/security/bridge.js'
import { SecuritySettings } from './SecuritySettings.js'
import { SettingsIcon, type SettingsIconName } from './SettingsIcon.js'
import { WebDavSettings } from './WebDavSettings.js'
import { MemorySettings } from '../library/MemorySettings.js'
import { openApiUsage } from './ApiUsage.js'
import { MobileSettingsHeader as MobileHeader } from './MobileSettingsHeader.js'
import { useRouteBack, useRouteMotion } from './routeMotion.js'
import { selectSession } from '../../services/chat/store.js'
import { DataSettings, type MobileDataProps } from './DataSettings.js'
import { HistoryImportFeedback, useHistoryImport } from './HistoryImportFeedback.js'
import { closeSettings, coverSettings, finishSettingsExit, useSettingsDialog, type SettingsSection, type SettingsVisit } from './settingsDialogState.js'
import { captureChatOrigin, rememberChat } from '../sider/mobileSiderState.js'
import { useUpdateSafety } from '../../services/updateSafety.js'
import { WorkBuddyAccountPage } from './WorkBuddyAccountPage.js'
import stellaArtwork from '../../assets/voices/stella.webp'
import tideArtwork from '../../assets/voices/tide.webp'
import '../library/localSwitch.css'
import styles from './Settings.module.css'

/**
 * 设置：桌面端为居中弹窗、左侧导航；移动端为覆盖整个视口的整页（顶栏返回 + 分组卡片 + 二级页）。
 */
export const SettingsDialog = () => {
  const visits = useSettingsDialog((state) => state.visits)
  const isSettingsMobile = useIsSettingsMobile()
  const theme = useSettings((state) => state.themePreference)
  const locale = useSettings((state) => state.locale)
  useEffect(() => syncLockAppearance(theme, locale), [theme, locale, visits.length])
  const historyImport = useHistoryImport()
  return <>{visits.map((visit) => (
    <SettingsVisitView key={visit.id} visit={visit} mobile={isSettingsMobile} historyImport={historyImport} />
  ))}</>
}

const SettingsVisitView = ({ visit, mobile, historyImport }: ImportProps & { visit: SettingsVisit; mobile: boolean }) => {
  // Resizing with a child open must not replace the page stack the user will return to.
  const mobileAtEntry = useRef(mobile).current
  if (mobileAtEntry) return <MobileSettings visit={visit} historyImport={historyImport} />
  return (
    <ModalPresence onExited={() => finishSettingsExit(visit.id)}>
      {visit.status === 'open' && <SettingsContent initialSection={visit.section} historyImport={historyImport} />}
    </ModalPresence>
  )
}

type DesktopSection = SettingsSection | 'about'
const sections: { value: DesktopSection; label: TranslationKey; icon: SettingsIconName; startGroup?: boolean }[] = [
  { value: 'general', label: 'settingsAppGroup', icon: 'appearance' },
  { value: 'account', label: 'settingsAccountGroup', icon: 'account' },
  { value: 'apiKey', label: 'settingsModelsGroup', icon: 'key', startGroup: true },
  { value: 'contextModels', label: 'modelContextTitle', icon: 'source' },
  { value: 'data', label: 'settingDialogAsideDataOptionLabel', icon: 'data', startGroup: true },
  { value: 'memory', label: 'libMemory', icon: 'memory' },
  { value: 'security', label: 'previewSecurity', icon: 'lock' },
  { value: 'webdav', label: 'previewWebDav', icon: 'cloud' },
  { value: 'about', label: 'settingsAboutGroup', icon: 'help', startGroup: true },
]

type ImportProps = { historyImport: ReturnType<typeof useHistoryImport> }

const SettingsContent = ({ historyImport, initialSection }: ImportProps & { initialSection: SettingsSection }) => {
  const t = useTranslate()
  const [section, setSection] = useState<DesktopSection>(() =>
    initialSection === 'general' && useUpdateSafety.getState().resumePanel ? 'about' : initialSection
  )
  const tabId = useId()
  const [helpOpen, setHelpOpen] = useState(false)
  const [workBuddyOpen, setWorkBuddyOpen] = useState(false)
  const version = useUpdateNotice((state) => state.version)
  const historyDelete = useHistoryDelete()
  const replacingHistory = useChatStore((state) => state.importingHistory)
  const backupBusy = useBackupState((state) => state.operation !== null)
  const historyBusy = historyImport.busy || historyDelete.busy || replacingHistory || backupBusy
  return (
    <>
      <Modal
        title={t('settings')}
        closable
        className={styles.dialog}
        mainClassName={styles.dialogMain}
        onClose={() => {
          if (!historyDelete.busy) {
            closeSettings()
          }
        }}
      >
        <div role="tablist" aria-label={t('settings')} aria-orientation="vertical" className={styles.navigation}
          onKeyDown={(event) => {
            const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
            const index = tabs.indexOf(event.target as HTMLButtonElement)
            if (index < 0) {
              return
            }
            const next = { ArrowDown: (index + 1) % tabs.length, ArrowUp: (index + tabs.length - 1) % tabs.length,
              Home: 0, End: tabs.length - 1 }[event.key]
            if (next === undefined) {
              return
            }
            event.preventDefault()
            tabs[next].focus()
            tabs[next].click()
          }}>
          {sections.map((item) => (
            <button
              key={item.value}
              type="button"
              role="tab"
              id={`${tabId}-${item.value}`}
              aria-controls={`${tabId}-panel`}
              tabIndex={section === item.value ? 0 : -1}
              data-settings-tab={item.value}
              data-group-start={item.startGroup || undefined}
              data-context-settings-entry={item.value === 'contextModels' || undefined}
              aria-selected={section === item.value}
              className={clsx(styles.navItem, section === item.value && styles.navItemActive)}
              onClick={() => setSection(item.value)}
            >
              <SettingsIcon name={item.icon} compact />
              {t(item.label)}
            </button>
          ))}
        </div>
        <div role="tabpanel" data-settings-panel={section} id={`${tabId}-panel`} aria-labelledby={`${tabId}-${section}`} className={styles.content} key={section}>
          {section === 'contextModels' ? <ContextModelSettings /> : section === 'security' ? <SecuritySettings /> : section === 'memory' ? <MemorySettings /> : section === 'webdav' ? <WebDavSettings /> : section === 'general' ? (
            <>
              <ThemeSetting />
              <LocaleSetting />
              <LocationSetting />
              <ThinkingCollapseSetting />
              <TtsVoiceSetting />
            </>
          ) : section === 'account' ? (
            <AccountSettings onWorkBuddy={() => setWorkBuddyOpen(true)} />
          ) : section === 'about' ? (
            <>
              {version && <SettingsUpdate />}
              <SettingCell label={t('settingsHelp')} status={null} action={
                <Button variant="outlined" onClick={() => setHelpOpen(true)}>{t('settingsOpenHelp')}</Button>
              } />
            </>
          ) : section === 'apiKey' ? (
            <DesktopApiProfiles />
          ) : (
            <>
              <ImportHistory historyImport={historyImport} disabled={historyBusy} />
              <ExportHistory disabled={historyBusy} />
              <section className={styles.dangerGroup} data-settings-group="danger">
                <h2>{t('settingsClearGroup')}</h2>
                <SettingCell label={t('deleteAllHistory')} description={t('settingsClearHint')} status={null} action={
                  <Button variant="dangerOutlined" size="m" disabled={historyBusy} onClick={historyDelete.open}>
                    {t('delete')}
                  </Button>
                } />
              </section>
            </>
          )}
          {version && <div className={styles.versionFooter} data-app-version>{t('settingsVersion', { version })}</div>}
        </div>
      </Modal>
      <HelpDialog open={helpOpen} onClose={() => setHelpOpen(false)} />
      <ModalPresence>{workBuddyOpen && (
        <Modal title={t('workBuddyAccount')} closable className={styles.walletDialog} onClose={() => setWorkBuddyOpen(false)}>
          <WorkBuddyAccountPage />
        </Modal>
      )}</ModalPresence>
      <ModalPresence>{historyImport.file ? <ImportConfirm historyImport={historyImport} /> : null}</ModalPresence>
      <ModalPresence>{historyDelete.opened ? <DeleteAllConfirm historyDelete={historyDelete} /> : null}</ModalPresence>
    </>
  )
}

/** 移动端二级页：设置根页与各二级页 */
type MobilePage =
  | 'root'
  | 'apiKey'
  | 'guide'
  | 'data'
  | 'compacted'
  | 'memory'
  | 'security'
  | 'webdav'
  | 'fontSize'
  | 'location'
  | 'workbuddyAccount'
  | 'contextModels'

/** 二级页标题（根页统一用「设置」） */
const mobilePageTitles: Record<MobilePage, TranslationKey> = {
  contextModels: 'modelContextTitle', root: 'settings', apiKey: 'settingsKeysTitle', guide: 'apiGuideEntry', data: 'settingDialogAsideDataOptionLabel',
  compacted: 'compactedEntry', security: 'previewSecurity', webdav: 'previewWebDav', memory: 'libMemory',
  fontSize: 'settingsFontSize',
  location: 'settingsLocation', workbuddyAccount: 'workBuddyAccount',
}

const themeLabelKeys: Record<ThemePreference, TranslationKey> = {
  system: 'avatarMenuSettingsDialogThemeSelectSystemOption',
  light: 'avatarMenuSettingsDialogThemeSelectLightOption',
  dark: 'avatarMenuSettingsDialogThemeSelectDarkOption',
}

type Route = {
  page: MobilePage | 'apiEdit'
  editor?: { profile: ApiProfile; isNew: boolean }
  opener?: HTMLElement
  animateEntry?: boolean
}

// A direct link has exactly one entry. Only a real tap inside Settings pushes a parent.
const entryPage = (section: SettingsSection): MobilePage => {
  if (section === 'general' || section === 'account') {
    return 'root'
  }
  return section
}

/** Each route owns its scroll container and stays mounted until its pop has finished. */
const RoutePage = ({ route, position, active, title, onBack, onExited, children }: {
  route: Route; position: 'front' | 'covered' | 'leaving'; active: boolean; title: string
  onBack: () => void; onExited: () => void; children: ReactNode
}) => {
  const ref = useRouteMotion<HTMLDivElement>(!!route.animateEntry, position === 'leaving', onExited)
  return (
    <div ref={ref} tabIndex={-1} className={styles.subPage} data-settings-route={route.page}
      data-route-position={position} {...(active ? {} : { inert: '' })}>
      <MobileHeader title={title} onBack={onBack} />
      <div className={styles.body}>{children}</div>
    </div>
  )
}

const MobileSettings = ({ historyImport, visit }: ImportProps & { visit: SettingsVisit }) => {
  const open = visit.status === 'open'
  const covered = visit.status === 'covered'
  const t = useTranslate()
  const historyDelete = useHistoryDelete()
  const replacingHistory = useChatStore((state) => state.importingHistory)
  const backupBusy = useBackupState((state) => state.operation !== null)
  const historyBusy = historyImport.busy || historyDelete.busy || replacingHistory || backupBusy
  const [routes, setRoutes] = useState<Route[]>(() => [{ page: entryPage(visit.section) }])
  const [popping, setPopping] = useState(false)
  const currentRoute = useRef(routes.at(-1))
  currentRoute.current = routes.at(-1)
  const closing = useRef(false)
  const restoreFocus = useRef<HTMLElement | undefined>(undefined)
  const shell = useRouteMotion<HTMLDivElement>(true, visit.status === 'closing', () => finishSettingsExit(visit.id))
  const caller = useRef(document.activeElement)
  useLayoutEffect(() => {
    if (covered) return
    const app = document.getElementById('root')
    const wasInert = app?.inert ?? false
    const previous = caller.current
    if (app) app.inert = true
    return () => {
      if (app) app.inert = wasInert
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true })
    }
  }, [covered])
  useLayoutEffect(() => {
    if (covered) return
    const page = shell.current?.lastElementChild
    const trigger = restoreFocus.current
    restoreFocus.current = undefined
    if (trigger?.isConnected && page?.contains(trigger)) trigger.focus({ preventScroll: true })
    else if (page instanceof HTMLElement) page.focus({ preventScroll: true })
  }, [routes, shell, covered])

  const push = (page: Route['page'], editor?: Route['editor']) => {
    if (!open || closing.current || routes.at(-1)?.page === page) return
    const focus = document.activeElement
    setRoutes([...routes, { page, editor, animateEntry: true, opener: focus instanceof HTMLElement ? focus : undefined }])
  }
  const edit = (profile: ApiProfile | 'new') => push('apiEdit', {
    isNew: profile === 'new', profile: profile === 'new' ? createApiProfile() : profile,
  })
  const goBack = () => {
    if (closing.current || !open || historyDelete.busy) return
    if (routes.length === 1) { closeSettings(); return }
    closing.current = true
    setPopping(true)
  }
  useRouteBack(goBack, !covered)
  const finishPop = () => {
    restoreFocus.current = routes.at(-1)?.opener
    closing.current = false
    setPopping(false)
    setRoutes(routes.slice(0, -1))
  }

  return createPortal(
    <div hidden={covered} className={styles.routeViewport} role="dialog" aria-modal="true" aria-label={t('settings')}>
      <div ref={shell} className={styles.page} data-settings-shell="" data-route-position={open ? 'front' : 'leaving'} data-popping={popping || undefined}>
        {routes.map((route, index) => {
          const { page, editor } = route
          const top = index === routes.length - 1
          const position = top && popping ? 'leaving' : index === routes.length - (popping ? 2 : 1) ? 'front' : 'covered'
          const title = page === 'apiEdit' ? t(editor?.isNew ? 'apiProfileAdd' : 'apiProfileEdit') : t(mobilePageTitles[page])
          return (
            <RoutePage key={page} route={route} position={position} active={top && open && !popping}
              title={title} onBack={goBack} onExited={finishPop}>
              {page === 'root' && <MobileRootContent onOpenPage={push} />}
              {page === 'apiKey' && <ApiProfileList onOpenGuide={() => push('guide')} onEdit={edit} />}
              {page === 'apiEdit' && editor && <ApiProfileForm {...editor} onDone={() => {
                if (currentRoute.current === route) goBack()
              }} />}
              {page === 'guide' && <ApiKeyGuide onFillKey={() => edit('new')} />}
              {page === 'data' && <MobileDataContent historyImport={historyImport} disabled={historyBusy}
                onOpenWebDav={() => push('webdav')} onOpenCompacted={() => push('compacted')} onDeleteAll={historyDelete.open} />}
              {page === 'security' && <SecuritySettings />}
              {page === 'webdav' && <WebDavSettings />}
              {page === 'memory' && <MemorySettings />}
              {page === 'compacted' && <MobileCompactedContent onOpenChat={(sessionId) => {
                const { sessions, importingHistory } = useChatStore.getState()
                if (importingHistory || !sessions.some((session) => session.id === sessionId)) return
                const trigger = document.activeElement
                if (trigger instanceof HTMLElement) restoreFocus.current = trigger
                rememberChat({ ...captureChatOrigin(), resume: coverSettings(visit.id) })
                selectSession(sessionId)
              }} />}
              {page === 'contextModels' && <ContextModelSettings />}
              {page === 'workbuddyAccount' && <WorkBuddyAccountPage />}
              {page === 'fontSize' && <MobileFontSizeContent />}
              {page === 'location' && <MobileLocationContent />}
            </RoutePage>
          )
        })}
      </div>
      <ModalPresence>{open && historyImport.file ? <ImportConfirm historyImport={historyImport} /> : null}</ModalPresence>
      <ModalPresence>{open && historyDelete.opened ? <DeleteAllConfirm historyDelete={historyDelete} /> : null}</ModalPresence>
    </div>, document.body
  )
}

/** 分组：标题 + 单独一张圆角卡片 */
const MobileGroup = ({ title, group, children }: {
  title?: string
  group?: string
  children: ReactNode
}) => {
  const id = useId()
  return (
    <section className={styles.group} data-settings-group={group} aria-labelledby={title ? id : undefined}>
      {title && <h2 id={id} className={styles.groupTitle}>{title}</h2>}
      <div className={styles.card}>{children}</div>
    </section>
  )
}

const MobileRow = ({
  icon,
  label,
  value,
  onClick,
  disabled = false,
  external = false,
  ...attributes
}: {
  icon: ReactNode
  label: string
  value?: string
  onClick: () => void
  disabled?: boolean
  external?: boolean
  'data-usage-home-entry'?: boolean
  'data-api-usage-entry'?: boolean
  'data-wb-account-entry'?: boolean
  'data-context-settings-entry'?: boolean
}) => (
  <button {...attributes} type="button" className={styles.row} disabled={disabled} onClick={onClick}>
    <span className={styles.rowIcon} aria-hidden="true">{icon}</span>
    <span className={styles.rowLabel}>{label}</span>
    {value ? <span className={styles.rowValue}>{value}</span> : null}
    <span className={styles.rowChevron} aria-hidden="true">
      {external ? <IconRightUpOutline14 /> : <IconChevronRightOutline14 />}
    </span>
  </button>
)

/** 整行可点的选择器：行内展示当前值，透明的选择器触发器铺满整行 */
const MobileSelectRow = ({
  icon,
  label,
  value,
  muted = false,
  children,
}: {
  icon: ReactNode
  label: string
  value: string
  muted?: boolean
  children: ReactNode
}) => (
  <div className={clsx(styles.row, muted && styles.rowMuted)}>
    <span className={styles.rowIcon} aria-hidden="true">{icon}</span>
    <span className={styles.rowLabel}>{label}</span>
    <span className={styles.rowValue}>{value}</span>
    <span className={styles.rowChevron}>
      <IconChevronRightOutline14 />
    </span>
    {children}
  </div>
)

const MobileRootContent = ({ onOpenPage }: { onOpenPage: (page: MobilePage) => void }) => {
  const t = useTranslate()
  const apiKey = useSettings((state) => state.apiKey)
  const location = useSettings((state) => state.location)
  const locale = useSettings((state) => state.locale)
  const ttsVoice = useSettings((state) => state.ttsVoice)
  const fontScale = useSettings((state) => state.fontScale)
  const [helpOpen, setHelpOpen] = useState(false)
  const [voiceOpen, setVoiceOpen] = useState(false)
  const version = useUpdateNotice((state) => state.version)
  return (
    <>
      <MobileGroup group="account" title={t('settingsAccountGroup')}>
        <AccountSettings onWorkBuddy={() => onOpenPage('workbuddyAccount')} />
      </MobileGroup>
      <MobileGroup group="preferences" title={t('settingsAppGroup')}>
        <ThemeSetting />
        <MobileSelectRow
          icon={<SettingsIcon name="language" />}
          label={t('settingsLocalePreference')}
          value={
            locale === 'system'
              ? t('settingsLocaleSystem')
              : locale === 'zh-CN'
                ? t('settingsLocaleZhCN')
                : t('settingsLocaleEnUS')
          }
        >
          <Select
            className={styles.selectHit}
            ariaLabel={t('settingsLocalePreference')}
            value={locale}
            options={[
              { value: 'system', label: t('settingsLocaleSystem') },
              { value: 'zh-CN', label: t('settingsLocaleZhCN'), lang: 'zh-CN' },
              { value: 'en-US', label: t('settingsLocaleEnUS'), lang: 'en' },
            ]}
            onChange={setLocale}
          />
        </MobileSelectRow>
        <MobileRow
          icon={<SettingsIcon name="fontSize" />}
          label={t('settingsFontSize')}
          value={t(fontSizeLabelKeys[nearestFontLevel(fontScale)])}
          onClick={() => onOpenPage('fontSize')}
        />
        <MobileRow icon={<SettingsIcon name="location" />} label={t('settingsLocation')}
          value={location ? getRegionName(location.region, resolveLocale(locale)) : t('settingsNotSet')}
          onClick={() => onOpenPage('location')} />
        <ThinkingCollapseSetting mobile />
        <MobileRow
          icon={<SettingsIcon name="voice" />}
          label={t('settingsTtsVoice')}
          value={t(ttsVoice === 'stella' ? 'settingsTtsVoiceStella' : 'settingsTtsVoiceTide')}
          onClick={() => setVoiceOpen(true)}
        />
      </MobileGroup>
      <MobileGroup group="models" title={t('settingsModelsGroup')}>
        <MobileRow data-usage-home-entry icon={<SettingsIcon name="usage" />} label={t('usageTitle')} onClick={openApiUsage} />
        <MobileRow data-context-settings-entry icon={<SettingsIcon name="source" />} label={t('modelContextTitle')} onClick={() => onOpenPage('contextModels')} />
        <MobileRow
          icon={<SettingsIcon name="key" />}
          label={t('settingsKeysTitle')}
          value={t(apiKey ? 'settingsConfigured' : 'settingsNotSet')}
          onClick={() => onOpenPage('apiKey')}
        />
      </MobileGroup>
      <MobileGroup group="privacy" title={t('settingsPrivacyGroup')}>
        <MobileRow
          icon={<SettingsIcon name="data" />}
          label={t('settingDialogAsideDataOptionLabel')}
          onClick={() => onOpenPage('data')}
        />
        <MobileRow icon={<SettingsIcon name="lock" />} label={t('previewSecurity')} onClick={() => onOpenPage('security')} />
        <MobileRow icon={<SettingsIcon name="memory" />} label={t('libMemory')} onClick={() => onOpenPage('memory')} />
      </MobileGroup>
      <MobileGroup group="about" title={t('settingsAboutGroup')}>
        {version && <SettingsUpdate mobile />}
        <MobileRow icon={<SettingsIcon name="help" />} label={t('settingsHelp')} onClick={() => setHelpOpen(true)} />
      </MobileGroup>
      {version && <div className={styles.meta} data-app-version>{t('settingsVersion', { version })}</div>}
      <ModalPresence>{voiceOpen ? (
        <Modal
          title={t('settingsTtsVoice')}
          closable
          placement="bottom"
          className={styles.voiceDialog}
          onClose={() => setVoiceOpen(false)}
          footer={
            <Button
              variant="primary"
              size="m"
              className={styles.voiceConfirm}
              onClick={() => setVoiceOpen(false)}
            >
              {t('confirm')}
            </Button>
          }
        >
          <div className={styles.voiceGrid}>
            {[
              {
                id: 'stella' as const,
                name: t('voiceStellaName'),
                tagline: t('voiceStellaTagline'),
                artwork: stellaArtwork,
              },
              {
                id: 'tide' as const,
                name: t('voiceTideName'),
                tagline: t('voiceTideTagline'),
                artwork: tideArtwork,
              },
            ].map((voice) => (
              <button
                key={voice.id}
                type="button"
                aria-pressed={ttsVoice === voice.id}
                className={clsx(
                  styles.voiceCard,
                  ttsVoice === voice.id && styles.voiceCardActive
                )}
                onClick={() => setTtsVoice(voice.id)}
              >
                <img className={styles.voiceArtwork} src={voice.artwork} alt="" width="144" height="144" />
                <span className={styles.voiceName}>{voice.name}</span>
                <span className={styles.voiceTagline}>{voice.tagline}</span>
                <span className={styles.voiceCheck} aria-hidden="true">
                  {ttsVoice === voice.id ? <IconCheckOutline16 /> : null}
                </span>
              </button>
            ))}
          </div>
        </Modal>
      ) : null}</ModalPresence>
      <HelpDialog open={helpOpen} onClose={() => setHelpOpen(false)} mobile />
    </>
  )
}

const MobileDataContent = ({ disabled, ...mobile }: MobileDataProps & { disabled: boolean }) => (
  <DataSettings disabled={disabled} mobile={mobile} />
)

const ThinkingCollapseSetting = ({ mobile = false }: { mobile?: boolean }) => {
  const t = useTranslate()
  const checked = useSettings((state) => state.autoCollapseThinking)
  const id = useId()
  return (
    <label className={clsx(styles.collapseSetting, mobile ? styles.row : styles.cell)}>
      {mobile && <span className={styles.rowIcon}><SettingsIcon name="personalize" /></span>}
      <span className={styles.collapseText}>
        <span id={`${id}-label`}>{t('personalizeCollapseThinking')}</span>
        <span id={`${id}-hint`}>{t('personalizeCollapseHint')}</span>
      </span>
      <input data-collapse-thinking type="checkbox" role="switch" className="dc-local-switch"
        aria-labelledby={`${id}-label`} aria-describedby={`${id}-hint`} checked={checked}
        onChange={event => setAutoCollapseThinking(event.target.checked)} />
    </label>
  )
}

/** 位置信息：国内按省份 / 城市两级，其他地区只选国家或地区 */
const MobileLocationContent = () => {
  const t = useTranslate()
  const locale = resolveLocale(useSettings((state) => state.locale))
  const location = useSettings((state) => state.location)
  const province =
    location?.region === 'CN'
      ? provinces.find((item) => item.code === location.province)
      : undefined
  const city = province?.cities.find((item) => item.code === location?.city)
  if (isChineseBrowser()) {
    return (
      <MobileGroup>
        <MobileSelectRow icon={<SettingsIcon name="province" />} label={t('settingsLocationProvince')} value={province?.name ?? t('settingsNotSet')}>
          <Select
            className={styles.selectHit}
            ariaLabel={t('settingsLocationProvince')}
            value={province?.code ?? ''}
            placeholder={t('settingsLocationProvince')}
            options={provinces.map((item) => ({ value: item.code, label: item.name }))}
            onChange={(value) => {
              if (value !== province?.code) {
                setLocation({ region: 'CN', province: value })
              }
            }}
          />
        </MobileSelectRow>
        <MobileSelectRow
          icon={<SettingsIcon name="city" />}
          label={t('settingsLocationCity')}
          value={city?.name ?? t('settingsNotSet')}
          muted={!province?.cities.length}
        >
          <Select
            className={styles.selectHit}
            ariaLabel={t('settingsLocationCity')}
            value={city?.code ?? ''}
            disabled={!province?.cities.length}
            placeholder={t('settingsLocationCity')}
            options={province?.cities.map((item) => ({ value: item.code, label: item.name })) ?? []}
            onChange={(value) => {
              if (province) {
                setLocation({ region: 'CN', province: province.code, city: value })
              }
            }}
          />
        </MobileSelectRow>
      </MobileGroup>
    )
  }
  return (
    <MobileGroup>
      <MobileSelectRow
        icon={<SettingsIcon name="language" />}
        label={t('settingsLocationRegion')}
        value={location ? getRegionName(location.region, locale) : t('settingsNotSet')}
      >
        <Select
          className={styles.selectHit}
          ariaLabel={t('settingsLocationRegion')}
          value={location?.region ?? ''}
          placeholder={t('settingsLocationRegion')}
          options={regionCodes
            .map((code) => ({ value: code, label: getRegionName(code, locale) }))
            .sort((a, b) => a.label.localeCompare(b.label, locale))}
          onChange={(value) => setLocation({ region: value })}
        />
      </MobileSelectRow>
    </MobileGroup>
  )
}

/** 删除确认保留在设置之上；失败可重试，成功只关闭确认弹窗。 */
const DeleteAllConfirm = ({
  historyDelete,
}: {
  historyDelete: ReturnType<typeof useHistoryDelete>
}) => {
  const t = useTranslate()
  return (
    <ConfirmationModal
      title={t('backupClearTitle')}
      onClose={historyDelete.cancel}
      footer={
        <>
          <Button
            variant="outlined"
            autoFocus
            disabled={historyDelete.busy}
            onClick={historyDelete.cancel}
          >
            {t('cancel')}
          </Button>
          <Button
            variant="danger"
            disabled={historyDelete.busy}
            onClick={() => void historyDelete.confirm()}
          >
            {t(historyDelete.busy ? 'historyDeleting' : 'deleteAllSessions')}
          </Button>
        </>
      }
    >
      {t('backupClearSafety')}
    </ConfirmationModal>
  )
}

const useHistoryDelete = () => {
  const [opened, setOpened] = useState(false)
  const [busy, setBusy] = useState(false)
  const deleting = useRef(false)

  const confirm = async () => {
    if (deleting.current) {
      return
    }
    deleting.current = true
    setBusy(true)
    try {
      await clearHistory()
      setOpened(false)
      showToast({ key: 'historyDeleted' })
    } catch (error) {
      if (error instanceof PostCommitRecoveryError) {
        setOpened(false)
        showToast({ key: 'historyRecoveryPending' })
      } else {
        showToast({ key: error instanceof SnapshotError ? 'backupSnapshotFailed' : 'historyDeleteFailed', type: 'error' })
      }
    } finally {
      deleting.current = false
      setBusy(false)
    }
  }

  return {
    opened,
    busy,
    open: () => setOpened(true),
    cancel: () => {
      if (!deleting.current) {
        setOpened(false)
      }
    },
    confirm,
  }
}

const LocationSetting = () => {
  const t = useTranslate()
  const locale = resolveLocale(useSettings((state) => state.locale))
  const location = useSettings((state) => state.location)
  const province =
    location?.region === 'CN'
      ? provinces.find((item) => item.code === location.province)
      : undefined

  return (
    <SettingCell
      label={t('settingsLocation')}
      status={null}
      className={styles.locationCell}
      action={
        <div className={styles.locationSelectors}>
          {isChineseBrowser() ? (
            <>
              <Select
                ariaLabel={t('settingsLocationProvince')}
                className={styles.provinceSelect}
                value={province?.code ?? ''}
                placeholder={t('settingsLocationProvince')}
                options={provinces.map((item) => ({ value: item.code, label: item.name }))}
                onChange={(value) => {
                  if (value !== province?.code) {
                    setLocation({ region: 'CN', province: value })
                  }
                }}
              />
              <Select
                ariaLabel={t('settingsLocationCity')}
                className={styles.citySelect}
                value={province ? (location?.city ?? '') : ''}
                disabled={!province?.cities.length}
                placeholder={t('settingsLocationCity')}
                options={
                  province?.cities.map((item) => ({ value: item.code, label: item.name })) ?? []
                }
                onChange={(value) => {
                  if (province) {
                    setLocation({ region: 'CN', province: province.code, city: value })
                  }
                }}
              />
            </>
          ) : (
            <Select
              ariaLabel={t('settingsLocationRegion')}
              className={styles.regionSelect}
              value={location?.region ?? ''}
              placeholder={t('settingsLocationRegion')}
              options={regionCodes
                .map((code) => ({ value: code, label: getRegionName(code, locale) }))
                .sort((a, b) => a.label.localeCompare(b.label, locale))}
              onChange={(value) => setLocation({ region: value })}
            />
          )}
        </div>
      }
    />
  )
}

const LocaleSetting = () => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  return (
    <SettingCell
      label={t('settingsLocalePreference')}
      status={null}
      action={
        <Select
          ariaLabel={t('settingsLocalePreference')}
          value={locale}
          options={[
            { value: 'system', label: t('settingsLocaleSystem') },
            { value: 'zh-CN', label: t('settingsLocaleZhCN'), lang: 'zh-CN' },
            { value: 'en-US', label: t('settingsLocaleEnUS'), lang: 'en' },
          ]}
          onChange={setLocale}
        />
      }
    />
  )
}

/** 朗读音色：stella（海星，女声）/ tide（暗潮，男声） */
const TtsVoiceSetting = () => {
  const t = useTranslate()
  const ttsVoice = useSettings((state) => state.ttsVoice)
  return (
    <SettingCell
      label={t('settingsTtsVoice')}
      status={null}
      action={
        <Select
          ariaLabel={t('settingsTtsVoice')}
          value={ttsVoice}
          options={[
            { value: 'stella', label: t('settingsTtsVoiceStella') },
            { value: 'tide', label: t('settingsTtsVoiceTide') },
          ]}
          onChange={setTtsVoice}
        />
      }
    />
  )
}

/** 覆盖导入的二次确认，叠在设置弹窗上 */
const ImportConfirm = ({
  historyImport,
}: {
  historyImport: ReturnType<typeof useHistoryImport>
}) => {
  const t = useTranslate()
  return (
    <ConfirmationModal
      title={t('historyImportConfirmTitle')}
      onClose={historyImport.cancel}
      footer={
        <>
          <Button variant="outlined" size="m" autoFocus onClick={historyImport.cancel}>
            {t('cancel')}
          </Button>
          <Button variant="danger" size="m" onClick={() => void historyImport.confirm()}>
            {t('historyImportConfirm')}
          </Button>
        </>
      }
    >
      {t('backupImportSafety')}
    </ConfirmationModal>
  )
}

const themeChoices: ThemePreference[] = ['light', 'dark', 'system']

/** Native radios supply one Tab stop, arrow-key selection and the announced checked state. */
const ThemeSetting = () => {
  const t = useTranslate()
  const preference = useSettings((state) => state.themePreference)
  const name = useId()
  return (
    <fieldset className={styles.theme} data-theme-picker>
      <legend>{t('settingsAppearance')}</legend>
      <div className={styles.themeOptions}>
        {themeChoices.map((choice) => (
          <label key={choice} data-theme-choice={choice} className={styles.themeOption}>
            <input type="radio" name={name} value={choice} checked={preference === choice}
              onChange={() => setThemePreference(choice)} />
            <span aria-hidden="true" className={styles.themePreview}><i /><i /></span>
            <span>{t(themeLabelKeys[choice])}</span>
            <span aria-hidden="true" className={styles.themeMark}><IconCheckOutline16 /></span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}

/** `reason` 为失败原因的文案 key，展示时按当前语言翻译后填入 `message` 参数。 */
type Status = (TranslationMessage & { error?: boolean; reason?: TranslationKey }) | null

const SettingCell = ({
  label,
  description,
  status,
  action,
  className,
}: {
  label: string
  description?: string
  status: Status
  action: ReactNode
  className?: string
}) => {
  const t = useTranslate()
  return (
    <div className={clsx(styles.cell, styles.row, className)}>
      <div className={styles.text}>
        <div className={styles.label}>{label}</div>
        {status || description ? (
          <div className={clsx(styles.description, status?.error && styles.error)}>
            {status
              ? t(status.key, status.reason ? { message: t(status.reason) } : status.params)
              : description}
          </div>
        ) : null}
      </div>
      {action}
    </div>
  )
}

/** 导入 = 覆盖：用选中文件替换本地全部会话与附件。 */
const ImportHistory = ({
  historyImport,
  disabled,
}: {
  historyImport: ReturnType<typeof useHistoryImport>
  disabled: boolean
}) => {
  const t = useTranslate()
  const inputRef = useRef<HTMLInputElement>(null)

  return (
    <>
      <SettingCell
        label={t('historyImport')}
        description={t('historyImportDescription')}
        status={null}
        action={
        <>
          <Button
            variant="outlined"
            size="m"
            className={clsx(styles.cellButton, styles.uploadButton)}
            disabled={disabled}
            onClick={() => inputRef.current?.click()}
          >
            <IconUploadOutline14 />
            {t('upload')}
          </Button>
          <input
            ref={inputRef}
            type="file"
            accept=".zip,application/zip,application/x-zip-compressed"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) {
                historyImport.select(file)
              }
            }}
          />
        </>
        }
      />
      <HistoryImportFeedback feedback={historyImport.feedback} />
    </>
  )
}

const ExportHistory = DataSettings
