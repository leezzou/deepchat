import assert from 'node:assert/strict'
import test from 'node:test'
import { performance } from 'node:perf_hooks'
import { IncrementalMarkdownParser } from './incremental.ts'
import { parseMarkdown, toMdAst, usedMathFallback } from './parse.ts'
import { getStreamUpdateDelay, nextStreamLength } from './streaming.ts'

const source = {
  index: 1,
  url: 'https://example.com',
  title: '来源',
  siteName: 'example.com',
  publishedAt: null,
  snippet: null,
  siteIcon: null,
}
const options = { disableLink: false, sources: [source] }
const fixtures = {
  prose: '# 标题\n\n**粗体**和 *斜体*、~~删除~~、`code`。\n下一行😀é\n\n---\n\n最后一段',
  code: '前文\n\n```typescript\nconst x = `模板`;\n\n// 空行不拆块\n```\n\n后文\n\n再一段\n',
  mermaid: '说明\n\n```mermaid\nflowchart LR\n A[开始] --> B[结束]\n```\n\n下一段\n\n末段',
  math: '行内 $x^2$ 和 \\(y\\)。\n\n$$\n\\frac{1}{2}\n\n+ x\n$$\n\n\\[a+b\\]\n\n末尾',
  list: '开头\n\n1. 第一项\n\n2. 第二项\n   - [x] 嵌套任务\n   - [ ] 待办\n\n3. 第三项\n\n尾部\n\n结束',
  quote: '> 第一行\n>\n> - 列表\n>   后续\n\n> 第二引用\n\n普通段落\n\n最后',
  table: '前言\n\n表头 | 第二列\n--- | :---:\n值 | **值**\n另一行 | $x$\n\n后文\n\n结尾',
  setext: '第一段\n\n标题\n======\n\n后续\n\n子标题\n-----\n\n最后',
  html: '前文\n\n<!--\n\n注释\n-->\n\n<div>\n\n块内容\n</div>\n\n后文<br>下一行\n\n最后',
  links:
    '普通 [链接](https://example.com "title")、图片 ![alt](https://example.com/a.png)\n\n[citation:1] 和 [citation:99]\n\n结尾\n\n末段',
  lateDefinition:
    '[**text**][ref] 早于定义\n\n![alt][ref]\n\n无关段落\n\n第三段\n\n[ref]: https://example.com "title"\n\n最后',
  definitionFirst: '[ref]: https://example.com\n\n中间段\n\n另一个段\n\n[**text**][ref]\n\n最后',
  footnote: '开始[^note]。\n\n普通段落\n\n第三段\n\n[^note]: 脚注\n    多行\n\n结束',
  indentation: '  ## 标题\n\n  - 首项\n\n  - 次项\n\n    缩进文字\n\n  结尾\n\n最后',
  crlf: '# 标题\r\n\r\n第一段\r\n第二行\r\n\r\n- 第一项\r\n- 第二项\r\n\r\n最后\r\n\r\n末段',
}

for (const [name, input] of Object.entries(fixtures)) {
  test(`every streamed prefix equals a complete parse: ${name}`, () => {
    for (const disableLink of [false, true]) {
      const parser = new IncrementalMarkdownParser()
      const config = { ...options, disableLink }
      for (let length = 0; length <= input.length; length++) {
        const prefix = input.slice(0, length)
        assert.deepEqual(
          parser.update(prefix, true, config),
          toMdAst(prefix, config),
          `${name} at ${length}: ${JSON.stringify(prefix)}`
        )
      }
      assert.deepEqual(parser.update(input, false, config), toMdAst(input, config))
    }
  })
}

