import clsx from 'clsx'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  IconCheckOutline16,
  IconChevronRightOutline14,
  IconRightUpOutline14,
  IconEllipsisOutline16,
  IconDarkOutline16,
  IconFollowsystemOutline16,
  IconLightOutline16,
  IconUploadOutline14,
} from '../base/icons.js'
import {
  SnapshotError,
  clearHistory,
  useBackupState,
} from '../../services/chat/backup.js'
import { useIsSettingsMobile } from '../../app/viewport.js'
import { useChatStore } from '../../services/chat/store.js'
import { regionCodes, getRegionName, provinces } from '../../services/location.js'
import {
  createApiProfile,
  isChineseBrowser,
  removeApiProfile,
  saveApiProfile,
  selectApiProfile,
  setAutoCollapseThinking,
  setChatSource,
  setAvatar,
  setDisplayName,
  setFontScale,
  setLocale,
  setLocation,
  setThemePreference,
  setTtsVoice,
  useSettings,
  type ApiProfile,
  type ThemePreference,
} from '../../services/settings.js'
import { ApiError, fetchModelIds, verifyApiKey } from '../../services/api/client.js'
import { classifyApiError } from '../../services/api/errors.js'
import { defaultApiOrigin, normalizeOrigin } from '../../services/api/origin.js'
import { compareVersions, fetchLatestRelease, type ReleaseInfo } from '../../services/update.js'
import { useUpdateNotice } from '../../services/updateWatcher.js'
import { requestUpdateInstall } from '../../services/updateSafety.js'
import { hasAccountBridge, openAccount, requestAccountLogout } from '../../shell/account.js'
import { openExternal } from '../../shell/native.js'
import {
  resolveLocale,
  useTranslate,
  type TranslationKey,
  type TranslationMessage,
} from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { ConfirmationModal, Modal, ModalPresence } from '../base/Modal.js'
import { Select } from '../base/Select.js'
import { showToast } from '../base/toastState.js'
import { syncLockAppearance } from '../../services/security/bridge.js'
import { SecuritySettings } from './SecuritySettings.js'
import { SettingsIcon, type SettingsIconName } from './SettingsIcon.js'
import { WebDavSettings } from './WebDavSettings.js'
import { MemorySettings } from '../library/MemorySettings.js'
import { ApiKeyField, useApiKeyEditor } from './ApiKeyField.js'
import { openApiUsage } from './ApiUsage.js'
import { MobileSettingsHeader as MobileHeader } from './MobileSettingsHeader.js'
import { useRouteBack, useRouteMotion } from './routeMotion.js'
import { forgetCompaction, listCompactions, type CompactionRecord } from '../../services/chat/compactionIndex.js'
import { clearCompaction, selectSession } from '../../services/chat/store.js'
import { DataSettings, type MobileDataProps } from './DataSettings.js'
import { HistoryImportFeedback, useHistoryImport } from './HistoryImportFeedback.js'
import { closeSettings, coverSettings, finishSettingsExit, openSettings, useSettingsDialog, type SettingsSection, type SettingsVisit } from './settingsDialogState.js'
import { captureChatOrigin, rememberChat } from '../sider/mobileSiderState.js'
import { hasWorkBuddyBridge, useWorkBuddyState } from '../../services/workbuddy/provider.js'
import { WorkBuddyChannel } from './WorkBuddyChannel.js'
import { WorkBuddyPanel, WorkBuddyVersion } from './WorkBuddyPanel.js'
import stellaArtwork from '../../assets/voices/stella.webp'
import tideArtwork from '../../assets/voices/tide.webp'
import styles from './Settings.module.css'

/**
 * 设置：桌面端为居中弹窗、左侧导航；移动端为覆盖整个视口的整页（顶栏返回 + 分组卡片 + 二级页）。
 * 「通用设置」含主题、语言、朗读音色、位置；「数据管理」含 API Key、导入、导出、清空数据。
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

const sections: { value: SettingsSection; label: TranslationKey; icon: SettingsIconName }[] = [
  { value: 'general', label: 'settingDialogAsideGeneralOptionLabel', icon: 'general' },
  { value: 'data', label: 'settingDialogAsideDataOptionLabel', icon: 'data' },
  { value: 'memory', label: 'libMemory', icon: 'memory' },
  { value: 'security', label: 'previewSecurity', icon: 'lock' },
  { value: 'webdav', label: 'previewWebDav', icon: 'cloud' },
]

type ImportProps = { historyImport: ReturnType<typeof useHistoryImport> }

const SettingsContent = ({ historyImport, initialSection }: ImportProps & { initialSection: SettingsSection }) => {
  const t = useTranslate()
  const [section, setSection] = useState<SettingsSection>(initialSection === 'apiKey' ? 'data' : initialSection)
  const [workBuddyPage, setWorkBuddyPage] = useState<'account' | 'wallet' | null>(null)
  const version = readAppVersion()
  // 切换分组不丢失正在输入的 API Key 与导入状态
  const apiKeyEditor = useApiKeyEditor()
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
        <div role="tablist" className={styles.navigation}>
          {sections.map((item) => (
            <button
              key={item.value}
              type="button"
              role="tab"
              aria-selected={section === item.value}
              className={clsx(styles.navItem, section === item.value && styles.navItemActive)}
              onClick={() => setSection(item.value)}
            >
              <SettingsIcon name={item.icon} compact />
              {t(item.label)}
            </button>
          ))}
        </div>
        <div role="tabpanel" className={styles.content}>
          {section === 'security' ? <SecuritySettings /> : section === 'memory' ? <MemorySettings /> : section === 'webdav' ? <WebDavSettings /> : section === 'general' ? (
            <>
              <AccountSettings onWorkBuddy={() => setWorkBuddyPage('account')} />
              <ThemeSetting />
              <LocaleSetting />
              <TtsVoiceSetting />
              <LocationSetting />
            </>
          ) : (
            <>
              <ApiKeyField editor={apiKeyEditor} />
              <SettingCell label={t('usageTitle')} status={null} action={
                <Button data-api-usage-entry variant="outlined" size="m" onClick={openApiUsage}>
                  {t('usageView')}
                </Button>
              } />
              <ImportHistory historyImport={historyImport} disabled={historyBusy} />
              <ExportHistory disabled={historyBusy} />
              <SettingCell
                label={t('deleteAllSessions')}
                status={null}
                action={
                  <Button
                    variant="dangerOutlined"
                    size="m"
                    className={styles.cellButton}
                    disabled={historyBusy}
                    onClick={historyDelete.open}
                  >
                    {t('delete')}
                  </Button>
                }
              />
            </>
          )}
          {version && <WorkBuddyVersion version={version} onOpen={() => setWorkBuddyPage('wallet')} />}
        </div>
      </Modal>
      <ModalPresence>{workBuddyPage && (
        <Modal title={t(workBuddyPage === 'account' ? 'workBuddyAccount' : 'workbuddyTitle')} closable onClose={() => setWorkBuddyPage(null)}>
          {workBuddyPage === 'account' ? <WorkBuddyAccountPage /> : <WorkBuddyPanel />}
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
  | 'appearance'
  | 'fontSize'
  | 'personalize'
  | 'profile'
  | 'location'
  | 'workbuddy'
  | 'workbuddyAccount'

/** 二级页标题（根页统一用「设置」） */
const mobilePageTitles: Record<MobilePage, TranslationKey> = {
  root: 'settings', apiKey: 'settingsKeysTitle', guide: 'apiGuideEntry', data: 'settingDialogAsideDataOptionLabel',
  compacted: 'compactedEntry', security: 'previewSecurity', webdav: 'previewWebDav', memory: 'libMemory',
  appearance: 'settingsAppearance', fontSize: 'settingsFontSize', personalize: 'settingsPersonalize',
  profile: 'settingsProfile', location: 'settingsLocation', workbuddy: 'workbuddyTitle', workbuddyAccount: 'workBuddyAccount',
}

