import { findSearchMatches } from '../../services/chat/search.js'

/** Keep the target at its requested viewport position as images / rendered Markdown resize. */
export const keepMessageAnchored = (
  scroll: HTMLElement,
  content: HTMLElement,
  target: HTMLElement,
  onUserIntent: () => void
): (() => void) => {
  let active = true
  let frame = 0
  const align = () => {
    if (!active || !target.isConnected) {
      return
    }
    const delta = target.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 24
    if (Math.abs(delta) > 1) {
      scroll.scrollTop += delta
    }
  }
  const schedule = () => {
    if (!active || frame) {
      return
    }
    frame = requestAnimationFrame(() => {
      frame = 0
      align()
    })
  }
  const observer = new ResizeObserver(schedule)
  observer.observe(content)
  observer.observe(scroll)
  observer.observe(target)
  const stop = () => {
    if (!active) {
      return
    }
    active = false
    observer.disconnect()
    cancelAnimationFrame(frame)
    content.removeEventListener('load', schedule, true)
    content.removeEventListener('error', schedule, true)
    scroll.removeEventListener('wheel', release)
    scroll.removeEventListener('touchstart', release)
    scroll.removeEventListener('pointerdown', release)
    scroll.removeEventListener('keydown', keydown)
  }
  const release = () => {
    stop()
    onUserIntent()
  }
  const keydown = (event: KeyboardEvent) => {
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) {
      release()
    }
  }
  content.addEventListener('load', schedule, true)
  content.addEventListener('error', schedule, true)
  scroll.addEventListener('wheel', release, { passive: true })
  scroll.addEventListener('touchstart', release, { passive: true })
  scroll.addEventListener('pointerdown', release, { passive: true })
  scroll.addEventListener('keydown', keydown)
  align()
  return stop
}

type HighlightWindow = Window & { Highlight?: new (...ranges: Range[]) => unknown }
type HighlightCSS = typeof CSS & { highlights?: Map<string, unknown> }

/** CSS Highlights leave React's text nodes intact, including inline Markdown and code spans. */
export const highlightMessageText = (target: HTMLElement, query: string): (() => void) => {
  const Highlight = (window as HighlightWindow).Highlight
  const registry = (CSS as HighlightCSS).highlights
  if (!Highlight || !registry) {
    return () => {}
  }
  const nodes: Text[] = []
  const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest(
        'button, textarea, script, style, [aria-hidden="true"], [data-search-location-label]'
      )
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  })
  let node: Node | null
  while ((node = walker.nextNode())) {
    nodes.push(node as Text)
  }
  const text = nodes.map((item) => item.data).join('')
  const matches = findSearchMatches(text, query).slice(0, 500)
  const offsets: number[] = []
  let offset = 0
  for (const item of nodes) {
    offsets.push(offset)
    offset += item.length
  }
  const ranges = matches.flatMap(([start, end]) => {
    const first = nodes.findIndex((item, index) => offsets[index] + item.length > start)
    const last = nodes.findIndex((item, index) => offsets[index] + item.length >= end)
    if (first < 0 || last < 0) {
      return []
    }
    const range = document.createRange()
    range.setStart(nodes[first], start - offsets[first])
    range.setEnd(nodes[last], end - offsets[last])
    return [range]
  })
  const highlight = new Highlight(...ranges)
  registry.set('history-search', highlight)
  return () => {
    if (registry.get('history-search') === highlight) {
      registry.delete('history-search')
    }
  }
}
