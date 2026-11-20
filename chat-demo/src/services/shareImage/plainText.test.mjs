import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

registerHooks({
  resolve(id, ctx, next) {
    if (id === '../markdown/parse.js' && ctx.parentURL?.endsWith('/shareImage/plainText.ts')) {
      return next(new URL('../markdown/parse.ts', import.meta.url).href, ctx)
    }
    return next(id, ctx)
  },
})
const { asPlainText } = await import('./plainText.ts')

test('copy and share semantic prose, leaving code and explicitly literal punctuation intact', () => {
  const md = ['## **摘要**', '> **粗体 _和斜体_**，`a ** b`，\\*\\*原样\\*\\*。', '~~~js', 'a ** b // **literal**', '~~~'].join('\n\n')
  const result = asPlainText(md)
  assert.ok(result.startsWith('摘要\n\n粗体 和斜体，a ** b，**原样**。'))
  assert.ok(result.includes('a ** b // **literal**'))
  assert.doesNotMatch(result, /##|~~~|\*\*粗体|_和斜体_/)
})

test('lists, literal table values, links and source footnotes stay legible in text-only destinations', () => {
  const md = ['4. first', '5. **second**', '', '| left | right |', '| --- | --- |', '| A | `**` |', '', '[说明][s] 以及脚注[^1]', '', '[s]: https://example.org/guide', '[^1]: 小字'].join('\n')
  assert.equal(asPlainText(md), '4. first\n5. second\n\nleft\tright\nA\t**\n\n说明 (https://example.org/guide) 以及脚注[1]\n\n[1] 小字')
})