test('stable blocks retain identity and equivalent new source arrays keep the cache', () => {
  const parser = new IncrementalMarkdownParser()
  const initial = '# 标题\n\n第一段\n\n第二段\n\n第三段'
  const first = parser.update(initial, true, options)
  assert.ok(parser.stableCount >= 2)
  const next = parser.update(initial + '追加', true, { ...options, sources: [{ ...source }] })
  assert.equal(next.children[0], first.children[0])
  assert.equal(next.children[1], first.children[1])
  const calls = parser.stats.parseCalls
  assert.equal(parser.update(initial + '追加', true, options), next)
  assert.equal(parser.stats.parseCalls, calls)
})

test('late global definitions invalidate previously stable inline semantics immediately', () => {
  const parser = new IncrementalMarkdownParser()
  const initial = '[**label**][ref]\n\n第二段\n\n第三段\n\n第四段'
  const first = parser.update(initial, true, options)
  const final = initial + '\n\n[ref]: https://example.com'
  const next = parser.update(final, true, options)
  assert.deepEqual(next, toMdAst(final, options))
  assert.notEqual(next.children[0], first.children[0])
  assert.equal(parser.stableCount, 0)
})

test('sources, disableLink, replacement, truncation, and completed same-length edits reset safely', () => {
  const parser = new IncrementalMarkdownParser()
  const initial = '[citation:1] [链接](https://example.com)\n\n第二段\n\n第三段\n\n第四段'
  parser.update(initial, true, options)
  const changed = { ...options, sources: [{ ...source, title: '新标题' }] }
  assert.deepEqual(parser.update(initial, true, changed), toMdAst(initial, changed))
  const disabled = { ...changed, disableLink: true }
  assert.deepEqual(parser.update(initial, true, disabled), toMdAst(initial, disabled))
  for (const value of ['替换\n\n正文', '替换', '', '全新正文', '同长修改']) {
    assert.deepEqual(parser.update(value, true, options), toMdAst(value, options))
    assert.deepEqual(parser.update(value, false, options), toMdAst(value, options))
  }
})

test('completion performs one full calibration even without another content delta', () => {
  const parser = new IncrementalMarkdownParser()
  const input = Object.values(fixtures).join('\n\n')
  parser.update(input, true, options)
  const before = parser.stats.fullParseCalls
  const final = parser.update(input, false, options)
  assert.deepEqual(final, toMdAst(input, options))
  assert.equal(parser.stats.fullParseCalls, before + 1)
  assert.equal(parser.update(input, false, options), final)
  assert.equal(parser.stats.fullParseCalls, before + 1)
})

test('mixed blocks under deterministic irregular network chunks match full parsing', () => {
  const input = Object.values(fixtures).join('\n\n')
  let seed = 731
  for (let run = 0; run < 8; run++) {
    const parser = new IncrementalMarkdownParser()
    for (let length = 0; length < input.length; ) {
      seed = (seed * 1664525 + 1013904223) >>> 0
      length = Math.min(input.length, length + 1 + (seed % 73))
      const prefix = input.slice(0, length)
      assert.deepEqual(
        parser.update(prefix, true, options),
        toMdAst(prefix, options),
        `run ${run}, length ${length}`
      )
    }
  }
})

test('an incomplete math fence followed by a tab stays renderable and recovers', () => {
  const input = '\\[\n\t'
  assert.equal(usedMathFallback(parseMarkdown(input)), true)
  const parser = new IncrementalMarkdownParser()
  assert.deepEqual(parser.update(input, true, options), toMdAst(input, options))
  const complete = input + 'x^2\n\\]'
  const full = parseMarkdown(complete)
  assert.equal(usedMathFallback(full), false)
  assert.equal(full.children[0].type, 'math')
  assert.deepEqual(parser.update(complete, false, options), toMdAst(complete, options))
})

test('message identity invalidates even an identical visible prefix', () => {
  const parser = new IncrementalMarkdownParser()
  const input = '# 标题\n\n第一段\n\n第二段\n\n第三段'
  const first = parser.update(input, true, options, 'message-a')
  const second = parser.update(input, true, options, 'message-b')
  assert.notEqual(second.children[0], first.children[0])
  assert.deepEqual(second, toMdAst(input, options))
})