/** 字号档位：7 档，和官方滑块的 7 个刻度一致 */
const fontSizeLevels = [0.85, 0.925, 1, 1.075, 1.15, 1.225, 1.3]
const fontSizeLabelKeys: TranslationKey[] = [
  'fontSizeSmall',
  'fontSizeSmallMedium',
  'fontSizeStandard',
  'fontSizeMediumLarge',
  'fontSizeLarge',
  'fontSizeLarge2',
  'fontSizeXLarge',
]

/** 把连续倍率吸附到最近的档位 */
const nearestFontLevel = (scale: number) => {
  let best = 0
  let bestDiff = Infinity
  fontSizeLevels.forEach((value, index) => {
    const diff = Math.abs(value - scale)
    if (diff < bestDiff) {
      bestDiff = diff
      best = index
    }
  })
  return best
}

/** 外观页顺序与官方一致：跟随系统 / 浅色 / 深色 */
const mobileThemeOrder: ThemePreference[] = ['system', 'light', 'dark']

const themeLabelKeys: Record<ThemePreference, TranslationKey> = {
  system: 'avatarMenuSettingsDialogThemeSelectSystemOption',
  light: 'avatarMenuSettingsDialogThemeSelectLightOption',
  dark: 'avatarMenuSettingsDialogThemeSelectDarkOption',
}

/** 版本号来自构建时注入的 <meta name="application-version">，拿不到就不展示 */
const readAppVersion = () =>
  document.querySelector('meta[name="application-version"]')?.getAttribute('content') ?? ''

type Route = {
  page: MobilePage | 'apiEdit'
  editor?: { profile: ApiProfile; isNew: boolean }
  opener?: HTMLElement
  animateEntry?: boolean
}

