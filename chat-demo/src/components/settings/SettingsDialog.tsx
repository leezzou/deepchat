import { isAnthropicOrigin } from '../../services/api/anthropicOfficial.js'
import { ContextModelSettings } from './ContextModelSettings.js'
import { allowsKeylessLocal, endpointProvider, nativeModels, parseWindow } from '../../services/api/modelWindows.js'
import { ProviderModelPicker } from './ProviderModelPicker.js'
import { modelEndpoint } from '../../services/api/modelDiscovery.js'
import { profileWindowKey, resolveWindow, withProfileWindow } from '../../services/api/contextOverrides.js'
import { providerPresets, providerLabelsEn } from '../../services/api/providerPresets.js'
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
import { PostCommitRecoveryError } from '../../services/backup/portableMetadata.js'
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
import { defaultApiOrigin, normalizeOrigin } from '../../services/api/origin.js'
import { useUpdateNotice } from '../../services/updateWatcher.js'
import { SettingsUpdate } from './SettingsUpdate.js'
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
import { androidShell, syncLockAppearance } from '../../services/security/bridge.js'
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
import { closeSettings, coverSettings, finishSettingsExit, useSettingsDialog, type SettingsSection, type SettingsVisit } from './settingsDialogState.js'
import { captureChatOrigin, rememberChat } from '../sider/mobileSiderState.js'
import { hasWorkBuddyBridge, useWorkBuddyState } from '../../services/workbuddy/provider.js'
import { WorkBuddyAccountPage } from './WorkBuddyAccountPage.js'
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
  { value: 'contextModels', label: 'modelContextTitle', icon: 'source' },
  { value: 'security', label: 'previewSecurity', icon: 'lock' },
  { value: 'webdav', label: 'previewWebDav', icon: 'cloud' },
]

type ImportProps = { historyImport: ReturnType<typeof useHistoryImport> }

