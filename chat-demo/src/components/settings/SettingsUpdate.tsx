import { useEffect, useState } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { compareVersions } from '../../services/update.js'
import {
  continueUpdateInstall,
  installReadyUpdate,
  requestUpdateInstall,
  useUpdateBlockReason,
  useUpdateSafety,
} from '../../services/updateSafety.js'
import {
  checkUpdateAvailable,
  refreshInstalledVersion,
  useUpdateNotice,
} from '../../services/updateWatcher.js'
import { canInstallInApp, isDownloadedUpdateReady } from '../../shell/installer.js'
import { openExternal } from '../../shell/native.js'
import { Button } from '../base/Button.js'
import { IconChevronRightOutline14 } from '../base/icons.js'
import { Modal, ModalPresence } from '../base/Modal.js'
import { SettingsIcon } from './SettingsIcon.js'
import rows from './Settings.module.css'
import styles from './SettingsUpdate.module.css'

export const SettingsUpdate = ({ mobile = false }: { mobile?: boolean }) => {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const version = useUpdateNotice((state) => state.version)
  const available = useUpdateNotice((state) => state.available)
  const resumePanel = useUpdateSafety((state) => state.resumePanel)
  useEffect(() => {
    refreshInstalledVersion()
    if (resumePanel) {
      useUpdateSafety.setState({ resumePanel: false })
      setOpen(true)
    }
  }, [resumePanel])
  return (
    <>
      <button
        type="button"
        data-update-entry
        className={mobile ? rows.row : styles.desktopEntry}
        onClick={() => {
          setOpen(true)
          void checkUpdateAvailable(true)
        }}
      >
        {mobile && (
          <span aria-hidden="true" className={rows.rowIcon}>
            <SettingsIcon name="info" />
          </span>
        )}
        <span className={mobile ? rows.rowLabel : styles.label}>{t('checkUpdate')}</span>
        <span className={styles.version}>
          {available && <span aria-hidden="true" data-update-dot className={styles.dot} />}
          {available ? t('updateAvailable', { version: `v${available.version}` }) : `v${version}`}
        </span>
        <span className={mobile ? rows.rowChevron : undefined} aria-hidden="true">
          <IconChevronRightOutline14 />
        </span>
      </button>
      <ModalPresence>
        {open && <UpdatePanel mobile={mobile} onClose={() => setOpen(false)} />}
      </ModalPresence>
    </>
  )
}

const UpdatePanel = ({ mobile, onClose }: { mobile: boolean; onClose: () => void }) => {
  const t = useTranslate()
  const { version, available, latest, checking, checked, failed } = useUpdateNotice()
  const { status, pending, target, working, progress, error, completed } = useUpdateSafety()
  const reason = useUpdateBlockReason()
  const active = status !== 'idle' && (!target || compareVersions(target, version) > 0)
  const release = active && pending ? pending : available
  const releaseVersion = active && target ? target : release?.version
  const notes = release?.version === releaseVersion ? release : null
  const installed = completed === version && !!version
  let state: string = status
  if (!active) {
    if (available) {
      state = 'available'
    } else if (installed) {
      state = 'latest'
    } else if (checking || (!checked && !failed)) {
      state = 'checking'
    } else if (failed) {
      state = 'check-error'
    } else {
      state = latest ? 'latest' : 'no-release'
    }
  }
  const messages: Record<string, TranslationKey> = {
    'check-error': 'updateFailed',
    checking: 'updateChecking',
    latest: 'updateLatest',
    'no-release': 'updateNoRelease',
    waiting: 'updateCanContinue',
    permission: 'updatePermission',
    downloading: 'updateAwaitDownload',
    failed: 'updateDownloadFailed',
    ready: 'updateReadySafe',
    installing: 'updateInstalling',
  }
  let message = messages[state] ? t(messages[state]) : ''
  if (active && error) {
    message = t(error)
  }
  if ((state === 'waiting' || state === 'ready') && reason) {
    message = t('updateWaiting', { reason: t(reason) })
  }
  if (installed && state === 'latest') {
    message = t('updateInstalled', { version })
  }
  const nativeDownload = !!release?.apkUrl && canInstallInApp()
  const action = (() => {
    if (state === 'ready' || (state === 'permission' && isDownloadedUpdateReady())) {
      return { label: 'updateInstall', run: () => installReadyUpdate(true) } as const
    }
    if ((state === 'failed' || state === 'permission' || state === 'waiting') && pending) {
      return {
        label: state === 'failed' ? 'retry' : 'updateContinue',
        run: continueUpdateInstall,
      } as const
    }
    if (
      (state === 'available' || state === 'failed') &&
      release &&
      (nativeDownload || release.pageUrl)
    ) {
      return {
        label: nativeDownload ? 'updateGetApk' : 'updateOpenRelease',
        run: () => requestUpdateInstall(release),
      } as const
    }
    if (state === 'check-error' || state === 'failed') {
      return { label: 'retry', run: () => checkUpdateAvailable(true) } as const
    }
    return null
  })()
  const blocked = reason !== null && (state === 'waiting' || state === 'ready')
  const percent =
    progress && progress.total > 0
      ? Math.min(100, Math.floor((progress.received * 100) / progress.total))
      : undefined
  return (
    <Modal
      title={t('checkUpdate')}
      placement={mobile ? 'bottom' : 'center'}
      closable
      onClose={onClose}
      footer={
        <>
          <Button variant="outlined" size="m" onClick={onClose}>
            {t('close')}
          </Button>
          {action && (
            <Button
              data-update-action
              size="m"
              disabled={working || blocked}
              onClick={() => void action.run()}
            >
              {t(action.label)}
            </Button>
          )}
        </>
      }
    >
      <div className={styles.panel} data-update-panel data-update-state={state}>
        <p data-update-current>{t('updateCurrent', { version })}</p>
        {releaseVersion && (
          <section>
            <h3>{t('updateAvailable', { version: `v${releaseVersion}` })}</h3>
            <p className={styles.notes}>{notes?.notes.trim() || t('updateNotesEmpty')}</p>
          </section>
        )}
        {message && <p role="status">{message}</p>}
        {state === 'downloading' && (
          <div className={styles.progress}>
            <progress aria-label={t('updateAwaitDownload')} max={100} value={percent} />
            {percent !== undefined ? (
              <span>{percent}%</span>
            ) : (
              progress && <span>{(progress.received / 1048576).toFixed(1)} MB</span>
            )}
          </div>
        )}
        {nativeDownload && notes?.pageUrl && (
          <button
            type="button"
            className={styles.link}
            onClick={() => void openExternal(notes.pageUrl)}
          >
            {t('updateOpenRelease')}
          </button>
        )}
      </div>
    </Modal>
  )
}
