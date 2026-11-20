import type { ShareDocument } from './content.js'
import { layoutSharePages, WIDTH, type Page } from './layoutImage.js'

const SCALE = 2
function paint(ctx: CanvasRenderingContext2D, page: Page, index: number, total: number) {
  ctx.scale(SCALE, SCALE)
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, WIDTH, page.height)
  for (const box of page.boxes) {
    ctx.fillStyle = box.color
    ctx.fillRect(box.x, box.y, box.w, box.h)
  }
  ctx.textBaseline = 'middle'
  for (const run of page.texts) {
    if (run.inlineCode) {
      ctx.fillStyle = '#edf1f6'
      ctx.fillRect(run.x, run.y - 10, run.width, 20)
    }
    ctx.font = run.font
    ctx.fillStyle = run.color
    ctx.fillText(run.text, run.x, run.y)
    if (run.ink.link) {
      ctx.fillRect(run.x, run.y + 8, run.width, 1)
    }
    if (run.ink.strike) {
      ctx.fillRect(run.x, run.y, run.width, 1)
    }
  }
  if (total > 1) {
    ctx.fillStyle = '#4b596b'
    ctx.font = '13px system-ui, sans-serif'
    ctx.fillText(`${index + 1} / ${total}`, 24, page.height - 18)
  }
}

/** Preview and delivery share the same encoded PNGs. The only drawing source is the local AST. */
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
    const pages = layoutSharePages(ctx, doc)
    for (const [index, page] of pages.entries()) {
      check()
      canvas.width = WIDTH * SCALE
      canvas.height = page.height * SCALE
      paint(ctx, page, index, pages.length)
      blobs.push(
        await new Promise<Blob>((resolve, reject) =>
          canvas.toBlob(
            (value) => (value ? resolve(value) : reject(new Error('PNG encoding failed'))),
            'image/png'
          )
        )
      )
    }
    check()
    return blobs
  } finally {
    canvas.width = canvas.height = 1
  }
}
