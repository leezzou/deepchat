import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

registerHooks({
  resolve(id, ctx, next) {
    if (id.startsWith('.') && id.endsWith('.js') && ctx.parentURL) {
      const target = new URL(id.slice(0, -3) + '.ts', ctx.parentURL)
      if (existsSync(target)) {
        return next(target.href, ctx)
      }
    }
    return next(id, ctx)
  },
})
const { layoutSharePages, MAX_HEIGHT, WIDTH } = await import('./layoutImage.ts')
const { imageMarkdown } = await import('./markdownImage.ts')
const ctx = {
  font: '',
  measureText(text) {
    return { width: [...text].length * 8 }
  },
}
const doc = (body, extras = {}) => ({
  title: '对话摘录',
  thoughtLabel: '思考',
  sections: [{ role: '助手', thinking: '', attachments: '', body, ...extras }],
})

test('nested styles, source citations and code syntax survive from Markdown AST to paint runs', () => {
  const [p] = layoutSharePages(
    ctx,
    doc(
      [
        '# 标题',
        '',
        '**粗体 *斜体*** 和 ~~删除~~ 以及 [链接](https://redacted.invalid/) [citation:2][citation:3]',
        '第二行 `**literal** [citation:3]`',
        '',
        '> 引言',
        '',
        '---',
        '',
        '3. 单项',
        '',
        '~~~js',
        'const x = "[abc](url) **code**"',
        '~~~',
        '',
        '| Item | Count |',
        '| --- | ---: |',
        '| **Two** | 2 |',
        '',
        '![配图](https://redacted.invalid/x.png)',
      ].join('\n'),
      { citationIndices: [2] }
    )
  )
  const text = p.texts.map((it) => it.text).join('')
  assert.match(text, /粗体 斜体/)
  assert.ok(p.texts.find((r) => r.text === '斜体' && /italic 700/.test(r.font)))
  assert.ok(p.texts.find((r) => r.text === '链接' && r.ink.link))
  assert.ok(p.texts.find((r) => r.text === '删除' && r.ink.strike))
  assert.ok(p.texts.find((r) => r.text === '**literal** [citation:3]' && r.inlineCode))
  assert.match(text, /\[2\]第二行/)
  assert.match(text, /const x = "\[abc\]\(url\) \*\*code\*\*"/)
  assert.match(text, /3\.单项/)
  assert.ok(p.texts.find((r) => r.text === 'Two' && /700/.test(r.font)))
  assert.ok(p.boxes.some((b) => b.w === 3))
  assert.ok(p.boxes.some((b) => b.h === 1.5))
  assert.match(text, /配图/)
  assert.doesNotMatch(text, /https:|~~~|\*\*粗体|\| ---/)
  assert.ok(
    p.texts.find((r) => r.text.includes('第二行')).y > p.texts.find((r) => r.text === '链接').y
  )
})

test('user text and code preserve punctuation; supported math and fallback retain meaning', () => {
  const [p] = layoutSharePages(
    ctx,
    doc('ordinary', { plainBody: true, imageBody: '**文字** [citation:5]', citationIndices: [] })
  )
  assert.match(p.texts.map((r) => r.text).join(''), /\*\*文字\*\* \[citation:5\]/)
  const [math] = imageMarkdown('$x^{12} + \\pi$ and $\\frac{x}{y}$')
  assert.deepEqual(
    math.runs.filter((r) => r.math).map((r) => r.text),
    ['x¹² + π', '\\frac{x}{y}']
  )
})

test('wraps a long table across bounded pages, preserves all source rows and the final code line', () => {
  const rows = Array.from({ length: 420 }, (_, i) => `| ROW${String(i).padStart(4, '0')} | text |`)
  const pages = layoutSharePages(
    ctx,
    doc(['| ID | Note |', '| --- | --- |', ...rows, '', '```', '**END**', '```'].join('\n'))
  )
  assert.ok(pages.length >= 3)
  const texts = pages.flatMap((p) => p.texts.map((r) => r.text))
  assert.equal(texts.filter((t) => /^ROW\d{4}$/.test(t)).length, 420)
  assert.ok(texts.includes('**END**'))
  for (const p of pages) {
    assert.ok(p.height <= MAX_HEIGHT)
    for (const r of p.texts) {
      assert.ok(r.x >= 0 && r.x + r.width <= WIDTH)
      assert.ok(r.y > 0 && r.y < p.height)
    }
  }
})
