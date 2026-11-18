import { useEffect } from 'react'
import { resolveLocale, useTranslate } from '../i18n/index.js'
import { hasAccountBridge, initializeAccount } from '../shell/account.js'
import { useSettings } from '../services/settings.js'
import { useIsMobile, useMobileViewport, usePreventPageScroll } from './viewport.js'
import {
  bindChatPersistence,
  initChat,
  retrySaveSessions,
  selectSession,
  useChatStore,
} from '../services/chat/store.js'
import { SearchPanel } from '../components/search/SearchPanel.js'
import { closeSearchPanel } from '../components/search/searchPanelState.js'
import { SessionView } from '../components/session/SessionView.js'
import { MobileHeader } from '../components/session/MobileHeader.js'
import { Welcome } from '../components/session/Welcome.js'
import { ensureApiKey } from '../components/settings/settingsDialogState.js'
import { BackupReminder, SettingsDialog } from '../components/settings/SettingsDialog.js'
import { ApiUsageDialog } from '../components/settings/ApiUsage.js'
import { HistorySearch } from '../components/historySearch/HistorySearch.js'
import {
  bindDraftPersistence,
  flushDrafts,
  initDrafts,
  useDrafts,
} from '../services/chat/drafts.js'
import { initializeAutoBackup } from '../services/backup/automatic.js'
import { bindUpdateSafety } from '../services/updateSafety.js'
import { UpdateSafetyNotice } from './UpdateSafetyNotice.js'
import { Toast } from '../components/base/Toast.js'
import { showToast } from '../components/base/toastState.js'
import { onUploadNotice } from '../services/attachments.js'
import { Button } from '../components/base/Button.js'
import { stopReadAloud } from '../services/speech/readAloud.js'
import { CollapsedSider } from '../components/sider/CollapsedSider.js'
import {
  closeMobileSider,
  openMobileSider,
  useMobileSider,
} from '../components/sider/mobileSiderState.js'
import { isNative, useNativeShell } from '../shell/native.js'
import { useEdgeSwipe } from './edgeSwipe.js'
import { useUpdateWatcher } from '../services/updateWatcher.js'
import { MobileSider, Sider } from '../components/sider/Sider.js'
import styles from './App.module.css'

