import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslate } from '../../i18n/index.js'
import { loadSession } from '../../services/chat/db.js'
import { searchHistory, type HistorySearchResult } from '../../services/chat/search.js'
import { revealMessage, selectSession, useChatStore } from '../../services/chat/store.js'
import { isNative, popLayer, pushLayer } from '../../shell/native.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { IconCloseOutline16, IconSearchOutline16 } from '../base/icons.js'
import { closeMobileSider } from '../sider/mobileSiderState.js'
import { SearchHighlight } from './SearchHighlight.js'
import {
  clearHistoryLocation,
  closeHistorySearch,
  locateHistoryMessage,
  useHistorySearch,
} from './historySearchState.js'
import styles from './HistorySearch.module.css'

type SearchState = {
  results: HistorySearchResult[]
  scanned: number
  total: number
  failed: number
  loading: boolean
  done: boolean
  error: boolean
}
const emptyState = (): SearchState => ({
  results: [],
  scanned: 0,
  total: 0,
  failed: 0,
  loading: false,
  done: false,
  error: false,
})

const SearchDialog = () => {
  const t = useTranslate()
  const sessions = useChatStore((state) => state.sessions)
  const importing = useChatStore((state) => state.importingHistory)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [composing, setComposing] = useState(false)
  const [retry, setRetry] = useState(0)
  const [state, setState] = useState(emptyState)
  const [opening, setOpening] = useState<string | null>(null)
  const [openError, setOpenError] = useState<string | null>(null)
  const searchRef = useRef<{
    controller: AbortController
    iterator: ReturnType<typeof searchHistory>
    reading: boolean
  } | null>(null)
  const mounted = useRef(true)
  const openingRef = useRef(false)
  const navigationRef = useRef<AbortController | null>(null)

  useEffect(() => {
    mounted.current = true
    closeMobileSider()
    const dialog = dialogRef.current
    dialog?.showModal()
    inputRef.current?.focus()
    const layer = pushLayer(closeHistorySearch)
    const marker = `history-search-${Date.now()}`
    const onBack = () => closeHistorySearch()
    if (!isNative) {
      window.history.pushState({ ...window.history.state, historySearch: marker }, '')
      window.addEventListener('popstate', onBack)
    }
    const updateViewport = () => {
      const viewport = window.visualViewport
      dialog?.style.setProperty('--search-height', `${viewport?.height ?? window.innerHeight}px`)
      dialog?.style.setProperty('--search-top', `${viewport?.offsetTop ?? 0}px`)
    }
    updateViewport()
    window.visualViewport?.addEventListener('resize', updateViewport)
    window.visualViewport?.addEventListener('scroll', updateViewport)
    return () => {
      mounted.current = false
      navigationRef.current?.abort()
      popLayer(layer)
      window.removeEventListener('popstate', onBack)
      window.visualViewport?.removeEventListener('resize', updateViewport)
      window.visualViewport?.removeEventListener('scroll', updateViewport)
      dialog?.close()
      if (!isNative && window.history.state?.historySearch === marker) {
        window.history.back()
      }
    }
  }, [])

  const readPage = async () => {
    const search = searchRef.current
    if (!search || search.reading || search.controller.signal.aborted) {
      return
    }
    search.reading = true
    setState((previous) => ({ ...previous, loading: true, error: false }))
    let count = 0
    try {
      while (count < 40) {
        const batch = await search.iterator.next()
        if (search.controller.signal.aborted || searchRef.current !== search) {
          return
        }
        if (batch.done) {
          setState((previous) => ({ ...previous, loading: false, done: true }))
          return
        }
        count += batch.value.results.length
        const { results, scanned, total, failed } = batch.value
        setState((previous) => ({
          ...previous,
          results: [...previous.results, ...results],
          scanned,
          total,
          failed,
        }))
      }
    } catch {
      if (!search.controller.signal.aborted && searchRef.current === search) {
        setState((previous) => ({ ...previous, error: true }))
      }
    } finally {
      search.reading = false
      if (!search.controller.signal.aborted && searchRef.current === search) {
        setState((previous) => ({ ...previous, loading: false }))
      }
    }
  }

  useEffect(() => {
    setState(emptyState())
    setOpenError(null)
    if (!query.trim() || composing || importing) {
      return
    }
    const controller = new AbortController()
    const search = {
      controller,
      reading: false,
      iterator: searchHistory({
        sessions,
        query,
        signal: controller.signal,
        readSession: async (id) => {
          const cache = useChatStore.getState().sessionCache
          return Object.hasOwn(cache, id) ? cache[id] : loadSession(id)
        },
      }),
    }
    searchRef.current = search
    setState((previous) => ({ ...previous, loading: true }))
    const timer = setTimeout(() => {
      void readPage()
    }, 180)
    return () => {
      clearTimeout(timer)
      controller.abort()
      void search.iterator.return(undefined).catch(() => {})
      if (searchRef.current === search) {
        searchRef.current = null
      }
    }
  }, [query, sessions, composing, importing, retry])

  const openResult = async (result: HistorySearchResult) => {
    if (openingRef.current || importing) {
      return
    }
    openingRef.current = true
    const key = JSON.stringify([result.sessionId, result.messageId])
    setOpening(key)
    setOpenError(null)
    try {
      if (!result.messageId) {
        if (!useChatStore.getState().sessions.some((session) => session.id === result.sessionId)) {
          setOpenError(t('historySearchMissing'))
          return
        }
        clearHistoryLocation()
        selectSession(result.sessionId)
        closeHistorySearch()
        return
      }
      const navigation = new AbortController()
      navigationRef.current = navigation
      const status = await revealMessage(result.sessionId, result.messageId, navigation.signal)
      if (!mounted.current) {
        return
      }
      if (status !== 'ok') {
        setOpenError(
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
      dialogRef.current?.close()
      locateHistoryMessage({
        sessionId: result.sessionId,
        messageId: result.messageId,
        query,
        snippet: result.snippet,
      })
      closeHistorySearch()
    } catch {
      if (mounted.current) {
        setOpenError(t('historySearchOpenFailed'))
      }
    } finally {
      openingRef.current = false
      if (mounted.current) {
        setOpening(null)
      }
    }
  }

  return createPortal(
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      aria-labelledby="history-search-title"
      onCancel={(event) => {
        event.preventDefault()
        closeHistorySearch()
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) {
          return
        }
        const bounds = event.currentTarget.getBoundingClientRect()
        if (
          event.clientX < bounds.left ||
          event.clientX > bounds.right ||
          event.clientY < bounds.top ||
          event.clientY > bounds.bottom
        ) {
          closeHistorySearch()
        }
      }}
    >
      <div className={styles.header}>
        <h2 id="history-search-title" className={styles.title}>
          {t('historySearch')}
        </h2>
        <IconButton
          className={styles.close}
          icon={<IconCloseOutline16 />}
          aria-label={t('close')}
          onClick={closeHistorySearch}
        />
      </div>
      <div className={styles.inputWrap}>
        <IconSearchOutline16 />
        <input
          ref={inputRef}
          type="search"
          className={styles.input}
          value={query}
          disabled={opening !== null}
          placeholder={t('historySearchPlaceholder')}
          aria-label={t('historySearch')}
          enterKeyHint="search"
          autoComplete="off"
          onChange={(event) => setQuery(event.target.value)}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => setComposing(false)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              inputRef.current?.blur()
            }
          }}
        />
      </div>
      <div className={styles.results} aria-busy={state.loading}>
        {!query.trim() ? <p className={styles.empty}>{t('historySearchHint')}</p> : null}
        {query.trim() && !state.loading && state.done && !state.results.length && !state.failed ? (
          <p className={styles.empty}>{t('historySearchEmpty')}</p>
        ) : null}
        <ul className={styles.list}>
          {state.results.map((result) => {
            const key = JSON.stringify([result.sessionId, result.messageId])
            return (
              <li key={key}>
                <button
                  type="button"
                  className={styles.result}
                  disabled={opening !== null || importing}
                  onClick={() => {
                    void openResult(result)
                  }}
                >
                  <span className={styles.resultTitle}>
                    <SearchHighlight text={result.title || t('untitledChat')} query={query} />
                  </span>
                  <span className={styles.meta}>
                    <span>
                      {t(
                        result.role === 'user'
                          ? 'historySearchUser'
                          : result.role === 'assistant'
                            ? 'historySearchAssistant'
                            : 'historySearchTitle'
                      )}
                    </span>
                    {result.alternateBranch ? <span>{t('historySearchBranch')}</span> : null}
                    <time dateTime={new Date(result.createdAt).toISOString()}>
                      {new Date(result.createdAt).toLocaleDateString()}
                    </time>
                  </span>
                  <span className={styles.snippet}>
                    {result.snippet.before ? '…' : ''}
                    <SearchHighlight text={result.snippet.text} query={query} />
                    {result.snippet.after ? '…' : ''}
                  </span>
                  {opening === key ? (
                    <span className={styles.meta}>{t('historySearchOpening')}</span>
                  ) : null}
                </button>
              </li>
            )
          })}
        </ul>
        {state.error || state.failed > 0 || openError ? (
          <div className={styles.error} role="alert">
            <span>
              {openError ??
                (state.error
                  ? t('historySearchFailed')
                  : t('historySearchPartialError', { count: state.failed }))}
            </span>
            {!openError ? (
              <Button size="s" variant="outlined" onClick={() => setRetry((value) => value + 1)}>
                {t('retry')}
              </Button>
            ) : null}
          </div>
        ) : null}
        {query.trim() ? (
          <div className={styles.status} role="status" aria-live="polite">
            <span>
              {state.loading
                ? t('historySearchSearching')
                : t('historySearchResults', { count: state.results.length })}
            </span>
            {state.total > 0 ? (
              <span>
                {t('historySearchProgress', { scanned: state.scanned, total: state.total })}
              </span>
            ) : null}
          </div>
        ) : null}
        {!state.loading && !state.done && !state.error && state.results.length > 0 ? (
          <div className={styles.more}>
            <Button
              variant="outlined"
              onClick={() => {
                void readPage()
              }}
            >
              {t('historySearchMore')}
            </Button>
          </div>
        ) : null}
      </div>
    </dialog>,
    document.body
  )
}

/** Mount once at App level so opening search survives sidebar / viewport changes. */
export const HistorySearch = () => {
  const open = useHistorySearch((state) => state.open)
  return open ? <SearchDialog /> : null
}
