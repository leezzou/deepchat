import { Fragment } from 'react'
import { findSearchMatches } from '../../services/chat/search.js'
import styles from './HistorySearch.module.css'

export const SearchHighlight = ({ text, query }: { text: string; query: string }) => {
  const matches = findSearchMatches(text, query.trim().replace(/\s+/g, ' '))
  let cursor = 0
  return (
    <>
      {matches.map(([start, end]) => {
        const before = text.slice(cursor, start)
        cursor = end
        return (
          <Fragment key={start}>
            {before}
            <mark className={styles.highlight}>{text.slice(start, end)}</mark>
          </Fragment>
        )
      })}
      {text.slice(cursor)}
    </>
  )
}