export const App = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const locale = useSettings((state) => state.locale)
  // 移动端侧边栏以独立抽屉管理开合状态
  const siderCollapsed = useSettings((state) => state.siderCollapsed) && !isMobile
  const ready = useChatStore((state) => state.ready)
  const draftsReady = useDrafts((state) => state.ready)
  const draftSaveError = useDrafts((state) => state.saveError)
  const draftRecoveryWarning = useDrafts((state) => state.recoveryWarning)
  const initError = useChatStore((state) => state.initError)
  const saveError = useChatStore((state) => Object.values(state.sessionSaveErrors).some(Boolean))
  const importingHistory = useChatStore((state) => state.importingHistory)
  const session = useChatStore((state) =>
    state.activeId !== null && Object.hasOwn(state.sessionCache, state.activeId)
      ? state.sessionCache[state.activeId]
      : undefined
  )
  const sessionLoadError = useChatStore((state) =>
    state.activeId === null ? false : state.sessionLoadErrors[state.activeId] === true
  )
  // Android 由 windowSoftInputMode=adjustResize 处理键盘，原生壳里不再做 visualViewport 补偿
  const frameRef = useMobileViewport(!isNative)
  const streaming = useChatStore((state) =>
    state.activeId === null
      ? false
      : Object.hasOwn(state.streaming, state.activeId) ||
        Object.hasOwn(state.compacting, state.activeId)
  )
  const activeId = useChatStore((state) => state.activeId)

  usePreventPageScroll(isMobile)
  useNativeShell()
  // App 启动、回前台及运行期间每 60 秒检查新版本，用红点提示
  useUpdateWatcher()
  // 左缘右滑打开对话抽屉，抽屉打开时左滑关闭
  useEdgeSwipe(
    isMobile,
    useMobileSider((state) => state.open),
    openMobileSider,
    closeMobileSider
  )

  useEffect(() => {
    document.documentElement.lang = resolveLocale(locale)
  }, [locale])

  // 聊天字号倍率
  const fontScale = useSettings((state) => state.fontScale)
  useEffect(() => {
    document.documentElement.style.setProperty('--msg-font-scale', String(fontScale || 1))
  }, [fontScale])

  // 文件数、存储空间达到上限时，附件上只显示「上传失败」，原因用 toast 说明
  useEffect(() => onUploadNotice(showToast), [])
  useEffect(bindChatPersistence, [])
  useEffect(bindDraftPersistence, [])
  useEffect(bindUpdateSafety, [])
  useEffect(() => (ready && draftsReady ? initializeAutoBackup() : undefined), [ready, draftsReady])

  // 搜索结果面板只属于当前会话
  useEffect(closeSearchPanel, [activeId])
  // 切换会话时停止朗读
  useEffect(stopReadAloud, [activeId])
  // 移动端选中会话、切换布局后收起抽屉
  useEffect(closeMobileSider, [activeId, isMobile])

  useEffect(() => {
    void initChat()
    void initDrafts()
    if (hasAccountBridge) {
      initializeAccount((account) =>
        useSettings.setState({
          accountSignedIn: account.signedIn,
          accountName: account.name,
          accountAvatar: account.avatar,
        })
      )
    } else {
      ensureApiKey()
    }
  }, [])

  return (
    <>
      <div ref={frameRef} className={styles.frame}>
        {isMobile ? <MobileSider /> : siderCollapsed ? null : <Sider />}
        <main className={styles.main}>
          {saveError ? (
            <div className={styles.saveError} role="alert">
              <span>{t('sessionSaveFailed')}</span>
              <Button
                variant="outlined"
                size="s"
                disabled={importingHistory}
                onClick={retrySaveSessions}
              >
                {t('retry')}
              </Button>
            </div>
          ) : null}
          {draftSaveError || draftRecoveryWarning ? (
            <div className={styles.saveError} role="alert">
              <span>
                {t(
                  draftSaveError
                    ? draftsReady
                      ? 'draftSaveFailed'
                      : 'draftLoadFailed'
                    : 'draftRecoveryWarning'
                )}
              </span>
              <Button
                variant="outlined"
                size="s"
                onClick={() => {
                  if (draftSaveError) {
                    void (draftsReady ? flushDrafts() : initDrafts())
                  } else {
                    useDrafts.setState({ recoveryWarning: false })
                  }
                }}
              >
                {t(draftSaveError ? 'retry' : 'close')}
              </Button>
            </div>
          ) : null}
          <UpdateSafetyNotice />
          <div className={styles.content}>
            {siderCollapsed ? <CollapsedSider /> : null}
            {!ready || !draftsReady || (activeId !== null && !session) ? (
              <div className={styles.loadingView}>
                {isMobile ? <MobileHeader /> : null}
                <div className={styles.loadingState} role="status" aria-live="polite">
                  <span>
                    {(!ready ? initError : sessionLoadError)
                      ? t(!ready ? 'sessionListLoadFailed' : 'sessionLoadFailed')
                      : t('sessionLoading')}
                  </span>
                  {(!ready ? initError : sessionLoadError) ? (
                    <Button
                      variant="outlined"
                      size="m"
                      onClick={() => {
                        if (!ready) {
                          void initChat()
                        } else if (activeId !== null) {
                          selectSession(activeId)
                        }
                      }}
                    >
                      {t('retry')}
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : session ? (
              <SessionView
                session={session}
                streaming={streaming}
                siderCollapsed={siderCollapsed}
              />
            ) : (
              <Welcome />
            )}
          </div>
        </main>
        <SearchPanel />
      </div>
      <SettingsDialog />
      <ApiUsageDialog />
      <HistorySearch />
      <BackupReminder />
      <Toast />
    </>
  )
}