const SettingsContent = ({ historyImport, initialSection }: ImportProps & { initialSection: SettingsSection }) => {
  const t = useTranslate()
  const [section, setSection] = useState<SettingsSection>(initialSection === 'apiKey' ? 'data' : initialSection)
  const [workBuddyOpen, setWorkBuddyOpen] = useState(false)
  const version = useUpdateNotice((state) => state.version)
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
        <div role="tabpanel" className={styles.content}>
          {section === 'contextModels' ? <ContextModelSettings /> : section === 'security' ? <SecuritySettings /> : section === 'memory' ? <MemorySettings /> : section === 'webdav' ? <WebDavSettings /> : section === 'general' ? (
            <>
              <AccountSettings onWorkBuddy={() => setWorkBuddyOpen(true)} />
              <ThemeSetting />
              <LocaleSetting />
              <TtsVoiceSetting />
              <LocationSetting />
              {version && <SettingsUpdate />}
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
          {version && <div className={styles.versionFooter} data-app-version>{t('settingsVersion', { version })}</div>}
        </div>
      </Modal>
      <ModalPresence>{workBuddyOpen && (
        <Modal title={t('workBuddyAccount')} closable onClose={() => setWorkBuddyOpen(false)}>
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
  | 'appearance'
  | 'fontSize'
  | 'personalize'
  | 'profile'
  | 'location'
  | 'workbuddyAccount'
  | 'contextModels'

/** 二级页标题（根页统一用「设置」） */
const mobilePageTitles: Record<MobilePage, TranslationKey> = {
  contextModels: 'modelContextTitle', root: 'settings', apiKey: 'settingsKeysTitle', guide: 'apiGuideEntry', data: 'settingDialogAsideDataOptionLabel',
  compacted: 'compactedEntry', security: 'previewSecurity', webdav: 'previewWebDav', memory: 'libMemory',
  appearance: 'settingsAppearance', fontSize: 'settingsFontSize', personalize: 'settingsPersonalize',
  profile: 'settingsProfile', location: 'settingsLocation', workbuddyAccount: 'workBuddyAccount',
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
              {page === 'contextModels' && <ContextModelSettings />}
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
  const version = useUpdateNotice((state) => state.version)
  return (
    <>
      <MobileGroup title={t('settingsAccountGroup')}>
        <AccountSettings mobile onWorkBuddy={() => onOpenPage('workbuddyAccount')} />
        <MobileRow data-usage-home-entry icon={<SettingsIcon name="usage" />} label={t('usageTitle')} onClick={openApiUsage} />
        <MobileRow data-context-settings-entry icon={<SettingsIcon name="source" />} label={t('modelContextTitle')} onClick={() => onOpenPage('contextModels')} />
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
          <SettingsUpdate mobile />
        </MobileGroup>
      ) : null}
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
      {version && <div className={styles.versionFooter} data-app-version>{t('settingsVersion', { version })}</div>}
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

/** 按当前配置反查预设；认不出就是自定义 */
const matchPreset = (profile: ApiProfile) =>
  (profile.providerId && providerPresets.some(item => item.value === profile.providerId) ? profile.providerId : undefined)
  ?? endpointProvider(normalizeOrigin(profile.origin)) ?? 'custom'

const endpointIdentity = (value: string) => {
  try { return modelEndpoint(value).origin } catch { return '' }
}

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

/** Model discovery is optional: an offline or restricted endpoint can still be configured. */
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
  const [discoveredReasoning, setDiscoveredReasoning] = useState(profile.discoveredReasoning ?? {})
  const [discoveredWindows, setDiscoveredWindows] = useState(profile.discoveredWindows ?? {})
  const [discoveredWindowKinds, setDiscoveredWindowKinds] = useState(profile.discoveredWindowKinds ?? {})
  const targetModel = model.trim() || 'deepseek-flash'
  const targetOrigin = normalizeOrigin(origin)
  const targetKey = profileWindowKey(targetOrigin, targetModel, protocol)
  const effective = resolveWindow({ profile: { ...profile, providerId: preset, discoveredWindows, discoveredWindowKinds }, origin: targetOrigin, protocol, model: targetModel })
  const [windowDraft, setWindowDraft] = useState<{ key: string; text: string } | null>(null)
  const contextWindow = windowDraft?.key === targetKey ? windowDraft.text : String(effective.manual ?? '')
  const invalidWindow = Boolean(contextWindow && !parseWindow(contextWindow))
  const [apiKey, setApiKey] = useState(profile.apiKey)
  const [, catalogReady] = useState(0)
  const [keyCleared, setKeyCleared] = useState(false)
  const endpoint = preset === 'custom' && !origin.trim() ? '' : normalizeOrigin(origin)
  const validEndpoint = Boolean(endpointIdentity(endpoint))
  const canSave = validEndpoint && (!isAnthropicOrigin(endpoint) || !!model.trim()) && (Boolean(apiKey.trim()) || allowsKeylessLocal(endpoint, protocol)) && !invalidWindow
  const directoryProvider = endpointProvider(endpoint, preset) ?? 'custom'
  const publicList = ['ollama', 'lmstudio', 'opencode', 'opencode-go', 'openrouter', 'deepinfra'].includes(directoryProvider)
  const editableProtocol = (id: string) => isAnthropicOrigin(endpoint) ? 'anthropic' : preset === 'deepseek' && (!id || nativeModels.some(modelId => id === modelId)) ? 'deepseek' : 'openai'
  const changeOrigin = (next: string) => {
    if (apiKey && endpointIdentity(endpoint) !== endpointIdentity(next || (preset === 'custom' ? '' : defaultApiOrigin))) {
      setApiKey(''); setKeyCleared(true); setDiscoveredReasoning({})
    }
    setOrigin(next)
    if (isAnthropicOrigin(next)) setProtocol('anthropic')
    else if (protocol === 'anthropic') setProtocol('openai')
  }
  const pickPreset = (value: string) => {
    const next = providerPresets.find((item) => item.value === value)
    if (!next || value === preset) { return }
    // Reusing a key across providers, plans or endpoint origins requires re-entry.
    if (apiKey) { setKeyCleared(true) }
    setApiKey(''); setDiscoveredReasoning({}); setPreset(value)
    setName(english && /[\u4e00-\u9fff]/u.test(next.name) ? providerLabelsEn[next.value] ?? next.name : next.name)
    setProtocol(next.protocol)
    setOrigin(next.origin === defaultApiOrigin ? '' : next.origin)
    setModel(next.protocol === 'deepseek' ? 'deepseek-flash' : next.model)
  }
  const [verifying, setVerifying] = useState(false)
  const [failure, setFailure] = useState<{ cause: unknown } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const error = failure ? t('credentialWriteFailed') : null

  const submit = async () => {
    const key = apiKey.trim()
    if (!canSave || verifying) {
      return
    }
    setVerifying(true)
    setFailure(null)
    try {
      const assembledProfile = { ...profile, providerId: preset, name: name.trim(), protocol, origin: targetOrigin, model: model.trim(), discoveredReasoning, discoveredWindows, discoveredWindowKinds, apiKey: key }
      await saveApiProfile(windowDraft?.key === targetKey ? withProfileWindow(assembledProfile, targetKey, parseWindow(contextWindow)) : assembledProfile)
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
            placeholder={preset === 'custom' ? 'https://…/v1' : defaultApiOrigin}
            autoComplete="off"
            spellCheck={false}
            inputMode="url"
            onChange={(event) => changeOrigin(event.target.value)}
          />
          {androidShell && /^http:\/\//i.test(endpoint) && !/^http:\/\/(?:localhost|127\.0\.0\.1|10\.0\.2\.2)(?:[:/]|$)/i.test(endpoint) ? <div className={styles.profileHint}>{english
            ? 'Use HTTPS for this server. Android blocks cleartext LAN requests for both model discovery and chat.'
            : '请将此服务配置为 HTTPS。Android 会拦截通过普通 HTTP 连接局域网的模型列表和聊天请求。'}</div>
          : ['ollama','lmstudio'].includes(preset) && <div className={styles.profileHint}>{english
            ? 'On Android, localhost means this phone. For a desktop server use its HTTPS address, or 10.0.2.2 in the Android emulator.'
            : 'Android 上的 localhost 指手机本机。连接电脑上的服务可填其 HTTPS 地址；模拟器可用 10.0.2.2。'}</div>}
        </div>
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="api-profile-model">{t('apiProfileModel')}</label>
          <ProviderModelPicker id="api-profile-model" ariaLabel={t('apiProfileModel')} providerId={directoryProvider} value={model}
            endpoint={endpoint} apiKey={apiKey.trim()} discover={validEndpoint && (Boolean(apiKey.trim()) || publicList || allowsKeylessLocal(endpoint, protocol))}
            onCatalogReady={() => catalogReady(n => n + 1)}
            onChange={id => { setModel(id); setProtocol(editableProtocol(id)) }}
            onDiscovered={(id, tokens, source, reasoning) => {
              const key = profileWindowKey(targetOrigin, id, editableProtocol(id))
              setDiscoveredReasoning(prev => {
                if (prev[key] === reasoning) return prev
                if (reasoning) return { ...prev, [key]: reasoning }
                return Object.fromEntries(Object.entries(prev).filter(([entry]) => entry !== key))
              })
              if (tokens === undefined) {
                const withoutCurrentModel = <T,>(values: Record<string, T>) => {
                  if (!Object.hasOwn(values, key)) { return values }
                  return Object.fromEntries(Object.entries(values).filter(([id]) => id !== key))
                }
                setDiscoveredWindowKinds(withoutCurrentModel)
                setDiscoveredWindows(withoutCurrentModel)
                return
              }
              setDiscoveredWindowKinds(prev => prev[key] === source ? prev : { ...prev, [key]: source })
              setDiscoveredWindows(prev => prev[key] === tokens ? prev : { ...prev, [key]: tokens })
            }} />
        </div>
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="api-profile-window">
            {t('apiProfileContextWindow')}
          </label>
          <input
            id="api-profile-window"
            className={styles.fieldInput}
            value={contextWindow}
            placeholder={effective.spec.basis === 'fallback' && !effective.inheritedWindow ? (english ? 'Enter the deployment’s token limit' : '按实际部署填写 token 数') : String(effective.inheritedWindow ?? effective.spec.window)}
            aria-invalid={invalidWindow}
            inputMode="numeric"
            autoComplete="off"
            onChange={(event) => setWindowDraft({ key: targetKey, text: event.target.value })}
          />
        </div>
        {invalidWindow && <div role="alert" className={styles.statusText}>{t('modelContextInvalid')}</div>}
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
            onChange={(event) => { setKeyCleared(false); setApiKey(event.target.value); setDiscoveredReasoning({}); setDiscoveredWindows({}); setDiscoveredWindowKinds({}) }}
          />
          {keyCleared && <div className={styles.profileHint}>{english ? 'Enter the key for this endpoint.' : '接口已切换，请填写当前接口的密钥。'}</div>}
        </div>
      </MobileGroup>
      {error ? <div className={styles.statusText}>{error}</div> : null}
      <div className={styles.group}>
        <button
          type="button"
          className={styles.mobileConfirm}
          disabled={verifying || !canSave}
          onClick={() => void submit()}
        >
          {verifying ? (english ? 'Saving…' : '正在保存…') : t('apiProfileSave')}
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
