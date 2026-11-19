import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { revealMessage, useChatStore } from '../../services/chat/store.js'
import { removeFavorite, type Favorite } from '../../services/library/index.js'
import { useLibrarySnapshot } from '../../services/library/useLibrary.js'
import { IconButton } from '../base/IconButton.js'
import { IconCloseOutline16 } from '../base/icons.js'
import { showToast } from '../base/toastState.js'
import { locateHistoryMessage } from '../historySearch/historySearchState.js'
import { captureChatOrigin, rememberChat } from '../sider/mobileSiderState.js'
import './library.css'

export const Favorites = ({ visible }: { visible: boolean }) => {
  const t = useTranslate()
  const { favorites } = useLibrarySnapshot()
  const sessions = useChatStore((state) => state.sessions)
  const sessionById = useMemo(() => new Map(sessions.map((row) => [row.id, row])), [sessions])
  const importing = useChatStore((state) => state.importingHistory)
  const pending = useRef<AbortController | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!visible) {
      pending.current?.abort()
    }
    return () => pending.current?.abort()
  }, [visible])
  const open = async (favorite: Favorite) => {
    if (pending.current || importing) {
      return
    }
    const origin = captureChatOrigin()
    const navigation = new AbortController()
    pending.current = navigation
    setBusy(true)
    setError('')
    try {
      const { sessionId, messageId, excerpt } = favorite
      const status = await revealMessage(sessionId, messageId, navigation.signal)
      if (navigation.signal.aborted) {
        return
      }
      if (status !== 'ok') {
        setError(
          t(
            status === 'busy'
              ? 'historySearchBusy'
              : status === 'missing'
                ? 'historySearchMissing'
                : 'historySearchOpenFailed'
          )
        )
        return
      }
      rememberChat(origin)
      locateHistoryMessage({
        sessionId,
        messageId,
        query: '',
        snippet: { text: excerpt, before: false, after: false },
      })
    } catch {
      if (!navigation.signal.aborted) {
        setError(t('historySearchOpenFailed'))
      }
    } finally {
      pending.current = null
      setBusy(false)
    }
  }
  return (
    <section className="lib-favorites" aria-label={t('libFavorites')}>
      <h3 className="lib-favorites-heading">
        {t('libFavorites')}
        <span>{favorites.length}</span>
      </h3>
      {error && (
        <p role="alert" className="lib-note">
          {error}
        </p>
      )}
      {!favorites.length && <p className="lib-note">{t('libFavoriteEmpty')}</p>}
      <ul className="lib-rows">
        {favorites.map((favorite) => {
          const session = sessionById.get(favorite.sessionId)
          return (
            <li key={JSON.stringify([favorite.sessionId, favorite.messageId])} className="lib-row">
              <button
                className="lib-result"
                type="button"
                disabled={busy || importing || !session}
                onClick={() => void open(favorite)}
              >
                <small>
                  {session ? session.title || t('untitledChat') : t('libMissingSession')}
                </small>
                <span>{favorite.excerpt || t('libFavoriteReply')}</span>
              </button>
              <IconButton
                icon={<IconCloseOutline16 />}
                aria-label={t('libFavoriteRemove')}
                onClick={() => {
                  try {
                    removeFavorite(favorite.sessionId, favorite.messageId)
                  } catch {
                    showToast({ key: 'libSaveError', type: 'error' })
                  }
                }}
              />
            </li>
          )
        })}
      </ul>
    </section>
  )
}
