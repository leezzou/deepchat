import type { ShareDocument } from './content.js'

// All positions are logical pixels. A bounded 2× canvas keeps Android bitmap allocations small.
const WIDTH = 440
const PAD = 24
const SCALE = 2
const MAX_HEIGHT = 4032
const sans = 'system-ui, -apple-system, "PingFang SC", "Noto Sans CJK SC", sans-serif'
const mono = 'ui-monospace, "SFMono-Regular", Consolas, "Noto Sans Mono", monospace'
const styles = {
  title: { font: `600 23px ${sans}`, height: 34, color: '#17202d' },
  role: { font: `600 15px ${sans}`, height: 26, color: '#284f91' },
  body: { font: `400 17px ${sans}`, height: 28, color: '#19212b' },
  heading: { font: `600 19px ${sans}`, height: 30, color: '#19212b' },
  code: { font: `400 15px ${mono}`, height: 23, color: '#253a51' },
  caption: { font: `500 13px ${sans}`, height: 23, color: '#4b596b' },
}
type Kind = keyof typeof styles
type Line = { text: string; kind: Kind; top: number; inset: number; code: boolean }
type Page = { lines: Line[]; height: number }
const segmenter =
  typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null

/** Preserve spaces and complete graphemes (including emoji) when code/URLs must wrap. */
const wrap = (ctx: CanvasRenderingContext2D, text: string, width: number): string[] => {
  if (ctx.measureText(text).width <= width) {
    return [text]
  }
  const result: string[] = []
  let current = ''
  for (const match of text.matchAll(
    /[\p{Script=Latin}\p{Number}_]+|[ \t]+|[^\p{Script=Latin}\p{Number}_ \t]+/gu
  )) {
    const token = match[0]
    if (ctx.measureText(current + token).width <= width) {
      current += token
      continue
    }
    // Keep short words together, but fill the available measure with CJK and long tokens.
    if (ctx.measureText(token).width <= width && /^[\p{Script=Latin}\p{Number}_]+$/u.test(token)) {
      if (current) {
        result.push(current)
      }
      current = token
      continue
    }
    const glyphs: Iterable<string> = segmenter
      ? (function* () {
          for (const item of segmenter.segment(token)) {
            yield item.segment
          }
        })()
      : token
    for (const glyph of glyphs) {
      if (current && ctx.measureText(current + glyph).width > width) {
        result.push(current)
        current = ''
      }
      current += glyph
    }
  }
  if (current) {
    result.push(current)
  }
  return result
}

function layout(ctx: CanvasRenderingContext2D, doc: ShareDocument) {
  const pages: Page[] = []
  let lines: Line[] = []
  let top = PAD
  const finish = () => {
    if (lines.length) {
      pages.push({ lines, height: Math.ceil(top + PAD) })
    }
    lines = []
    top = PAD
  }
  const text = (value: string, kind: Kind, code = false) => {
    ctx.font = styles[kind].font
    const inset = code ? 12 : 0
    const width = WIDTH - (PAD + inset) * 2
    for (const line of wrap(ctx, value, width)) {
      if (top + styles[kind].height + PAD > MAX_HEIGHT) {
        finish()
      }
      lines.push({ text: line, kind, top, inset, code })
      top += styles[kind].height
    }
  }
  const prose = (source: string) => {
    let fence: string | null = null
    for (const line of source.replace(/\r\n?/g, '\n').split('\n')) {
      const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
      if (fence) {
        if (
          delimiter &&
          delimiter[1][0] === fence[0] &&
          delimiter[1].length >= fence.length &&
          !delimiter[2].trim()
        ) {
          fence = null
          top += 7
        } else {
          text(line.replace(/\t/g, '    '), 'code', true)
        }
      } else if (delimiter) {
        fence = delimiter[1]
        top += 7
        text(delimiter[2].trim() || 'Code', 'caption', true)
      } else if (!line.trim()) {
        top = Math.min(top + 10, MAX_HEIGHT - PAD)
      } else {
        const heading = /^#{1,6}\s+(.+)$/.exec(line)
        text(
          heading ? heading[1] : line.replace(/^(\s*)[-*]\s+/, '$1• '),
          heading ? 'heading' : 'body'
        )
      }
    }
  }
  text(doc.title, 'title')
  for (const section of doc.sections) {
    top += 21
    text(section.role, 'role')
    top += 3
    if (section.thinking) {
      text(doc.thoughtLabel, 'caption')
      prose(section.thinking)
      top += 10
    }
    if (section.body) {
      prose(section.body)
    }
    if (section.attachments) {
      text(section.attachments, 'caption')
    }
  }
  finish()
  return pages
}

/** Preview and delivery share the very same encoded PNGs, independent of mounted message DOM. */
export async function renderShareImages(doc: ShareDocument, signal: AbortSignal): Promise<Blob[]> {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    throw new Error('Canvas unavailable')
  }
  const blobs: Blob[] = []
  const check = () => {
    if (signal.aborted) {
      throw new DOMException('Cancelled', 'AbortError')
    }
  }
  try {
    check()
    const pages = layout(ctx, doc)
    for (const page of pages) {
      check()
      canvas.width = WIDTH * SCALE
      canvas.height = (page.height + (pages.length > 1 ? 18 : 0)) * SCALE
      ctx.scale(SCALE, SCALE)
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, WIDTH, canvas.height / SCALE)
      ctx.textBaseline = 'middle'
      for (const line of page.lines) {
        const style = styles[line.kind]
        if (line.code) {
          ctx.fillStyle = '#f0f3f7'
          ctx.fillRect(PAD, line.top, WIDTH - PAD * 2, style.height)
        }
        ctx.font = style.font
        ctx.fillStyle = style.color
        ctx.fillText(line.text, PAD + line.inset, line.top + style.height / 2)
      }
      if (pages.length > 1) {
        ctx.fillStyle = styles.caption.color
        ctx.font = styles.caption.font
        ctx.fillText(`${blobs.length + 1} / ${pages.length}`, PAD, page.height)
      }
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (value) => (value ? resolve(value) : reject(new Error('PNG encoding failed'))),
          'image/png'
        )
      )
      blobs.push(blob)
    }
    check()
    return blobs
  } finally {
    canvas.width = canvas.height = 1
  }
}
