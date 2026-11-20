import type { ShareDocument } from './content.js'
import { imageMarkdown, type Block, type Run } from './markdownImage.js'

export const WIDTH = 440
export const MAX_HEIGHT = 4032
const PAD = 24
const FOOTER = 18
const sans = 'system-ui, -apple-system, "PingFang SC", "Noto Sans CJK SC", sans-serif'
const mono = 'ui-monospace, "SFMono-Regular", Consolas, monospace'
const math = 'Cambria Math, STIX Two Math, Georgia, serif'
const segmenter =
  typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : undefined

type Face = { size: number; height: number; color: string; bold?: boolean; code?: boolean }
const body: Face = { size: 17, height: 28, color: '#19212b' }
const caption: Face = { size: 13, height: 23, color: '#4b596b' }
const code: Face = { size: 15, height: 24, color: '#253a51', code: true }
type Piece = { text: string; width: number; font: string; ink: Run }
type Text = Piece & { x: number; y: number; color: string; inlineCode?: boolean }
type Box = { x: number; y: number; w: number; h: number; color: string }
export type Page = { texts: Text[]; boxes: Box[]; height: number }
const fontFor = (run: Run, face: Face) =>
  `${run.italic ? 'italic ' : ''}${run.bold || face.bold ? '700' : '400'} ${run.code ? Math.min(15, face.size) : face.size}px ${run.code ? mono : run.math ? math : sans}`
const glyphs = function* (token: string) {
  if (segmenter) {
    for (const item of segmenter.segment(token)) {
      yield item.segment
    }
  } else {
    yield* token
  }
}

/** Wrap styled words across runs, preserve intentional line breaks, and split long tokens by grapheme. */
function wrap(ctx: CanvasRenderingContext2D, runs: Run[], face: Face, width: number): Piece[][] {
  const lines: Piece[][] = []
  let line: Piece[] = [],
    used = 0
  const finish = () => {
    lines.push(line)
    line = []
    used = 0
  }
  for (const ink of runs) {
    const font = fontFor(ink, face)
    ctx.font = font
    const add = (text: string, w: number) => {
      const prev = line.at(-1)
      if (prev?.ink === ink) {
        prev.text += text
        prev.width += w
      } else {
        line.push({ text, width: w, font, ink })
      }
      used += w
    }
    for (const [token] of ink.text
      .replace(/\r\n?/g, '\n')
      .replace(/\t/g, '    ')
      .matchAll(/\n|[^\S\n]+|[\p{Script=Latin}\p{N}_]+|[^\s\p{Script=Latin}\p{N}_]+/gu)) {
      if (token === '\n') {
        finish()
        continue
      }
      const w = ctx.measureText(token).width
      if (used + w <= width) {
        add(token, w)
        continue
      }
      if (w <= width && /^[\p{Script=Latin}\p{N}_]/u.test(token)) {
        finish()
        add(token, w)
        continue
      }
      for (const char of glyphs(token)) {
        const cw = ctx.measureText(char).width
        if (used && used + cw > width) {
          finish()
        }
        add(char, cw)
      }
    }
  }
  finish()
  return lines
}
type Flow = { x: number; quotes: number[]; marker?: { text: string; x: number } }
function indent(flow: Flow, delta: number) {
  return Math.min(flow.x + delta, WIDTH - PAD - 120)
}

