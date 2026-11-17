import clsx from 'clsx'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  IconCheckOutline16,
  IconChevronRightOutline14,
  IconEllipsisOutline16,
  IconPlusCircle24,
  IconDarkOutline16,
  IconDataOutline16,
  IconDownloadOutline16,
  IconFollowsystemOutline16,
  IconGlobeLanguageOutline14,
  IconLightOutline16,
  IconPlayMediaOutline16,
  IconSettingsOutline16,
  IconTrashOutline16,
  IconUploadOutline14,
} from '../base/icons.js'
import {
  BackupError,
  clearHistory,
  exportHistory,
  importHistory,
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
  clearApiProfiles,
  setAutoCollapseThinking,
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
import { installApk } from '../../shell/installer.js'
import { openExternal } from '../../shell/native.js'
import {
  resolveLocale,
  useTranslate,
  type TranslationKey,
  type TranslationMessage,
} from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { Modal } from '../base/Modal.js'
import { Select } from '../base/Select.js'
import { showToast } from '../base/toastState.js'
import { ApiKeyField, useApiKeyEditor } from './ApiKeyField.js'
import { saveBlob } from '../../shell/saveFile.js'
import { popLayer, pushLayer } from '../../shell/native.js'
import { forgetCompaction, listCompactions, type CompactionRecord } from '../../services/chat/compactionIndex.js'
import { clearCompaction, selectSession } from '../../services/chat/store.js'
import { downloadArchive } from '../../services/chat/history/downloadArchive.js'
import { closeSettings, useSettingsDialog, type SettingsSection } from './settingsDialogState.js'
import stellaArtwork from '../../assets/voices/stella.webp'
import tideArtwork from '../../assets/voices/tide.webp'
import styles from './Settings.module.css'

/**
 * 设置：桌面端为居中弹窗、左侧导航；移动端为覆盖整个视口的整页（顶栏返回 + 分组卡片 + 二级页）。
 * 「通用设置」含主题、语言、朗读音色、位置；「数据管理」含 API Key、导入、导出、清空数据。
 */
export const SettingsDialog = () => {
  const open = useSettingsDialog((state) => state.open)
  const isSettingsMobile = useIsSettingsMobile()
  if (!open) {
    return null
  }
  return isSettingsMobile ? <MobileSettings /> : <SettingsContent />
}

const sections: { value: SettingsSection; label: TranslationKey; icon: ReactNode }[] = [
  {
    value: 'general',
    label: 'settingDialogAsideGeneralOptionLabel',
    icon: <IconSettingsOutline16 />,
  },
  { value: 'data', label: 'settingDialogAsideDataOptionLabel', icon: <IconDataOutline16 /> },
]

const SettingsContent = () => {
  const t = useTranslate()
  // 打开时按调用方指定的分组选中，之后在弹窗内切换
  const [section, setSection] = useState(() => useSettingsDialog.getState().section)
  // 切换分组不丢失正在输入的 API Key 与导入状态
  const apiKeyEditor = useApiKeyEditor()
  const historyImport = useHistoryImport()
  const historyDelete = useHistoryDelete()
  const replacingHistory = useChatStore((state) => state.importingHistory)
  const historyBusy = historyImport.busy || historyDelete.busy || replacingHistory
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
              {item.icon}
              {t(item.label)}
            </button>
          ))}
        </div>
        <div role="tabpanel" className={styles.content}>
          {section === 'general' ? (
            <>
              <ThemeSetting />
              <LocaleSetting />
              <TtsVoiceSetting />
              <LocationSetting />
            </>
          ) : (
            <>
              <ApiKeyField editor={apiKeyEditor} />
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
        </div>
      </Modal>
      {historyImport.file ? <ImportConfirm historyImport={historyImport} /> : null}
      {historyDelete.opened ? <DeleteAllConfirm historyDelete={historyDelete} /> : null}
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
  | 'appearance'
  | 'fontSize'
  | 'personalize'
  | 'profile'
  | 'location'

/** 二级页标题（根页统一用「设置」） */
const mobilePageTitles: Record<Exclude<MobilePage, 'root'>, string> = {
  apiKey: 'API Key 管理',
  guide: '申请官方 API Key',
  data: '数据管理',
  compacted: '已压缩的对话',
  appearance: '外观',
  fontSize: '字体大小',
  personalize: '个性化',
  profile: '账号资料',
  location: '位置信息',
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

/** 帮助与反馈内容：只描述应用里真实存在的能力 */
const helpText = [
  '在「账户 → API Key 管理」中填写 DeepSeek API Key 后即可开始对话。',
  '「数据管理」可以导入或导出全部历史对话，导出的 ZIP 文件也能再次导入。',
  '「清除数据」会删除本机保存的所有对话、附件和草稿，且无法恢复。',
].join('\n')

/** 版本号来自构建时注入的 <meta name="application-version">，拿不到就不展示 */
const readAppVersion = () =>
  document.querySelector('meta[name="application-version"]')?.getAttribute('content') ?? ''

/** 移动端设置整页：根页常驻，二级页叠在根页之上 */
const MobileSettings = () => {
  const t = useTranslate()
  const historyImport = useHistoryImport()
  const historyExport = useHistoryExport()
  const historyDelete = useHistoryDelete()
  const replacingHistory = useChatStore((state) => state.importingHistory)
  const historyBusy = historyImport.busy || historyDelete.busy || replacingHistory
  // 首次启动没有 API Key 时会以「数据管理」打开，直接停在 API Key 页
  const [page, setPage] = useState<MobilePage>(() =>
    useSettingsDialog.getState().section === 'data' ? 'apiKey' : 'root'
  )
  // 从申请指引点「我已拿到 Key」后，直接展开新增表单
  const [autoAddKey, setAutoAddKey] = useState(false)
  // API Key 页里当前正在编辑的配置（null = 列表态）；放在这一层是为了让返回键先退表单
  const [apiKeyEditing, setApiKeyEditing] = useState<ApiProfile | 'new' | null>(null)
  const close = () => {
    if (!historyDelete.busy) {
      closeSettings()
    }
  }

  /** 返回一层：表单 → API Key 列表 → 设置根页 → 关闭设置 */
  const goBack = () => {
    if (page === 'apiKey' && apiKeyEditing) {
      setApiKeyEditing(null)
      return
    }
    if (page !== 'root') {
      setPage('root')
      return
    }
    close()
  }
  // Android 返回键：逐层回退，不再一按就退出整个设置
  const backRef = useRef(goBack)
  backRef.current = goBack
  useEffect(() => {
    const entry = pushLayer(() => backRef.current())
    return () => popLayer(entry)
  }, [])
  return createPortal(
    <div className={styles.page} role="dialog" aria-modal="true" aria-label={t('settings')}>
      <MobileHeader title={t('settings')} onBack={close} />
      <div className={styles.body}>
        <MobileRootContent onOpenPage={setPage} />
      </div>
      {page === 'root' ? null : (
        <div className={styles.subPage}>
          <MobileHeader title={mobilePageTitles[page]} onBack={goBack} />
          <div className={styles.body}>
            {page === 'apiKey' ? (
              <MobileApiKeyContent
                autoAdd={autoAddKey}
                onAutoAddDone={() => setAutoAddKey(false)}
                onOpenGuide={() => setPage('guide')}
                editing={apiKeyEditing}
                setEditing={setApiKeyEditing}
              />
            ) : null}
            {page === 'guide' ? (
              <MobileApiKeyGuide
                onFillKey={() => {
                  setAutoAddKey(true)
                  setPage('apiKey')
                }}
              />
            ) : null}
            {page === 'data' ? (
              <MobileDataContent
                historyImport={historyImport}
                historyExport={historyExport}
                disabled={historyBusy}
                onOpenCompacted={() => setPage('compacted')}
                onDeleteAll={historyDelete.open}
              />
            ) : null}
            {page === 'compacted' ? <MobileCompactedContent /> : null}
            {page === 'appearance' ? <MobileAppearanceContent /> : null}
            {page === 'fontSize' ? <MobileFontSizeContent /> : null}
            {page === 'personalize' ? <MobilePersonalizeContent /> : null}
            {page === 'profile' ? (
              <MobileProfileContent onOpenLocation={() => setPage('location')} />
            ) : null}
            {page === 'location' ? <MobileLocationContent /> : null}
          </div>
        </div>
      )}
      {historyImport.file ? <ImportConfirm historyImport={historyImport} /> : null}
      {historyDelete.opened ? <DeleteAllConfirm historyDelete={historyDelete} /> : null}
    </div>,
    document.body
  )
}

/** 顶栏：左侧 40px 圆形返回键、居中标题，没有右侧元素和分隔线 */
const MobileHeader = ({ title, onBack }: { title: string; onBack: () => void }) => (
  <div className={styles.topBar}>
    <button type="button" className={styles.backButton} aria-label="返回" onClick={onBack}>
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M14.5 5.5 8 12l6.5 6.5"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
    <div className={styles.pageTitle}>{title}</div>
  </div>
)

/** 字体大小图标：Aa */
const IconFontSize = () => (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M4 19 9.2 6h1.6L16 19" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M6.1 15h7.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    <path d="M16.4 19 19.3 12h1.2L23 19" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

/** 个性化图标：调色盘 */
const IconPersonalize = () => (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path
      d="M12 3a9 9 0 0 0 0 18c1.2 0 1.8-.8 1.8-1.7 0-.9-.7-1.5-.7-2.3 0-.9.7-1.5 1.6-1.5H16a5 5 0 0 0 5-5c0-4.1-4-7.5-9-7.5Z"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
    />
    <circle cx="7.8" cy="9.4" r="1.1" fill="currentColor" />
    <circle cx="12" cy="7" r="1.1" fill="currentColor" />
    <circle cx="16.2" cy="9.4" r="1.1" fill="currentColor" />
  </svg>
)

/** 退出登录图标：门 + 箭头 */
const IconSignOut = () => (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M14 4h4.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M9.5 8 5.5 12l4 4M5.8 12H15" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

/** 账户图标：钥匙 */
const IconKey = () => (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="8.2" cy="8.2" r="4.4" stroke="currentColor" strokeWidth="1.6" />
    <path
      d="m11.4 11.4 8.1 8.1M16 16.1l2-2M18.6 18.7l2-2"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
    />
  </svg>
)

/** 关于图标：圆形信息 */
const IconInfo = () => (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="12" cy="12" r="8.4" stroke="currentColor" strokeWidth="1.6" />
    <path d="M12 11.2v5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    <circle cx="12" cy="7.9" r="1" fill="currentColor" />
  </svg>
)

/** 帮助与反馈图标：圆形问号 */
const IconHelp = () => (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="12" cy="12" r="8.4" stroke="currentColor" strokeWidth="1.6" />
    <path
      d="M9.6 9.4a2.5 2.5 0 0 1 4.9.6c0 1.7-2.4 1.8-2.4 3.4v.4"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <circle cx="12" cy="16.8" r="1" fill="currentColor" />
  </svg>
)

/** 位置图标：定位针 */
const IconLocation = () => (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path
      d="M12 21s6.5-5.5 6.5-11a6.5 6.5 0 1 0-13 0C5.5 15.5 12 21 12 21Z"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
    />
    <circle cx="12" cy="10" r="2.4" stroke="currentColor" strokeWidth="1.6" />
  </svg>
)

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
    {title ? <div className={styles.groupTitle}>{title}</div> : null}
    <div className={styles.card}>{children}</div>
  </div>
)

const MobileRow = ({
  icon,
  label,
  value,
  onClick,
  disabled = false,
}: {
  icon?: ReactNode
  label: string
  value?: string
  onClick: () => void
  disabled?: boolean
}) => (
  <button type="button" className={styles.row} disabled={disabled} onClick={onClick}>
    {icon ? <span className={styles.rowIcon}>{icon}</span> : null}
    <span className={styles.rowLabel}>{label}</span>
    {value ? <span className={styles.rowValue}>{value}</span> : null}
    <span className={styles.rowChevron}>
      <IconChevronRightOutline14 />
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
  icon?: ReactNode
  label: string
  value: string
  muted?: boolean
  children: ReactNode
}) => (
  <div className={clsx(styles.row, muted && styles.rowMuted)}>
    {icon ? <span className={styles.rowIcon}>{icon}</span> : null}
    <span className={styles.rowLabel}>{label}</span>
    <span className={styles.rowValue}>{value}</span>
    <span className={styles.rowChevron}>
      <IconChevronRightOutline14 />
    </span>
    {children}
  </div>
)

/** 设置根页：账户 / 应用 / 语音 / 关于，再加帮助与反馈、清除数据两张独立卡片 */
const MobileRootContent = ({ onOpenPage }: { onOpenPage: (page: MobilePage) => void }) => {
  const t = useTranslate()
  const apiKey = useSettings((state) => state.apiKey)
  const displayName = useSettings((state) => state.displayName)
  const locale = useSettings((state) => state.locale)
  const themePreference = useSettings((state) => state.themePreference)
  const ttsVoice = useSettings((state) => state.ttsVoice)
  const [helpOpen, setHelpOpen] = useState(false)
  const [signOutOpen, setSignOutOpen] = useState(false)
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

  const downloadUpdate = () => {
    const release = update?.release
    if (!release) {
      return
    }
    // 原生壳里直接下载 APK 并拉起系统安装器；浏览器里退回 GitHub 发布页
    if (release.apkUrl && installApk(release.apkUrl)) {
      showToast({ key: 'updateDownloading' })
      setUpdateOpen(false)
      return
    }
    void openExternal(release.pageUrl)
  }
  return (
    <>
      <MobileGroup title="账户">
        <MobileRow
          icon={<IconKey />}
          label="API Key 管理"
          value={apiKey ? '已设置' : '未设置'}
          onClick={() => onOpenPage('apiKey')}
        />
        <MobileRow
          icon={<IconPersonalize />}
          label={t('settingsProfile')}
          value={displayName}
          onClick={() => onOpenPage('profile')}
        />
        <MobileRow
          icon={<IconDataOutline16 />}
          label={t('settingDialogAsideDataOptionLabel')}
          onClick={() => onOpenPage('data')}
        />
      </MobileGroup>
      <MobileGroup title="应用">
        <MobileSelectRow
          icon={<IconGlobeLanguageOutline14 />}
          label={t('settingsLocalePreference')}
          value={
            locale === 'system'
              ? t('settingsLocaleSystem')
              : locale === 'zh-CN'
                ? '中文 (简体中文)'
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
          icon={<IconLightOutline16 />}
          label="外观"
          value={t(themeLabelKeys[themePreference])}
          onClick={() => onOpenPage('appearance')}
        />
        <MobileRow
          icon={<IconFontSize />}
          label={t('settingsFontSize')}
          value={t(fontSizeLabelKeys[nearestFontLevel(useSettings.getState().fontScale)])}
          onClick={() => onOpenPage('fontSize')}
        />
        <MobileRow
          icon={<IconPersonalize />}
          label={t('settingsPersonalize')}
          onClick={() => onOpenPage('personalize')}
        />
      </MobileGroup>
      <MobileGroup title="语音">
        <MobileRow
          icon={<IconPlayMediaOutline16 />}
          label={t('settingsTtsVoice')}
          value={t(ttsVoice === 'stella' ? 'settingsTtsVoiceStella' : 'settingsTtsVoiceTide')}
          onClick={() => setVoiceOpen(true)}
        />
      </MobileGroup>
      {version ? (
        <MobileGroup title="关于">
          <button type="button" className={styles.row} onClick={() => void runUpdateCheck()}>
            <span className={styles.rowIcon}>
              <IconInfo />
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
      {updateOpen ? (
        <Modal
          title={t('checkUpdate')}
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
      ) : null}
      <MobileGroup wide>
        <button type="button" className={styles.row} onClick={() => setHelpOpen(true)}>
          <span className={styles.rowIcon}>
            <IconHelp />
          </span>
          <span className={styles.rowLabel}>帮助与反馈</span>
          <span className={styles.rowChevron}>
            <IconChevronRightOutline14 />
          </span>
        </button>
      </MobileGroup>
      <MobileGroup wide>
        <button type="button" className={styles.row} onClick={() => setSignOutOpen(true)}>
          <span className={styles.rowIcon}>
            <IconSignOut />
          </span>
          <span className={styles.rowLabel}>{t('settingsSignOut')}</span>
          <span className={styles.rowChevron}>
            <IconChevronRightOutline14 />
          </span>
        </button>
      </MobileGroup>
      {version ? <div className={styles.meta}>版本 {version}</div> : null}
      {voiceOpen ? (
        <Modal
          title={t('settingsTtsVoice')}
          closable
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
      ) : null}
      {signOutOpen ? (
        <Modal
          title={t('settingsSignOut')}
          onClose={() => setSignOutOpen(false)}
          footer={
            <>
              <Button variant="outlined" size="m" onClick={() => setSignOutOpen(false)}>
                {t('cancel')}
              </Button>
              <Button
                variant="dangerOutlined"
                size="m"
                onClick={() => {
                  setSignOutOpen(false)
                  clearApiProfiles()
                  closeSettings()
                  showToast({ key: 'signedOut' })
                }}
              >
                {t('settingsSignOut')}
              </Button>
            </>
          }
        >
          <div className={styles.riskNote}>{t('settingsSignOutHint')}</div>
        </Modal>
      ) : null}
      {helpOpen ? (
        <Modal
          title="帮助与反馈"
          onClose={() => setHelpOpen(false)}
          footer={
            <Button variant="outlined" size="m" onClick={() => setHelpOpen(false)}>
              {t('close')}
            </Button>
          }
        >
          <div className={styles.helpText}>{helpText}</div>
        </Modal>
      ) : null}
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
        <button
          type="button"
          className={styles.row}
          onClick={() => void openExternal('https://platform.deepseek.com/sign_in')}
        >
          <span className={styles.rowIcon}>
            <IconKey />
          </span>
          <span className={styles.rowLabel}>{t('apiGuideOpenPlatform')}</span>
          <span className={styles.rowChevron}>
            <IconChevronRightOutline14 />
          </span>
        </button>
        <button
          type="button"
          className={styles.row}
          onClick={() => void openExternal('https://platform.deepseek.com/api_keys')}
        >
          <span className={styles.rowIcon}>
            <IconInfo />
          </span>
          <span className={styles.rowLabel}>{t('apiGuideOpenKeys')}</span>
          <span className={styles.rowChevron}>
            <IconChevronRightOutline14 />
          </span>
        </button>
        <button
          type="button"
          className={styles.row}
          onClick={() => void openExternal('https://platform.deepseek.com/top_up')}
        >
          <span className={styles.rowIcon}>
            <IconInfo />
          </span>
          <span className={styles.rowLabel}>{t('apiGuideOpenTopUp')}</span>
          <span className={styles.rowChevron}>
            <IconChevronRightOutline14 />
          </span>
        </button>
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
const MobileApiKeyContent = ({
  autoAdd = false,
  onAutoAddDone,
  onOpenGuide,
  editing,
  setEditing,
}: {
  autoAdd?: boolean
  onAutoAddDone?: () => void
  onOpenGuide?: () => void
  editing: ApiProfile | 'new' | null
  setEditing: (value: ApiProfile | 'new' | null) => void
}) => {
  const t = useTranslate()
  const apiProfiles = useSettings((state) => state.apiProfiles)
  const activeProfileId = useSettings((state) => state.activeProfileId)
  // 从申请指引过来时自动展开新增表单
  if (autoAdd && editing === null) {
    setEditing('new')
    onAutoAddDone?.()
  }

  if (editing !== null) {
    return (
      <MobileApiProfileForm
        key={editing === 'new' ? 'new' : editing.id}
        profile={editing === 'new' ? createApiProfile() : editing}
        isNew={editing === 'new'}
        onDone={() => setEditing(null)}
      />
    )
  }

  return (
    <>
      <MobileGroup>
        <button type="button" className={styles.row} onClick={onOpenGuide}>
          <span className={styles.rowIcon}>
            <IconKey />
          </span>
          <span className={styles.rowLabel}>{t('apiGuideEntry')}</span>
          <span className={styles.rowChevron}>
            <IconChevronRightOutline14 />
          </span>
        </button>
      </MobileGroup>
      <MobileGroup>
        {apiProfiles.map((profile) => (
          <div key={profile.id} className={styles.profileRow}>
            <button
              type="button"
              className={styles.profileMain}
              onClick={() => selectApiProfile(profile.id)}
            >
              <span
                className={clsx(styles.rowIcon, profile.id === activeProfileId && styles.active)}
              >
                {profile.id === activeProfileId ? <IconCheckOutline16 /> : <IconKey />}
              </span>
              <span className={styles.rowLabel}>{profile.name}</span>
              <span className={styles.apiKeyMask}>{maskApiKey(profile.apiKey)}</span>
            </button>
            <IconButton
              tone="primary"
              icon={<IconEllipsisOutline16 />}
              aria-label={t('apiProfileEdit')}
              onClick={() => setEditing(profile)}
            />
          </div>
        ))}
        <button type="button" className={styles.row} onClick={() => setEditing('new')}>
          <span className={styles.rowIcon}>
            <IconPlusCircle24 />
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
      const list = await fetchModelIds(key, origin.trim() || undefined)
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
    setName(next.name)
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
      await verifyApiKey(key, origin.trim() || undefined)
      saveApiProfile({
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
            options={providerPresets.map((item) => ({ value: item.value, label: item.label }))}
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
      {confirmDelete ? (
      <Modal
        title={t('apiProfileDeleteTitle')}
        onClose={() => setConfirmDelete(false)}
        footer={
          <>
            <Button variant="outlined" size="m" autoFocus onClick={() => setConfirmDelete(false)}>
              {t('cancel')}
            </Button>
            <Button
              variant="dangerOutlined"
              size="m"
              onClick={() => {
                removeApiProfile(profile.id)
                setConfirmDelete(false)
                onDone()
              }}
            >
              {t('delete')}
            </Button>
          </>
        }
      >
        <div className={styles.importConfirmText}>{t('apiProfileDeleteDescription')}</div>
      </Modal>
      ) : null}
    </>
  )
}

/** 已压缩的对话：查看摘要、回看原文、恢复完整上下文 */
const MobileCompactedContent = () => {
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
                  onClick={() => {
                    selectSession(record.sessionId)
                    closeSettings()
                  }}
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

/** 数据管理：导入 / 导出各占一行，结果在卡片下方提示 */
const MobileDataContent = ({
  historyImport,
  historyExport,
  disabled,
  onOpenCompacted,
  onDeleteAll,
}: {
  historyImport: ReturnType<typeof useHistoryImport>
  historyExport: ReturnType<typeof useHistoryExport>
  disabled: boolean
  onOpenCompacted: () => void
  onDeleteAll: () => void
}) => {
  const t = useTranslate()
  const inputRef = useRef<HTMLInputElement>(null)
  const empty = useChatStore((state) => state.sessions.length === 0)
  // 官方 App 的「导出数据」给的是一个 7 天有效的下载链接，粘进来直接下载并走同一套导入流程
  const [link, setLink] = useState('')
  const [downloading, setDownloading] = useState(false)
  const downloadFromLink = async () => {
    const url = link.trim()
    if (!url || downloading) {
      return
    }
    setDownloading(true)
    try {
      // 原生壳里走 Filesystem.downloadFile，绕开 WebView 的 CORS 限制
      historyImport.select(await downloadArchive(url))
    } catch (error) {
      // 把真实原因带出来：过期、跨域、网络都可能失败，只给一句通用话没法排查
      const detail = error instanceof Error ? error.message : String(error)
      showToast({
        key: 'deepseekImportFailed',
        params: { message: detail.slice(0, 160) },
      })
    } finally {
      setDownloading(false)
    }
  }
  return (
    <>
      <MobileGroup>
        <button
          type="button"
          className={styles.row}
          disabled={disabled}
          onClick={() => inputRef.current?.click()}
        >
          <span className={styles.rowIcon}>
            <IconUploadOutline14 />
          </span>
          <span className={styles.rowLabel}>{t('historyImport')}</span>
          <span className={styles.rowValue}>{t('upload')}</span>
        </button>
        <button
          type="button"
          className={styles.row}
          disabled={disabled || empty}
          onClick={onDeleteAll}
        >
          <span className={styles.rowIcon}>
            <IconTrashOutline16 />
          </span>
          <span className={styles.rowLabel}>{t('deleteAllHistory')}</span>
        </button>
        <button type="button" className={styles.row} onClick={onOpenCompacted}>
          <span className={styles.rowIcon}>
            <IconDataOutline16 />
          </span>
          <span className={styles.rowLabel}>{t('compactedEntry')}</span>
          <span className={styles.rowValue}>{listCompactions().length}</span>
          <span className={styles.rowChevron}>
            <IconChevronRightOutline14 />
          </span>
        </button>
        <button
          type="button"
          className={styles.row}
          disabled={disabled || historyExport.busy || empty}
          onClick={() => void historyExport.run()}
        >
          <span className={styles.rowIcon}>
            <IconDownloadOutline16 />
          </span>
          <span className={styles.rowLabel}>{t('exportAllLabel')}</span>
          <span className={styles.rowValue}>{t('exportAllDownload')}</span>
        </button>
      </MobileGroup>
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
      <MobileGroup title={t('deepseekImportTitle')}>
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="deepseek-export-link">
            {t('deepseekImportLink')}
          </label>
          <input
            id="deepseek-export-link"
            className={styles.fieldInput}
            value={link}
            placeholder={t('deepseekImportPlaceholder')}
            autoComplete="off"
            spellCheck={false}
            inputMode="url"
            onChange={(event) => setLink(event.target.value)}
          />
        </div>
        <button
          type="button"
          className={styles.row}
          disabled={disabled || downloading || !link.trim()}
          onClick={() => void downloadFromLink()}
        >
          <span className={styles.rowIcon}>
            <IconDownloadOutline16 />
          </span>
          <span className={styles.rowLabel}>{t('deepseekImportAction')}</span>
          <span className={styles.rowValue}>{downloading ? t('deepseekImportDownloading') : ''}</span>
        </button>
      </MobileGroup>
      <div className={styles.profileHint}>{t('deepseekImportHint')}</div>
      <MobileStatus status={historyImport.status ?? historyExport.status} />
    </>
  )
}

const MobileStatus = ({ status }: { status: Status }) => {
  const t = useTranslate()
  return status ? (
    <div className={clsx(styles.statusText, status.error && styles.error)}>
      {t(status.key, status.reason ? { message: t(status.reason) } : status.params)}
    </div>
  ) : null
}

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
              {avatar ? <img src={avatar} alt="" /> : <IconPersonalize />}
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
            <IconLocation />
          </span>
          <span className={styles.rowLabel}>{t('settingsLocation')}</span>
          <span className={styles.rowValue}>
            {location ? (location.region === 'CN' ? location.province ?? '已设置' : getRegionName(location.region, 'zh-CN')) : '未设置'}
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
      <div className={styles.card} role="radiogroup" aria-label="外观">
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
        <MobileSelectRow label="省份/地区" value={province?.name ?? '未设置'}>
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
          label="城市"
          value={city?.name ?? '未设置'}
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
        label="国家或地区"
        value={location ? getRegionName(location.region, locale) : '未设置'}
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
    <Modal
      title={t('deleteAllSessionsModalTitle')}
      className={styles.deleteConfirm}
      onClose={historyDelete.cancel}
      footer={
        <div className={styles.deleteActions} aria-busy={historyDelete.busy}>
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
        </div>
      }
    >
      {t('deleteAllSessionsModalDescription')}
    </Modal>
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
    } catch {
      showToast({ key: 'historyDeleteFailed', type: 'error' })
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
    <Modal
      title={t('historyImportConfirmTitle')}
      className={styles.importConfirm}
      onClose={historyImport.cancel}
      footer={
        <>
          <Button variant="outlined" size="m" autoFocus onClick={historyImport.cancel}>
            {t('cancel')}
          </Button>
          <Button variant="dangerOutlined" size="m" onClick={() => void historyImport.confirm()}>
            {t('historyImportConfirm')}
          </Button>
        </>
      }
    >
      <div className={styles.importConfirmText}>{t('historyImportConfirmDescription')}</div>
    </Modal>
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

/** 导出失败附带原因：预期的错误用对应文案作原因，其他错误用错误信息。 */
const errorStatus = (key: TranslationKey, error: unknown): Status => ({
  key,
  ...(error instanceof BackupError
    ? { reason: error.key }
    : { params: { message: error instanceof Error ? error.message : String(error) } }),
  error: true,
})

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

/** 选文件后先提示覆盖；确认后才检查文件并执行导入，任何错误都提示导入失败。 */
const useHistoryImport = () => {
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)
  const importing = useRef(false)

  const confirm = async () => {
    if (!file || importing.current) {
      return
    }
    importing.current = true
    setFile(null)
    setBusy(true)
    setStatus({ key: 'historyImporting' })
    try {
      const count = await importHistory(file)
      setStatus({ key: count === 1 ? 'historyImportedOne' : 'historyImported', params: { count } })
    } catch (error) {
      // 带上具体原因（无法识别 / 版本过新 / 内容不完整），否则用户不知道是文件问题还是下载问题
      setStatus(errorStatus('historyImportFailed', error))
    } finally {
      importing.current = false
      setBusy(false)
    }
  }

  return { file, busy, status, select: setFile, cancel: () => setFile(null), confirm }
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
    <SettingCell
      label={t('historyImport')}
      description={t('historyImportDescription')}
      status={historyImport.status}
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
  )
}

/** 将全部会话及图片导出为 ZIP 文件并下载 */
/** 将全部会话及图片导出为 ZIP 文件并下载；桌面表格与移动端行共用 */
const useHistoryExport = () => {
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)

  const run = async () => {
    setBusy(true)
    setStatus(null)
    try {
      const { name, blob } = await exportHistory()
      // 原生壳里 a[download] 会静默失败，统一走 saveBlob（写入 + 系统分享）
      await saveBlob(name, blob)
    } catch (error) {
      setStatus(errorStatus('historyExportFailed', error))
    } finally {
      setBusy(false)
    }
  }

  return { busy, status, run }
}

const ExportHistory = ({ disabled }: { disabled: boolean }) => {
  const t = useTranslate()
  const empty = useChatStore((state) => state.sessions.length === 0)
  const { busy, status, run } = useHistoryExport()

  return (
    <SettingCell
      label={t('exportAllLabel')}
      description={t('historyExportDescription')}
      status={status}
      action={
        <Button
          variant="outlined"
          size="m"
          className={styles.cellButton}
          disabled={disabled || busy || empty}
          onClick={() => void run()}
        >
          <IconDownloadOutline16 />
          {t('exportAllDownload')}
        </Button>
      }
    />
  )
}