// A direct link has exactly one entry. Only a real tap inside Settings pushes a parent.
const entryPage = (section: SettingsSection): MobilePage => {
  if (section === 'general') return 'root'
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
              {page === 'apiKey' && <MobileApiKeyContent onOpenGuide={() => push('guide')} onEdit={edit} />}
              {page === 'apiEdit' && editor && <MobileApiProfileForm {...editor} onDone={() => {
                if (currentRoute.current === route) goBack()
              }} />}
              {page === 'guide' && <MobileApiKeyGuide onFillKey={() => edit('new')} />}
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
              {page === 'workbuddy' && <WorkBuddyPanel />}
              {page === 'workbuddyAccount' && <WorkBuddyAccountPage />}
              {page === 'appearance' && <MobileAppearanceContent />}
              {page === 'fontSize' && <MobileFontSizeContent />}
              {page === 'personalize' && <MobilePersonalizeContent />}
              {page === 'profile' && <MobileProfileContent onOpenLocation={() => push('location')} />}
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
const MobileGroup = ({
  title,
  wide = false,
  children,
}: {
  title?: string
  /** 独立卡片（帮助与反馈、清除数据）与上方卡片留更大间距 */
  wide?: boolean
  children: ReactNode
}) => (
  <div className={clsx(styles.group, wide && styles.groupWide)}>
    {title ? <h2 className={styles.groupTitle}>{title}</h2> : null}
    <div className={styles.card}>{children}</div>
  </div>
)

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
  'data-api-usage-entry'?: boolean
  'data-wb-account-entry'?: boolean
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

/** The account panel never displays or edits an API profile. */
const WorkBuddyAccountPage = () => <div className="wb-settings" data-wb-account-page><WorkBuddyChannel /></div>

const AccountSettings = ({ mobile = false, onWorkBuddy }: { mobile?: boolean; onWorkBuddy: () => void }) => {
  const t = useTranslate()
  const signedIn = useSettings((state) => state.accountSignedIn)
  const hasKey = useSettings((state) => Boolean(state.apiKey))
  const source = useSettings((state) => state.chatSource)
  const workBuddy = useWorkBuddyState(s => s.metadata)
  const options = [
    ...(hasAccountBridge ? [{ value: 'account' as const, label: t('dshAccountBalance') }] : []),
    { value: 'api', label: 'API Key' },
    ...(workBuddy || source === 'workbuddy' ? [{ value: 'workbuddy' as const, label: 'WorkBuddy' }] : []),
  ] as const
  const showChoice = (hasAccountBridge || hasWorkBuddyBridge) && Boolean(workBuddy || source === 'workbuddy' || (source === 'account' ? hasKey : signedIn))
  const picker = (
    <Select
      ariaLabel={t('dshChatUses')}
      value={source}
      className={mobile ? styles.selectHit : undefined}
      options={[...options]}
      onChange={(choice) => {
        setChatSource(choice)
        if (choice === 'account' && !signedIn) {
          openAccount()
        }
      }}
    />
  )
  const label = t(signedIn ? 'dshAccount' : 'dshAccountLogin')
  if (!mobile) {
    return (
      <>
        {hasAccountBridge && <SettingCell label={t('dshAccount')} status={null} action={
          <Button data-dsh-account variant="outlined" size="m" onClick={openAccount}>
            {signedIn ? t('dshAccountManage') : t('dshAccountLogin')}
          </Button>
        } />}
        {hasWorkBuddyBridge && <SettingCell label={t('workBuddyAccount')} status={null} action={
          <Button data-wb-account-entry variant="outlined" size="m" onClick={onWorkBuddy}>
            {t(workBuddy ? 'workBuddyManage' : 'workBuddyLogin')}
          </Button>
        } />}
        {showChoice ? <SettingCell label={t('dshChatUses')} status={null} action={picker} /> : null}
      </>
    )
  }
  return (
    <>
      {hasAccountBridge && <button data-dsh-account type="button" className={styles.row} onClick={openAccount}>
        <span className={styles.rowIcon}><SettingsIcon name="account" /></span>
        <span className={styles.rowLabel}>{label}</span>
        {signedIn ? <span className={styles.rowValue}>{t('dshAccountManage')}</span> : null}
        <span className={styles.rowChevron}><IconChevronRightOutline14 /></span>
      </button>}
      {hasWorkBuddyBridge && (
        <MobileRow data-wb-account-entry icon={<SettingsIcon name="work" />}
          label={t(workBuddy ? 'workBuddyAccount' : 'workBuddyLogin')}
          value={workBuddy ? t('workBuddyManage') : undefined} onClick={onWorkBuddy} />
      )}
      {showChoice ? (
        <MobileSelectRow icon={<SettingsIcon name="source" />} label={t('dshChatUses')} value={source === 'workbuddy' ? 'WorkBuddy' : source === 'api' ? 'API Key' : t('dshAccountBalance')}>
          {picker}
        </MobileSelectRow>
      ) : null}
    </>
  )
}

/** 设置根页：账户 / 应用 / 语音 / 关于，再加帮助与反馈、清除数据两张独立卡片 */
const MobileRootContent = ({ onOpenPage }: { onOpenPage: (page: MobilePage) => void }) => {
  const t = useTranslate()
  const apiKey = useSettings((state) => state.apiKey)
  const displayName = useSettings((state) => state.displayName)
  const locale = useSettings((state) => state.locale)
  const themePreference = useSettings((state) => state.themePreference)
  const ttsVoice = useSettings((state) => state.ttsVoice)
  const fontScale = useSettings((state) => state.fontScale)
  const [helpOpen, setHelpOpen] = useState(false)
  const signedIn = useSettings((state) => state.accountSignedIn)
  const [voiceOpen, setVoiceOpen] = useState(false)
  const [updateOpen, setUpdateOpen] = useState(false)
  const [update, setUpdate] = useState<
    | { status: 'latest' | 'available' | 'error' | 'no-release'; release?: ReleaseInfo }
    | null
  >(null)
  const version = readAppVersion()
  const updateAvailable = useUpdateNotice((state) => state.available)

  const runUpdateCheck = async () => {
    setUpdate(null)
    setUpdateOpen(true)
    try {
      const release = await fetchLatestRelease()
      if (!release) {
        setUpdate({ status: 'no-release' })
        return
      }
      setUpdate({
        status: compareVersions(release.version, version) > 0 ? 'available' : 'latest',
        release,
      })
    } catch {
      setUpdate({ status: 'error' })
    }
  }

  const downloadUpdate = async () => {
    const release = update?.release
    if (!release) {
      return
    }
    await requestUpdateInstall(release)
    setUpdateOpen(false)
  }
  return (
    <>
      <MobileGroup title={t('settingsAccountGroup')}>
        <AccountSettings mobile onWorkBuddy={() => onOpenPage('workbuddyAccount')} />
        <MobileRow
          icon={<SettingsIcon name="key" />}
          label={t('settingsKeysTitle')}
          value={t(apiKey ? 'settingsConfigured' : 'settingsNotSet')}
          onClick={() => onOpenPage('apiKey')}
        />
        <MobileRow
          icon={<SettingsIcon name="profile" />}
          label={t('settingsProfile')}
          value={displayName === 'DeepSeek 用户' ? t('settingsDefaultUser') : displayName}
          onClick={() => onOpenPage('profile')}
        />
      </MobileGroup>
      <MobileGroup title={t('settingsPrivacyGroup')}>
        <MobileRow
          icon={<SettingsIcon name="data" />}
          label={t('settingDialogAsideDataOptionLabel')}
          onClick={() => onOpenPage('data')}
        />
        <MobileRow icon={<SettingsIcon name="lock" />} label={t('previewSecurity')} onClick={() => onOpenPage('security')} />
        <MobileRow icon={<SettingsIcon name="memory" />} label={t('libMemory')} onClick={() => onOpenPage('memory')} />
      </MobileGroup>
      <MobileGroup title={t('settingsAppGroup')}>
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
          icon={<SettingsIcon name="appearance" />}
          label={t('settingsAppearance')}
          value={t(themeLabelKeys[themePreference])}
          onClick={() => onOpenPage('appearance')}
        />
        <MobileRow
          icon={<SettingsIcon name="fontSize" />}
          label={t('settingsFontSize')}
          value={t(fontSizeLabelKeys[nearestFontLevel(fontScale)])}
          onClick={() => onOpenPage('fontSize')}
        />
        <MobileRow
          icon={<SettingsIcon name="personalize" />}
          label={t('settingsPersonalize')}
          onClick={() => onOpenPage('personalize')}
        />
      </MobileGroup>
      <MobileGroup title={t('settingsVoiceGroup')}>
        <MobileRow
          icon={<SettingsIcon name="voice" />}
          label={t('settingsTtsVoice')}
          value={t(ttsVoice === 'stella' ? 'settingsTtsVoiceStella' : 'settingsTtsVoiceTide')}
          onClick={() => setVoiceOpen(true)}
        />
      </MobileGroup>
      {version ? (
        <MobileGroup title={t('settingsAboutGroup')}>
          <button type="button" className={styles.row} onClick={() => void runUpdateCheck()}>
            <span className={styles.rowIcon}>
              <SettingsIcon name="info" />
            </span>
            <span className={styles.rowLabel}>{t('checkUpdate')}</span>
            <span className={styles.rowValue}>
              {updateAvailable ? t('updateBadge') : version}
            </span>
            <span className={styles.rowChevron}>
              <IconChevronRightOutline14 />
            </span>
          </button>
        </MobileGroup>
      ) : null}
      <ModalPresence>{updateOpen ? (
        <Modal
          title={t('checkUpdate')}
          placement="bottom"
          onClose={() => setUpdateOpen(false)}
          footer={
            update?.status === 'available' ? (
              <>
                <Button variant="outlined" size="m" onClick={() => setUpdateOpen(false)}>
                  {t('updateLater')}
                </Button>
                <Button variant="primary" size="m" onClick={downloadUpdate}>
                  {t('updateDownload')}
                </Button>
              </>
            ) : (
              <Button variant="outlined" size="m" onClick={() => setUpdateOpen(false)}>
                {t('close')}
              </Button>
            )
          }
        >
          <div className={styles.updateBody}>
            {update === null ? <p>{t('updateChecking')}</p> : null}
            {update?.status === 'error' ? <p>{t('updateFailed')}</p> : null}
            {update?.status === 'latest' ? (
              <p>{t('updateLatest')}（{version}）</p>
            ) : null}
            {update?.status === 'no-release' ? <p>{t('updateNoRelease')}</p> : null}
            {update?.status === 'available' && update.release ? (
              <>
                <p className={styles.updateTitle}>
                  {t('updateAvailable', { version: update.release.version })}
                </p>
                <div className={styles.updateNotes}>
                  {update.release.notes.trim() || t('updateNotesEmpty')}
                </div>
                {update.release.pageUrl ? (
                  <button
                    type="button"
                    className={styles.fetchButton}
                    onClick={() => void openExternal(update.release?.pageUrl ?? '')}
                  >
                    {t('updateOpenRelease')}
                  </button>
                ) : null}
              </>
            ) : null}
          </div>
        </Modal>
      ) : null}</ModalPresence>
      <MobileGroup wide>
        <button type="button" className={styles.row} onClick={() => setHelpOpen(true)}>
          <span className={styles.rowIcon}>
            <SettingsIcon name="help" />
          </span>
          <span className={styles.rowLabel}>{t('settingsHelp')}</span>
          <span className={styles.rowChevron}>
            <IconChevronRightOutline14 />
          </span>
        </button>
      </MobileGroup>
      {hasAccountBridge && signedIn && <MobileGroup wide>
        <button data-dsh-logout type="button" className={styles.row} onClick={requestAccountLogout}>
          <span className={styles.rowIcon}>
            <SettingsIcon name="signOut" />
          </span>
          <span className={styles.rowLabel}>{t('settingsSignOut')}</span>
          <span className={styles.rowChevron}>
            <IconChevronRightOutline14 />
          </span>
        </button>
      </MobileGroup>}
      {version && <WorkBuddyVersion version={version} onOpen={() => onOpenPage('workbuddy')} />}
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
      <ModalPresence>{helpOpen ? (
        <Modal
          title={t('settingsHelp')}
          placement="bottom"
          onClose={() => setHelpOpen(false)}
          footer={
            <Button variant="outlined" size="m" onClick={() => setHelpOpen(false)}>
              {t('close')}
            </Button>
          }
        >
          <div className={styles.helpText}>{t('settingsHelpDetails')}{'\n'}{t('backupHelpClear')}</div>
        </Modal>
      ) : null}</ModalPresence>
    </>
  )
}

/**
 * 自带的服务商预设：选中后地址、协议、模型一起填好，用户只需要填 Key。
 * OpenAI 兼容地址都实测过 /chat/completions 有响应（401/403/400 = 通了），model 可随时改。
 * 「自定义」用于中转、自建网关，或没列进来的兼容服务。
 */
const providerPresets: {
  value: string
  label: string
  name: string
  protocol: 'deepseek' | 'openai'
  origin: string
  model: string
}[] = [
  {
    value: 'deepseek',
    label: 'DeepSeek 官方',
    name: 'DeepSeek',
    protocol: 'deepseek',
    origin: 'https://api.deepseek.com',
    model: '',
  },
  { value: 'glm', label: '智谱 GLM', name: 'GLM', protocol: 'openai', origin: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.6' },
  { value: 'zai', label: '智谱 GLM（国际）', name: 'Z.ai', protocol: 'openai', origin: 'https://api.z.ai/api/paas/v4', model: 'glm-4.6' },
  { value: 'qwen', label: '阿里云百炼（通义千问）', name: '通义千问', protocol: 'openai', origin: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen3-max' },
  { value: 'qwen-intl', label: '阿里云百炼（国际）', name: 'Qwen', protocol: 'openai', origin: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', model: 'qwen3-max' },
  { value: 'kimi', label: '月之暗面 Kimi', name: 'Kimi', protocol: 'openai', origin: 'https://api.moonshot.cn/v1', model: 'kimi-k2-0905-preview' },
  { value: 'kimi-intl', label: '月之暗面 Kimi（国际）', name: 'Kimi', protocol: 'openai', origin: 'https://api.moonshot.ai/v1', model: 'kimi-k2-0905-preview' },
  { value: 'siliconflow', label: '硅基流动 SiliconFlow', name: 'SiliconFlow', protocol: 'openai', origin: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V3' },
  { value: 'volcengine', label: '火山方舟（豆包）', name: '豆包', protocol: 'openai', origin: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-seed-1-6' },
  { value: 'qianfan', label: '百度千帆（文心）', name: '文心一言', protocol: 'openai', origin: 'https://qianfan.baidubce.com/v2', model: 'ernie-4.5-turbo-128k' },
  { value: 'hunyuan', label: '腾讯混元', name: '混元', protocol: 'openai', origin: 'https://api.hunyuan.cloud.tencent.com/v1', model: 'hunyuan-turbos-latest' },
  { value: 'minimax', label: 'MiniMax', name: 'MiniMax', protocol: 'openai', origin: 'https://api.minimaxi.com/v1', model: 'MiniMax-M2' },
  { value: 'minimax-intl', label: 'MiniMax（国际）', name: 'MiniMax', protocol: 'openai', origin: 'https://api.minimax.io/v1', model: 'MiniMax-M2' },
  { value: 'stepfun', label: '阶跃星辰 StepFun', name: 'StepFun', protocol: 'openai', origin: 'https://api.stepfun.com/v1', model: 'step-2-16k' },
  { value: 'spark', label: '讯飞星火', name: '星火', protocol: 'openai', origin: 'https://spark-api-open.xf-yun.com/v1', model: '4.0Ultra' },
  { value: 'sensenova', label: '商汤日日新', name: '日日新', protocol: 'openai', origin: 'https://api.sensenova.cn/compatible-mode/v1', model: 'SenseChat-5-1202' },
  { value: 'baichuan', label: '百川智能', name: '百川', protocol: 'openai', origin: 'https://api.baichuan-ai.com/v1', model: 'Baichuan4' },
  { value: 'openai', label: 'OpenAI', name: 'OpenAI', protocol: 'openai', origin: 'https://api.openai.com/v1', model: 'gpt-4.1' },
  { value: 'anthropic', label: 'Anthropic Claude', name: 'Claude', protocol: 'openai', origin: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-5' },
  { value: 'gemini', label: 'Google Gemini', name: 'Gemini', protocol: 'openai', origin: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-pro' },
  { value: 'xai', label: 'xAI Grok', name: 'Grok', protocol: 'openai', origin: 'https://api.x.ai/v1', model: 'grok-4' },
  { value: 'mistral', label: 'Mistral', name: 'Mistral', protocol: 'openai', origin: 'https://api.mistral.ai/v1', model: 'mistral-large-latest' },
  { value: 'groq', label: 'Groq', name: 'Groq', protocol: 'openai', origin: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
  { value: 'together', label: 'Together AI', name: 'Together', protocol: 'openai', origin: 'https://api.together.xyz/v1', model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo' },
  { value: 'fireworks', label: 'Fireworks AI', name: 'Fireworks', protocol: 'openai', origin: 'https://api.fireworks.ai/inference/v1', model: 'accounts/fireworks/models/llama-v3p3-70b-instruct' },
  { value: 'deepinfra', label: 'DeepInfra', name: 'DeepInfra', protocol: 'openai', origin: 'https://api.deepinfra.com/v1/openai', model: 'deepseek-ai/DeepSeek-V3' },
  { value: 'cerebras', label: 'Cerebras', name: 'Cerebras', protocol: 'openai', origin: 'https://api.cerebras.ai/v1', model: 'llama-3.3-70b' },
  { value: 'sambanova', label: 'SambaNova', name: 'SambaNova', protocol: 'openai', origin: 'https://api.sambanova.ai/v1', model: 'Meta-Llama-3.3-70B-Instruct' },
  { value: 'novita', label: 'Novita AI', name: 'Novita', protocol: 'openai', origin: 'https://api.novita.ai/v3/openai', model: 'deepseek/deepseek-v3' },
  { value: 'openrouter', label: 'OpenRouter', name: 'OpenRouter', protocol: 'openai', origin: 'https://openrouter.ai/api/v1', model: 'z-ai/glm-4.6' },
  { value: 'perplexity', label: 'Perplexity', name: 'Perplexity', protocol: 'openai', origin: 'https://api.perplexity.ai', model: 'sonar' },
  { value: 'cohere', label: 'Cohere', name: 'Cohere', protocol: 'openai', origin: 'https://api.cohere.ai/compatibility/v1', model: 'command-r-plus' },
  { value: 'opencode', label: 'OpenCode Zen（按量）', name: 'OpenCode', protocol: 'openai', origin: 'https://opencode.ai/inference/openai/v1', model: 'deepseek-v4.1-flash' },
  { value: 'opencode-go', label: 'OpenCode Go（订阅）', name: 'OpenCode Go', protocol: 'openai', origin: 'https://opencode.ai/inference/go/openai/v1', model: 'deepseek-v4.1-flash' },
  { value: 'ollama', label: 'Ollama（本机）', name: 'Ollama', protocol: 'openai', origin: 'http://localhost:11434/v1', model: 'llama3.2' },
  { value: 'lmstudio', label: 'LM Studio（本机）', name: 'LM Studio', protocol: 'openai', origin: 'http://localhost:1234/v1', model: 'local-model' },
  {
    value: 'custom',
    label: '自定义（OpenAI 兼容）',
    name: '自定义',
    protocol: 'openai',
    origin: '',
    model: '',
  },
]

const providerLabelsEn: Record<string, string> = {
  deepseek: 'DeepSeek official', glm: 'Zhipu GLM', zai: 'Z.ai (international)',
  qwen: 'Alibaba Cloud Qwen', 'qwen-intl': 'Alibaba Cloud Qwen (international)',
  kimi: 'Moonshot Kimi', 'kimi-intl': 'Moonshot Kimi (international)', siliconflow: 'SiliconFlow',
  volcengine: 'Volcengine Ark', qianfan: 'Baidu Qianfan', hunyuan: 'Tencent Hunyuan',
  'minimax-intl': 'MiniMax (international)', stepfun: 'StepFun', spark: 'iFlytek Spark',
  sensenova: 'SenseNova', baichuan: 'Baichuan', opencode: 'OpenCode Zen (pay as you go)',
  'opencode-go': 'OpenCode Go (subscription)', ollama: 'Ollama (local)', lmstudio: 'LM Studio (local)',
  custom: 'Custom (OpenAI-compatible)',
}

/** 按当前配置反查预设；认不出就是自定义 */
const matchPreset = (profile: { protocol: string; origin: string; model: string }) =>
  providerPresets.find(
    (preset) =>
      preset.value !== 'custom' &&
      preset.protocol === profile.protocol &&
      preset.origin === normalizeOrigin(profile.origin) &&
      // deepseek 协议的模型固定，不参与匹配
      (preset.protocol === 'deepseek' || (preset.model || '') === (profile.model || ''))
  )?.value ?? 'custom'

/** Key 掩码：只露头尾，够区分是哪一条就行 */
const maskApiKey = (apiKey: string) =>
  apiKey.length <= 14 ? '••••••' : `${apiKey.slice(0, 6)}••••${apiKey.slice(-4)}`

/** 申请官方 DeepSeek API Key 的四步指引：在 App 内完成大部分操作，最后回到这里填 Key */
const MobileApiKeyGuide = ({ onFillKey }: { onFillKey: () => void }) => {
  const t = useTranslate()
  const steps = [
    { title: t('apiGuideStep1Title'), body: t('apiGuideStep1Body') },
    { title: t('apiGuideStep2Title'), body: t('apiGuideStep2Body') },
    { title: t('apiGuideStep3Title'), body: t('apiGuideStep3Body') },
    { title: t('apiGuideStep4Title'), body: t('apiGuideStep4Body') },
  ]
  return (
    <>
      <div className={styles.guideIntro}>{t('apiGuideIntro')}</div>
      <div className={styles.guideSteps}>
        {steps.map((step, index) => (
          <div key={step.title} className={styles.guideStep}>
            <span className={styles.guideIndex}>{index + 1}</span>
            <div className={styles.guideBody}>
              <div className={styles.guideTitle}>{step.title}</div>
              <div className={styles.guideText}>{step.body}</div>
            </div>
          </div>
        ))}
      </div>
      <MobileGroup>
        <MobileRow external icon={<SettingsIcon name="platform" />} label={t('apiGuideOpenPlatform')}
          onClick={() => void openExternal('https://platform.deepseek.com/sign_in')} />
        <MobileRow external icon={<SettingsIcon name="key" />} label={t('apiGuideOpenKeys')}
          onClick={() => void openExternal('https://platform.deepseek.com/api_keys')} />
        <MobileRow external icon={<SettingsIcon name="wallet" />} label={t('apiGuideOpenTopUp')}
          onClick={() => void openExternal('https://platform.deepseek.com/top_up')} />
      </MobileGroup>
      <div className={styles.profileHint}>{t('apiGuideNote')}</div>
      <div className={styles.group}>
        <button type="button" className={styles.mobileConfirm} onClick={onFillKey}>
          {t('apiGuideHaveKey')}
        </button>
      </div>
    </>
  )
}

/**
 * API 配置列表：每条一个名称 + 接口地址 + Key，点一行切换当前使用的配置。
 * 支持多条是为了「官方 Key / 中转地址 / 别的兼容网关」来回切，和 harness 的用法一致。
 */
const MobileApiKeyContent = ({ onOpenGuide, onEdit }: {
  onOpenGuide: () => void
  onEdit: (profile: ApiProfile | 'new') => void
}) => {
  const t = useTranslate()
  const apiProfiles = useSettings((state) => state.apiProfiles)
  const activeProfileId = useSettings((state) => state.chatSource === 'api' ? state.activeProfileId : null)

  return (
    <>
      <MobileGroup>
        <MobileRow icon={<SettingsIcon name="guide" />} label={t('apiGuideEntry')} onClick={onOpenGuide} />
        <MobileRow data-api-usage-entry icon={<SettingsIcon name="usage" />} label={t('usageTitle')} onClick={openApiUsage} />
      </MobileGroup>
      <MobileGroup>
        {apiProfiles.map((profile) => (
          <div key={profile.id} className={styles.profileRow}>
            <button
              type="button"
              className={styles.profileMain}
              onClick={async () => {
                try { await selectApiProfile(profile.id) } catch { showToast({ key: 'credentialWriteFailed' }) }
              }}
            >
              <span
                className={clsx(styles.rowIcon, profile.id === activeProfileId && styles.active)}
              >
                {profile.id === activeProfileId ? <IconCheckOutline16 /> : <SettingsIcon name="key" />}
              </span>
              <span className={styles.rowLabel}>{profile.name}</span>
              <span className={styles.apiKeyMask}>{maskApiKey(profile.apiKey)}</span>
            </button>
            <IconButton
              tone="primary"
              icon={<IconEllipsisOutline16 />}
              aria-label={t('apiProfileEdit')}
              onClick={() => onEdit(profile)}
            />
          </div>
        ))}
        <button type="button" className={styles.row} onClick={() => onEdit('new')}>
          <span className={styles.rowIcon}>
            <SettingsIcon name="add" />
          </span>
          <span className={styles.rowLabel}>{t('apiProfileAdd')}</span>
        </button>
      </MobileGroup>
      <div className={styles.profileHint}>{t('apiProfileHint')}</div>
    </>
  )
}

/** 新增 / 编辑一条 API 配置：先用 GET /models 校验，通过才保存并启用 */
const MobileApiProfileForm = ({
  profile,
  isNew,
  onDone,
}: {
  profile: ApiProfile
  isNew: boolean
  onDone: () => void
}) => {
  const t = useTranslate()
  const english = useSettings((state) => resolveLocale(state.locale) === 'en-US')
  const [preset, setPreset] = useState(() => matchPreset(profile))
  const [name, setName] = useState(profile.name)
  const [protocol, setProtocol] = useState(profile.protocol)
  // 默认地址就不必让人看见，留空即代表官方地址
  const [origin, setOrigin] = useState(profile.origin === defaultApiOrigin ? '' : profile.origin)
  const [model, setModel] = useState(profile.model)
  const [contextWindow, setContextWindow] = useState(
    profile.contextWindow ? String(profile.contextWindow) : ''
  )
  const [apiKey, setApiKey] = useState(profile.apiKey)
  // 模型列表：能拉到就让用户从下拉里挑，拉不到就退回手填
  const [models, setModels] = useState<string[]>([])
  const [loadingModels, setLoadingModels] = useState(false)
  const [customModel, setCustomModel] = useState(false)
  const [modelError, setModelError] = useState(false)

  const loadModels = async () => {
    const key = apiKey.trim()
    if (!key || protocol !== 'openai' || loadingModels) {
      return
    }
    setLoadingModels(true)
    setModelError(false)
    try {
      const list = await fetchModelIds(key, origin.trim() || defaultApiOrigin)
      setModels(list)
      setCustomModel(list.length === 0 || !list.includes(model))
      // 只有一个模型时直接选上，省一步
      if (!model && list.length === 1) {
        setModel(list[0])
      }
    } catch {
      setModelError(true)
    } finally {
      setLoadingModels(false)
    }
  }
  const pickPreset = (value: string) => {
    setPreset(value)
    const next = providerPresets.find((item) => item.value === value)
    if (!next || value === 'custom') {
      return
    }
    setName(english && /[\u4e00-\u9fff]/u.test(next.name) ? providerLabelsEn[next.value] ?? next.name : next.name)
    setProtocol(next.protocol)
    setOrigin(next.origin === defaultApiOrigin ? '' : next.origin)
    setModel(next.model)
  }
  const [verifying, setVerifying] = useState(false)
  const [failure, setFailure] = useState<{ cause: unknown } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const cause = failure?.cause
  const error =
    failure === null
      ? null
      : classifyApiError(cause) === 'unauthorized'
        ? t('apiKeyInvalid')
        : classifyApiError(cause) === 'network'
          ? t('commonNetworkErrorToast')
          : t('apiKeyVerificationFailed', {
              message:
                cause instanceof ApiError && cause.localMessage
                  ? t(cause.localMessage.key, cause.localMessage.params)
                  : cause instanceof Error
                    ? cause.message
                    : String(cause),
            })

  const submit = async () => {
    const key = apiKey.trim()
    if (!key || verifying) {
      return
    }
    setVerifying(true)
    setFailure(null)
    try {
      await verifyApiKey(key, origin.trim() || defaultApiOrigin)
      await saveApiProfile({
        ...profile,
        name: name.trim(),
        protocol,
        origin: origin.trim(),
        model: model.trim(),
        contextWindow: Number(contextWindow) > 0 ? Number(contextWindow) : undefined,
        apiKey: key,
      })
      onDone()
    } catch (e) {
      setFailure({ cause: e })
    } finally {
      setVerifying(false)
    }
  }

  return (
    <>
      <MobileGroup>
        <div className={styles.field}>
          <div className={styles.fieldLabel}>{t('apiProfileProvider')}</div>
          <Select
            value={preset}
            options={providerPresets.map((item) => ({ value: item.value, label: english ? providerLabelsEn[item.value] ?? item.label : item.label }))}
            onChange={pickPreset}
            ariaLabel={t('apiProfileProvider')}
          />
        </div>
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="api-profile-name">
            {t('apiProfileName')}
          </label>
          <input
            id="api-profile-name"
            className={styles.fieldInput}
            value={name}
            placeholder={t('apiProfileNamePlaceholder')}
            autoComplete="off"
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="api-profile-origin">
            {t('apiProfileOrigin')}
          </label>
          <input
            id="api-profile-origin"
            className={styles.fieldInput}
            value={origin}
            placeholder={defaultApiOrigin}
            autoComplete="off"
            spellCheck={false}
            inputMode="url"
            onChange={(event) => setOrigin(event.target.value)}
          />
        </div>
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="api-profile-window">
            {t('apiProfileContextWindow')}
          </label>
          <input
            id="api-profile-window"
            className={styles.fieldInput}
            value={contextWindow}
            placeholder={protocol === 'deepseek' ? '1000000' : '128000'}
            inputMode="numeric"
            autoComplete="off"
            onChange={(event) => setContextWindow(event.target.value.replace(/[^0-9]/g, ''))}
          />
        </div>
        {protocol === 'openai' ? (
          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor="api-profile-model">
              {t('apiProfileModel')}
            </label>
            {models.length > 0 && !customModel ? (
              <Select
                value={model}
                options={[
                  ...models.map((item) => ({ value: item, label: item })),
                  { value: '__custom__', label: t('apiProfileModelCustom') },
                ]}
                onChange={(value) => {
                  if (value === '__custom__') {
                    setCustomModel(true)
                    return
                  }
                  setModel(value)
                }}
                placeholder={t('apiProfileModelPlaceholder')}
                ariaLabel={t('apiProfileModel')}
              />
            ) : (
              <input
                id="api-profile-model"
                className={styles.fieldInput}
                value={model}
                placeholder={t('apiProfileModelPlaceholder')}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setModel(event.target.value)}
              />
            )}
            <div className={styles.fieldAction}>
              <button
                type="button"
                className={styles.fetchButton}
                disabled={!apiKey.trim() || loadingModels}
                onClick={() => void loadModels()}
              >
                {loadingModels ? t('apiProfileModelFetching') : t('apiProfileModelFetch')}
              </button>
              {models.length > 0 && customModel ? (
                <button
                  type="button"
                  className={styles.fetchButton}
                  onClick={() => {
                    setCustomModel(false)
                    setModel(models[0] ?? model)
                  }}
                >
                  {t('apiProfileModel')}
                </button>
              ) : null}
            </div>
            {modelError ? (
              <div className={styles.profileHint}>{t('apiProfileModelFetchFailed')}</div>
            ) : null}
          </div>
        ) : (
          <div className={styles.field}>
            <div className={styles.fieldLabel}>{t('apiProfileModel')}</div>
            <div className={styles.profileHint}>{t('apiProfileModelBuiltin')}</div>
          </div>
        )}
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="api-profile-key">
            {t('apiProfileKey')}
          </label>
          <input
            id="api-profile-key"
            className={styles.fieldInput}
            type="password"
            value={apiKey}
            placeholder={t('apiKeyPlaceholder')}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setApiKey(event.target.value)}
          />
        </div>
      </MobileGroup>
      {error ? <div className={styles.statusText}>{error}</div> : null}
      <div className={styles.group}>
        <button
          type="button"
          className={styles.mobileConfirm}
          disabled={verifying || !apiKey.trim()}
          onClick={() => void submit()}
        >
          {verifying ? t('apiKeyVerifying') : t('apiProfileSave')}
        </button>
        {isNew ? null : (
          <button
            type="button"
            className={clsx(styles.mobileConfirm, styles.dangerConfirm)}
            onClick={() => setConfirmDelete(true)}
          >
            {t('apiProfileDelete')}
          </button>
        )}
      </div>
      <ModalPresence>{confirmDelete ? (
      <ConfirmationModal
        title={t('apiProfileDeleteTitle')}
        onClose={() => setConfirmDelete(false)}
        footer={
          <>
            <Button variant="outlined" size="m" autoFocus onClick={() => setConfirmDelete(false)}>
              {t('cancel')}
            </Button>
            <Button
              variant="danger"
              size="m"
              onClick={async () => {
                try { await removeApiProfile(profile.id) } catch {
                  showToast({ key: 'credentialWriteFailed' })
                  return
                }
                setConfirmDelete(false)
                onDone()
              }}
            >
              {t('delete')}
            </Button>
          </>
        }
      >
        {t('apiProfileDeleteDescription')}
      </ConfirmationModal>
      ) : null}</ModalPresence>
    </>
  )
}

/** 已压缩的对话：查看摘要、回看原文、恢复完整上下文 */
const MobileCompactedContent = ({ onOpenChat }: { onOpenChat: (sessionId: string) => void }) => {
  const t = useTranslate()
  const [records, setRecords] = useState<CompactionRecord[]>(() => listCompactions())
  const [expanded, setExpanded] = useState<string | null>(null)
  const [summaries, setSummaries] = useState<Record<string, string>>({})

  const loadSummary = (sessionId: string) => {
    if (summaries[sessionId]) {
      return
    }
    const session = useChatStore.getState().sessionCache[sessionId]
    const text = session?.checkpoint?.text ?? ''
    const body = text
      .replace(/^[\s\S]*?<compacted-summary>/, '')
      .replace(/<\/compacted-summary>[\s\S]*$/, '')
      .trim()
    setSummaries((prev) => ({ ...prev, [sessionId]: body || t('contextSummaryMissing') }))
  }

  if (records.length === 0) {
    return <div className={styles.profileHint}>{t('compactedEmpty')}</div>
  }

  return (
    <MobileGroup>
      {records.map((record) => (
        <div key={record.sessionId} className={styles.compactedItem}>
          <button
            type="button"
            className={styles.row}
            onClick={() => {
              setExpanded(expanded === record.sessionId ? null : record.sessionId)
              loadSummary(record.sessionId)
            }}
          >
            <span className={styles.rowLabel}>{record.title}</span>
            <span className={styles.rowValue}>
              {t('compactedMeta', {
                time: new Date(record.createdAt).toLocaleDateString(),
                count: record.coveredMessages,
              })}
            </span>
          </button>
          {expanded === record.sessionId ? (
            <div className={styles.compactedBody}>
              <div className={styles.summaryText}>{summaries[record.sessionId] ?? ''}</div>
              <div className={styles.compactedActions}>
                <button
                  type="button"
                  className={styles.fetchButton}
                  onClick={() => onOpenChat(record.sessionId)}
                >
                  {t('compactedOpen')}
                </button>
                <button
                  type="button"
                  className={styles.fetchButton}
                  onClick={() => {
                    clearCompaction(record.sessionId)
                    forgetCompaction(record.sessionId)
                    setRecords(listCompactions())
                    showToast({ key: 'compactedRestored' })
                  }}
                >
                  {t('compactedRestore')}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ))}
    </MobileGroup>
  )
}

const MobileDataContent = ({ disabled, ...mobile }: MobileDataProps & { disabled: boolean }) => (
  <DataSettings disabled={disabled} mobile={mobile} />
)

/** 字体大小：照官方——顶部预览、底部「跟随系统」开关 + A—A 七档滑块 */
const MobileFontSizeContent = () => {
  const t = useTranslate()
  const fontScale = useSettings((state) => state.fontScale)
  const [followSystem, setFollowSystem] = useState(
    () => localStorage.getItem('chat-demo:font-follow-system') === 'true'
  )
  const level = nearestFontLevel(fontScale)

  const applyLevel = (index: number) => {
    setFontScale(fontSizeLevels[index])
    setFollowSystem(false)
    localStorage.setItem('chat-demo:font-follow-system', 'false')
  }

  return (
    <div className={styles.fontPage}>
      <div className={styles.fontPreviewArea} style={{ fontSize: `${16 * fontScale}px` }}>
        <div className={styles.fontBubble}>{t('fontSizePreviewBubble')}</div>
        <p className={styles.fontParagraph}>{t('fontSizePreviewLine1')}</p>
        <p className={styles.fontParagraph}>{t('fontSizePreviewLine2')}</p>
        <button
          type="button"
          className={styles.fetchButton}
          onClick={() => void openExternal('https://github.com/leezzou/deepchat/issues')}
        >
          github.com/leezzou/deepchat/issues
        </button>
      </div>
      <div className={styles.fontSheet}>
        <div className={styles.fontFollowRow}>
          <span>{t('fontSizeFollowSystem')}</span>
          <button
            type="button"
            role="switch"
            aria-checked={followSystem}
            aria-label={t('fontSizeFollowSystem')}
            className={clsx(styles.fontSwitch, followSystem && styles.fontSwitchOn)}
            onClick={() => {
              const next = !followSystem
              setFollowSystem(next)
              localStorage.setItem('chat-demo:font-follow-system', String(next))
              if (next) {
                setFontScale(1)
              }
            }}
          >
            <span className={styles.fontSwitchKnob} />
          </button>
        </div>
        <div className={styles.fontSliderRow}>
          <span className={styles.fontA}>A</span>
          <div className={styles.fontSliderWrap}>
            <div className={styles.fontLevelLabel}>{t(fontSizeLabelKeys[level])}</div>
            <input
              type="range"
              min={0}
              max={fontSizeLevels.length - 1}
              step={1}
              value={level}
              disabled={followSystem}
              className={styles.fontSlider}
              aria-label={t('settingsFontSize')}
              onChange={(event) => applyLevel(Number(event.target.value))}
            />
          </div>
          <span className={clsx(styles.fontA, styles.fontALarge)}>A</span>
        </div>
      </div>
    </div>
  )
}

/** 个性化：照官方——只有「思考内容自动折叠」一个开关和说明 */
const MobilePersonalizeContent = () => {
  const t = useTranslate()
  const autoCollapseThinking = useSettings((state) => state.autoCollapseThinking)
  return (
    <>
      <MobileGroup>
        <div className={clsx(styles.row, styles.rowStatic)}>
          <span className={styles.rowLabel}>{t('personalizeCollapseThinking')}</span>
          <button
            type="button"
            role="switch"
            aria-checked={autoCollapseThinking}
            aria-label={t('personalizeCollapseThinking')}
            className={clsx(styles.fontSwitch, autoCollapseThinking && styles.fontSwitchOn)}
            onClick={() => setAutoCollapseThinking(!autoCollapseThinking)}
          >
            <span className={styles.fontSwitchKnob} />
          </button>
        </div>
      </MobileGroup>
      <div className={styles.profileHint}>{t('personalizeCollapseHint')}</div>
    </>
  )
}

/** 账号资料：头像、昵称、位置（本 App 无登录体系，资料只存本机） */
const MobileProfileContent = ({ onOpenLocation }: { onOpenLocation: () => void }) => {
  const t = useTranslate()
  const displayName = useSettings((state) => state.displayName)
  const avatar = useSettings((state) => state.avatar)
  const location = useSettings((state) => state.location)
  const locale = useSettings((state) => resolveLocale(state.locale))
  const [name, setName] = useState(displayName)
  const inputRef = useRef<HTMLInputElement>(null)

  const pickAvatar = async (file: File) => {
    const bitmap = await createImageBitmap(file)
    const canvas = document.createElement('canvas')
    const size = 96
    canvas.width = size
    canvas.height = size
    const context = canvas.getContext('2d')
    if (!context) {
      return
    }
    const scale = Math.max(size / bitmap.width, size / bitmap.height)
    const w = bitmap.width * scale
    const h = bitmap.height * scale
    context.drawImage(bitmap, (size - w) / 2, (size - h) / 2, w, h)
    setAvatar(canvas.toDataURL('image/jpeg', 0.85))
  }

  return (
    <>
      <MobileGroup>
        <div className={styles.field}>
          <div className={styles.fieldLabel}>{t('personalizeAvatar')}</div>
          <div className={styles.avatarRow}>
            <span className={styles.avatarPreview}>
              {avatar ? <img src={avatar} alt="" /> : <SettingsIcon name="account" />}
            </span>
            <button type="button" className={styles.fetchButton} onClick={() => inputRef.current?.click()}>
              {t('personalizePickAvatar')}
            </button>
            {avatar ? (
              <button type="button" className={styles.fetchButton} onClick={() => setAvatar(null)}>
                {t('personalizeResetAvatar')}
              </button>
            ) : null}
          </div>
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) {
                void pickAvatar(file)
              }
            }}
          />
        </div>
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="profile-name">
            {t('personalizeName')}
          </label>
          <input
            id="profile-name"
            className={styles.fieldInput}
            value={name}
            onChange={(event) => setName(event.target.value)}
            onBlur={() => setDisplayName(name)}
            placeholder={t('personalizeNamePlaceholder')}
          />
        </div>
      </MobileGroup>
      <MobileGroup>
        <button type="button" className={styles.row} onClick={onOpenLocation}>
          <span className={styles.rowIcon}>
            <SettingsIcon name="location" />
          </span>
          <span className={styles.rowLabel}>{t('settingsLocation')}</span>
          <span className={styles.rowValue}>
            {location ? (location.region === 'CN' ? location.province ?? t('settingsConfigured') : getRegionName(location.region, locale)) : t('settingsNotSet')}
          </span>
          <span className={styles.rowChevron}>
            <IconChevronRightOutline14 />
          </span>
        </button>
      </MobileGroup>
      <div className={styles.profileHint}>{t('personalizeHint')}</div>
    </>
  )
}

/** 外观：单列三个选项，当前项右侧显示蓝色对勾 */
const MobileAppearanceContent = () => {
  const t = useTranslate()
  const themePreference = useSettings((state) => state.themePreference)
  return (
    <div className={styles.group}>
      <div className={styles.card} role="radiogroup" aria-label={t('settingsAppearance')}>
        {mobileThemeOrder.map((value) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={themePreference === value}
            className={clsx(styles.row, styles.optionRow)}
            onClick={() => setThemePreference(value)}
          >
            <span className={styles.rowLabel}>{t(themeLabelKeys[value])}</span>
            {themePreference === value ? (
              <span className={styles.optionCheck}>
                <IconCheckOutline16 />
              </span>
            ) : null}
          </button>
        ))}
      </div>
    </div>
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
      showToast({ key: error instanceof SnapshotError ? 'backupSnapshotFailed' : 'historyDeleteFailed', type: 'error' })
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

const themeOptions: { value: ThemePreference; label: TranslationKey; icon: ReactNode }[] = [
  {
    value: 'light',
    label: 'avatarMenuSettingsDialogThemeSelectLightOption',
    icon: <IconLightOutline16 />,
  },
  {
    value: 'dark',
    label: 'avatarMenuSettingsDialogThemeSelectDarkOption',
    icon: <IconDarkOutline16 />,
  },
  {
    value: 'system',
    label: 'avatarMenuSettingsDialogThemeSelectSystemOption',
    icon: <IconFollowsystemOutline16 />,
  },
]

/**
 * 主题项：标题下方浅色 / 深色 / 跟随系统三个选块。
 * 与下方语言选项连续排列。
 */
const ThemeSetting = () => {
  const t = useTranslate()
  const themePreference = useSettings((state) => state.themePreference)
  const label = t('avatarMenuSettingsDialogThemeItemLabel')
  return (
    <div className={styles.theme}>
      {label}
      <div role="radiogroup" aria-label={label} className={styles.themeOptions}>
        {themeOptions.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={themePreference === option.value}
            className={clsx(
              styles.themeOption,
              themePreference === option.value && styles.themeOptionSelected
            )}
            onClick={() => setThemePreference(option.value)}
          >
            {option.icon}
            {t(option.label)}
          </button>
        ))}
      </div>
    </div>
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

/** 自动生成仅提醒；打开设置后由用户选择保存位置，不主动唤起系统分享。 */
export const BackupReminder = () => {
  const t = useTranslate()
  const latest = useBackupState((state) => state.latest)
  const settingsOpen = useSettingsDialog((state) => state.visits.some((visit) => visit.status === 'open'))
  const [dismissed, setDismissed] = useState<string | null>(null)
  if (settingsOpen || !latest || latest.reason !== 'automatic' || latest.saveStatus === 'confirmed' || latest.id === dismissed) {return null}
  return <aside className={styles.backupReminder} aria-label={t('backupTitle')}>
    <p role="status">{t('backupAutoReminder')}</p>
    <div className={styles.backupActions}>
      <Button variant="primary" size="m" onClick={() => openSettings('data')}>{t('backupOpenSettings')}</Button>
      <Button variant="outlined" size="m" onClick={() => setDismissed(latest.id)}>{t('backupDismissReminder')}</Button>
    </div>
  </aside>
}
