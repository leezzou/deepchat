import assert from 'node:assert/strict'
import test from 'node:test'
import { parseJsonStream } from './streamJson.ts'

const encode = (text) => new TextEncoder().encode(text)
async function* slices(bytes, width) {
  for (let i = 0; i < bytes.length; i += width) {
    yield bytes.subarray(i, i + width)
  }
}
const parse = (text, width) => parseJsonStream(slices(encode(text), width))

test('all byte boundaries preserve literals, UTF-8, UTF-16 escapes, containers and delimiters inside strings', async () => {
  const inputs = [
    'true',
    'false',
    'null',
    '-0',
    '1e+309',
    '1e-325',
    '0.2E-4',
    '""',
    String.raw`["a\r\n\t\/\f\b\\\"z","\ud83d\ude42","\ud800","\udc00"]`,
    String.raw` {"汉🙂élève": [ { "quote\u0022\r": "🙂 []{}:, and \n, \t ×" }, null ], "": [{}]} `,
    JSON.stringify({ messages: [{ id: 1, content: '汉字'.repeat(320) + '🙂' }] }),
  ]
  for (const input of inputs) {
    for (const width of [1, 2, 3, 4, 5, 6, 7, 19, 64, 512]) {
      assert.deepStrictEqual(await parse('\uFEFF' + input, width), JSON.parse(input))
    }
  }
})

test('preserves duplicate and special property names as enumerable own data', async () => {
  const input =
    '{"__proto__":{"p":1},"constructor":0,"a":1,"a":{"b":2},"toString":null,"__proto__":{"p":3}}'
  const actual = await parse(input, 2)
  assert.deepStrictEqual(actual, JSON.parse(input))
  assert.strictEqual(Object.getPrototypeOf(actual), Object.prototype)
  assert.deepEqual(Object.getOwnPropertyDescriptor(actual, '__proto__'), {
    enumerable: true,
    writable: true,
    configurable: true,
    value: { p: 3 },
  })
})

test('rejects malformed documents at start, inside and after every structural type', async () => {
  const bad = [
    '',
    ' \t\n',
    '\uFEFF\uFEFFnull',
    '[] []',
    'truefalse',
    'nul',
    '012',
    '+1',
    '1e',
    '-.23',
    '2.E1',
    '2e-',
    'true\u000b',
    'TRUE',
    'false 0',
    'null"extra"',
    'NaN',
    '[',
    '{',
    '[,]',
    '[1,]',
    '[[]{}]',
    '{,}',
    '{"a"}',
    '{"a":}',
    '{"a":1,}',
    '{"a" 2}',
    '{a:1}',
    '{true:1}',
    '{"a":1 "b":2}',
    '[]}',
    '{[]}',
    '[1:2]',
    '"',
    '"a\n"',
    '"z\u0000"',
    '"\\"',
    '"x\\u"',
    '"\\x42"',
    '"\\U1234"',
    '"\\u12x0"',
    '"\\u1"23"',
    '["x',
    '{"partial": [ 1, {"b":"text"} ]',
  ]
  for (const text of bad) {
    for (const width of [1, 3, 11]) {
      await assert.rejects(parse(text, width), SyntaxError, `accepted ${JSON.stringify(text)}`)
    }
  }
})

test('rejects malformed UTF-8 including overlong, truncated and surrogate encodings', async () => {
  for (const invalid of [
    [0x80],
    [0xc0, 0x80],
    [0xe2, 0x82],
    [0xed, 0xa0, 0x80],
    [0xf4, 0x90, 0x80, 0x80],
  ]) {
    await assert.rejects(parseJsonStream(slices(Uint8Array.of(34, ...invalid, 34), 1)), SyntaxError)
  }
  await assert.rejects(parseJsonStream(slices(Uint8Array.of(34, 0xe2, 0x82), 1)), SyntaxError)
})

test('propagates an upstream integrity error after the complete JSON value', async () => {
  const crcError = new Error('CRC mismatch')
  async function* corruptArchive() {
    yield encode('{}')
    throw crcError
  }
  await assert.rejects(parseJsonStream(corruptArchive()), (err) => err === crcError)
})

test('iterative reader accepts deep arrays and all positions across its own 64 KiB windows', async () => {
  const depth = 35000
  let value = await parse('['.repeat(depth) + '0' + ']'.repeat(depth), 1 << 20)
  for (let i = 0; i < depth; i++) {
    assert.equal(value.length, 1)
    value = value[0]
  }
  assert.equal(value, 0)
  for (let offset = -8; offset < 8; offset++) {
    const text = '"' + 'a'.repeat(65536 + offset) + String.raw`\u0041\"🙂\tend"`
    assert.equal(await parse(text, 1 << 20), JSON.parse(text))
  }
})

// Opt-in mobile-sized inputs. Generate and check each portion without building a reference document.
const large = process.env.LARGE_HISTORY_JSON_TESTS === '1'
test('parses a 208 MiB session with 832 independent text fragments', { skip: !large }, async () => {
  const fragment = encode('x'.repeat(256 * 1024))
  const count = 832
  async function* session() {
    yield encode('{"id":"big","messages":[')
    for (let i = 0; i < count; i++) {
      yield encode(`${i ? ',' : ''}{"id":${i},"content":"`)
      yield fragment
      yield encode(`\\u2022${i}"}`)
    }
    yield encode(']}')
  }
  const result = await parseJsonStream(session())
  assert.equal(result.id, 'big')
  assert.equal(result.messages.length, count)
  for (const [i, message] of result.messages.entries()) {
    assert.equal(message.id, i)
    assert.equal(message.content.length, fragment.length + 1 + String(i).length)
    assert(message.content.startsWith('xxx'))
    assert(message.content.endsWith(`•${i}`))
  }
})

test(
  'streams a >512 MiB index encoded with whitespace and keeps exactly its rows',
  { skip: !large },
  async () => {
    const padding = new Uint8Array(1024 * 1024).fill(0x20)
    const count = 513
    async function* index() {
      yield encode('[')
      for (let i = 0; i < count; i++) {
        yield padding
        yield encode(`${i ? ',' : ''}{"id":"id-${i}","title":"标题 ${i}"}`)
      }
      yield encode(']')
    }
    const result = await parseJsonStream(index())
    assert.deepEqual(
      result,
      Array.from({ length: count }, (_, i) => ({ id: `id-${i}`, title: `标题 ${i}` }))
    )
  }
)