test('unfinished and mixed Markdown syntax cannot commit a changing prefix', () => {
  const lines = [
    'plain',
    '',
    '> quoted',
    '> ',
    '- item',
    '1. item',
    '2',
    '---',
    '===',
    '```',
    '~~~js',
    '$$',
    '\\[',
    '\\]',
    '<div',
    'class="x">',
    '</div>',
    '<!--',
    '-->',
    '| a | b |',
    '| --- | --- |',
    '[ref]: /url',
    '[ref]',
    '  indented',
    '\ttext',
  ]
  let seed = 911
  for (let run = 0; run < 30; run++) {
    let input = ''
    for (let line = 0; line < 25; line++) {
      seed = (seed * 1664525 + 1013904223) >>> 0
      input += lines[seed % lines.length] + '\n'
    }
    const parser = new IncrementalMarkdownParser()
    for (let end = 1; end <= input.length; end += 3) {
      const prefix = input.slice(0, end)
      assert.deepEqual(
        parser.update(prefix, true, options),
        toMdAst(prefix, options),
        JSON.stringify(prefix)
      )
    }
    assert.deepEqual(parser.update(input, false, options), toMdAst(input, options))
  }
})

test('smoothing progresses in bounded segments without tearing common graphemes or CRLF', () => {
  const input = '中文👩🏽‍💻é😀\r\n'.repeat(200)
  const boundaries = new Set(
    [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(input)].map(
      ({ index }) => index
    )
  )
  boundaries.add(input.length)
  let shown = 0
  for (let count = 0; shown < input.length; count++) {
    assert.ok(count < 100)
    const next = nextStreamLength(input, shown, 24)
    assert.ok(next > shown)
    assert.ok(boundaries.has(next), `split grapheme at ${next}`)
    shown = next
  }
  assert.ok(nextStreamLength('x'.repeat(20_000), 0, 24) > nextStreamLength('x'.repeat(200), 0, 24))
  assert.equal(getStreamUpdateDelay(0, 0), 24)
  assert.ok(getStreamUpdateDelay(60_000, 0) >= 160)
  assert.equal(getStreamUpdateDelay(100, 1000), 240)
})

test('long multi-block stream avoids repeated full-document parse work', (context) => {
  const input = Array.from(
    { length: 160 },
    (_, i) =>
      `## 第 ${i} 节\n\n正文 **强调** 与 $x^2$，说明稳定块缓存。\n\n\`\`\`js\nconst value = ${i}\n\`\`\`\n\n`
  ).join('')
  const chunks = []
  for (let end = 96; end < input.length; end += 96) {
    chunks.push(input.slice(0, end))
  }
  chunks.push(input)
  const parser = new IncrementalMarkdownParser()
  let baselineCharacters = 0
  let started = performance.now()
  for (const chunk of chunks) {
    toMdAst(chunk, options)
    baselineCharacters += chunk.length
  }
  const fullMilliseconds = performance.now() - started
  started = performance.now()
  for (const chunk of chunks) {
    parser.update(chunk, true, options)
  }
  const final = parser.update(input, false, options)
  const incrementalMilliseconds = performance.now() - started
  baselineCharacters += input.length
  assert.deepEqual(final, toMdAst(input, options))
  assert.ok(parser.stats.parsedCharacters < baselineCharacters * 0.1)
  context.diagnostic(
    JSON.stringify({
      characters: input.length,
      updates: chunks.length,
      fullMilliseconds: Math.round(fullMilliseconds),
      incrementalMilliseconds: Math.round(incrementalMilliseconds),
      baselineCharacters,
      incrementalCharacters: parser.stats.parsedCharacters,
      parsedWorkReduction: `${(100 * (1 - parser.stats.parsedCharacters / baselineCharacters)).toFixed(1)}%`,
    })
  )
})
