import type { ReactNode } from 'react'
import {
  IconDataOutline16, IconDownloadOutline16, IconGlobeLanguageOutline14, IconLightOutline16,
  IconPlusCircle24, IconSettingsOutline16, IconSpeakerWaves24, IconTrashOutline16, IconUploadOutline14,
} from '../base/icons.js'
import { LibraryIcon } from '../library/LibraryIcon.js'
import styles from './SettingsIcon.module.css'

const shared = {
  general: <IconSettingsOutline16 />,
  data: <IconDataOutline16 />,
  memory: <LibraryIcon name="memory" />,
  language: <IconGlobeLanguageOutline14 />,
  appearance: <IconLightOutline16 />,
  voice: <IconSpeakerWaves24 />,
  add: <IconPlusCircle24 />,
  import: <IconUploadOutline14 />,
  download: <IconDownloadOutline16 />,
  delete: <IconTrashOutline16 />,
} satisfies Record<string, ReactNode>

// Match the rounded strokes and monochrome silhouettes of the product's outline icons.
const drawings = {
  work: <><rect x="3.1" y="7.4" width="17.8" height="13" rx="2.6" /><path d="M8.5 7.4V5.9a2.1 2.1 0 0 1 2.1-2.1h2.8a2.1 2.1 0 0 1 2.1 2.1v1.5m-12.4 5.2a19.8 19.8 0 0 0 17.8 0M12 13.6v2" /></>,
  account: <><circle cx="12" cy="7.2" r="3.7" /><path d="M4.5 20c.6-4.1 3.1-6.2 7.5-6.2s6.9 2.1 7.5 6.2" /></>,
  profile: <><rect x="2.7" y="4.7" width="18.6" height="14.6" rx="2.8" /><circle cx="8.6" cy="10.1" r="1.9" /><path d="M5.6 15.3a3.1 3.1 0 0 1 6.1 0m2.4-5.4h3.7m-3.7 4h2.6" /></>,
  source: <path d="M3.5 7.5h11.8l-3-3m3 3-3 3m8.2 6h-12l3 3m-3-3 3-3" />,
  key: <><circle cx="8" cy="8" r="4.6" /><path d="m11.4 11.4 8.6 8.5m-5.6-5.4 2.1-2.1m1 5.1 2.1-2.1" /></>,
  lock: <><rect x="4.8" y="10" width="14.4" height="11" rx="3" /><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2" /></>,
  fontSize: <path d="m2.4 17.7 3-8.2 3 8.2m-4.8-2.4h3.6m4.6 2.4 4.5-12 4.6 12m-7.4-3.5h5.6" />,
  personalize: <path d="m10.7 3.7 2.2 3.8 4.3.8-2.9 3.3.5 4.4-4.1-1.8L6.8 16l.3-4.4-3-3.2 4.3-.9 2.3-3.8Zm4.6 11.6 5.1 5.1" />,
  info: <><circle cx="12" cy="12" r="8.4" /><path d="M12 11.4v5m0-8.7v.2" /></>,
  help: <><circle cx="12" cy="12" r="8.4" /><path d="M9.6 9.4a2.5 2.5 0 0 1 4.9.6c0 1.7-2.4 1.8-2.4 3.4v.3m0 3v.2" /></>,
  signOut: <path d="M11.4 4.2H6a2.5 2.5 0 0 0-2.5 2.5v10.6A2.5 2.5 0 0 0 6 19.8h5.4m-2.1-7.8h11m-4.1-4.1 4.1 4.1-4.1 4.1" />,
  guide: <path d="M12 6.3c-2.3-1.7-5.4-2.2-9-1.5v13.1c3.6-.7 6.7-.2 9 1.5 2.3-1.7 5.4-2.2 9-1.5V4.8c-3.6-.7-6.7-.2-9 1.5Zm0 0v13" />,
  usage: <><rect x="3" y="3" width="18" height="18" rx="4" /><path d="M7.5 16v-4m4.5 4V7.5m4.5 8.5v-6" /></>,
  platform: <><rect x="2.7" y="4.2" width="18.6" height="15.6" rx="2.6" /><path d="M3 9h18M6.4 6.6h.1" /></>,
  wallet: <><path d="M19 7V4.3L5.5 6.8A2.5 2.5 0 0 0 3.5 9.3V17a2.5 2.5 0 0 0 2.5 2.5h13a1.8 1.8 0 0 0 1.8-1.8V9.2A2.2 2.2 0 0 0 18.6 7H5.8m14.8 4.3H17a2 2 0 1 0 0 4h3.6" /></>,
  cloud: <path d="M7.3 17.5H7a4 4 0 0 1-.7-7.9 5.8 5.8 0 0 1 11.4-1.1 4.6 4.6 0 0 1 .2 9.1h-1.2M12 20V10.8m-3.1 3.1 3.1-3.1 3.1 3.1" />,
  summaries: <path d="M4.1 3.9h11.2a2.1 2.1 0 0 1 2.1 2.1v9.3H8l-4.9 3V5a1.1 1.1 0 0 1 1-1.1Zm2.7 4.2h6.4m-6.4 3.2h4.5m9.4-3.4v10.5H14l-3.7 2.1" />,
  location: <><path d="M12 21s6.5-5.5 6.5-11a6.5 6.5 0 1 0-13 0C5.5 15.5 12 21 12 21Z" /><circle cx="12" cy="10" r="2.3" /></>,
  province: <path d="m3.5 5.8 5.7-2.1 5.6 2.4 5.7-2.1v14.3l-5.7 2.1-5.6-2.4-5.7 2.1V5.8Zm5.7-2.1V18m5.6-11.9v14.3" />,
  city: <path d="M3 20h18m-16 0V8l7-3v15m0-10h6.9v10M8.5 10v.4m0 3v.4m7.1.3v.4" />,
} satisfies Record<string, ReactNode>

export type SettingsIconName = keyof typeof shared | keyof typeof drawings

export const SettingsIcon = ({ name, compact = false }: { name: SettingsIconName; compact?: boolean }) => (
  <span aria-hidden="true" data-settings-icon={name} className={compact ? styles.compact : styles.glyph}>
    {name in shared ? shared[name as keyof typeof shared] : (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" focusable="false">
        {drawings[name as keyof typeof drawings]}
      </svg>
    )}
  </span>
)