export function layoutSharePages(ctx: CanvasRenderingContext2D, doc: ShareDocument): Page[] {
  const pages: Page[] = []
  let page: Page = { texts: [], boxes: [], height: 0 },
    y = PAD
  const finish = () => {
    page.height = Math.min(MAX_HEIGHT - FOOTER, Math.ceil(y + PAD))
    pages.push(page)
    page = { texts: [], boxes: [], height: 0 }
    y = PAD
  }
  const gap = (value: number) => {
    y = Math.min(y + value, MAX_HEIGHT - PAD - FOOTER)
  }
  const strip = (height: number, flow: Flow) => {
    if (y + height + PAD + FOOTER > MAX_HEIGHT) {
      finish()
    }
    const top = y
    y += height
    for (const x of flow.quotes) {
      page.boxes.push({ x, y: top, w: 3, h: height, color: '#98a6b8' })
    }
    if (flow.marker) {
      const marker = flow.marker
      delete flow.marker
      const ink = { text: marker.text },
        font = fontFor(ink, body)
      page.texts.push({
        text: marker.text,
        font,
        ink,
        width: 0,
        x: marker.x,
        y: top + height / 2,
        color: '#284f91',
      })
    }
    return top
  }
  const place = (pieces: Piece[], face: Face, x: number, top: number) => {
    for (const p of pieces) {
      page.texts.push({
        ...p,
        x,
        y: top + face.height / 2,
        color: p.ink.link ? '#245da6' : face.color,
        inlineCode: p.ink.code && !face.code,
      })
      x += p.width
    }
  }
  const paragraph = (runs: Run[], face: Face, flow: Flow, panel?: string) => {
    const inset = panel ? 9 : 0,
      width = WIDTH - PAD - flow.x
    for (const line of wrap(ctx, runs, face, width - inset * 2)) {
      const top = strip(face.height, flow)
      if (panel) {
        page.boxes.push({ x: flow.x, y: top, w: width, h: face.height, color: panel })
      }
      place(line, face, flow.x + inset, top)
    }
  }
  const table = (block: Extract<Block, { type: 'table' }>, flow: Flow) => {
    const width = WIDTH - PAD - flow.x
    const n = block.rows.reduce((max, row) => Math.max(max, row.length), 0)
    if (!n) {
      return
    }
    // Keep narrow columns legible. Wider tables are split into panels with a repeating first column.
    const capacity = Math.max(2, Math.min(4, Math.floor(width / 76)))
    for (let from = 1; from < Math.max(2, n); from += capacity - 1) {
      const ids = [
        0,
        ...Array.from({ length: Math.min(capacity - 1, n - from) }, (_, i) => from + i),
      ]
      const col = width / ids.length
      block.rows.forEach((row, rowIndex) => {
        const head = rowIndex === 0
        const face = { ...body, size: 14, height: 23, bold: head }
        const cells = ids.map((id) => wrap(ctx, row[id] ?? [], face, col - 12))
        const height = Math.max(...cells.map((lines) => lines.length))
        for (let lineIndex = 0; lineIndex < height; lineIndex++) {
          const top = strip(face.height, flow)
          page.boxes.push({
            x: flow.x,
            y: top,
            w: width,
            h: face.height,
            color: head ? '#e8eef5' : '#ffffff',
          })
          ids.forEach((id, i) => {
            const x = flow.x + col * i
            page.boxes.push({ x, y: top, w: 1, h: face.height, color: '#cdd5df' })
            const line = cells[i][lineIndex] ?? [],
              available = col - 12 - line.reduce((w, p) => w + p.width, 0)
            const align = block.align[id]
            place(
              line,
              face,
              x + 6 + (align === 'right' ? available : align === 'center' ? available / 2 : 0),
              top
            )
          })
          page.boxes.push({ x: flow.x + width - 1, y: top, w: 1, h: face.height, color: '#cdd5df' })
          if (lineIndex === height - 1) {
            page.boxes.push({
              x: flow.x,
              y: top + face.height - 1,
              w: width,
              h: 1,
              color: '#cdd5df',
            })
          }
        }
      })
      gap(5)
    }
  }
  function blocks(items: Block[], flow: Flow) {
    for (const b of items) {
      if (flow.marker && (b.type === 'list' || b.type === 'quote')) {
        strip(body.height, flow)
      }
      switch (b.type) {
        case 'paragraph': {
          const face = b.heading
            ? {
                ...body,
                bold: true,
                size: Math.max(17, 25 - b.heading * 1.5),
                height: Math.max(28, 35 - b.heading),
              }
            : b.code
              ? code
              : body
          paragraph(b.runs, face, flow, b.code ? '#f0f3f7' : b.math ? '#f6f7fa' : undefined)
          break
        }
        case 'quote':
          blocks(b.blocks, { x: indent(flow, 14), quotes: [...flow.quotes, flow.x] })
          break
        case 'rule': {
          const top = strip(14, flow)
          page.boxes.push({
            x: flow.x,
            y: top + 7,
            w: WIDTH - PAD - flow.x,
            h: 1.5,
            color: '#abb6c5',
          })
          break
        }
        case 'list':
          for (const item of b.items) {
            ctx.font = fontFor({ text: item.marker }, body)
            const nested: Flow = {
              ...flow,
              x: indent(flow, Math.max(20, ctx.measureText(item.marker).width + 7)),
              marker: { text: item.marker, x: flow.x },
            }
            if (!item.blocks.length) {
              strip(body.height, nested)
            } else {
              blocks(item.blocks, nested)
            }
          }
          break
        case 'table':
          table(b, flow)
          break
      }
      gap(5)
    }
  }
  const root: Flow = { x: PAD, quotes: [] }
  paragraph([{ text: doc.title }], { ...body, size: 23, bold: true, height: 34 }, root)
  for (const section of doc.sections) {
    gap(15)
    paragraph(
      [{ text: section.role }],
      { size: 15, height: 26, bold: true, color: '#284f91' },
      root
    )
    if (section.thinking) {
      paragraph([{ text: doc.thoughtLabel }], caption, root)
      blocks(imageMarkdown(section.thinking), root)
      gap(7)
    }
    const text = section.imageBody ?? section.body
    if (section.plainBody) {
      paragraph([{ text }], body, root)
    } else if (text) {
      blocks(imageMarkdown(text, section.citationIndices), root)
    }
    if (section.attachments) {
      paragraph([{ text: section.attachments }], caption, root)
    }
  }
  finish()
  if (pages.length > 1) {
    for (const p of pages) {
      p.height += FOOTER
    }
  }
  return pages
}
