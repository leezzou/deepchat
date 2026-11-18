/** Incremental UTF-8 JSON reader for large archive entries. Keeps the result tree, open
 * containers, and the current scalar. A ZIP chunk may be much larger than a decode window. */
const WINDOW_BYTES = 64 * 1024

const invalid = (): never => {
  throw new SyntaxError('Invalid JSON in archive entry')
}

type Frame =
  | {
      type: 'object'
      data: Record<string, unknown>
      state: 'first' | 'key' | 'colon' | 'value' | 'next'
      key: string
    }
  | { type: 'array'; data: unknown[]; state: 'first' | 'value' | 'next' }

class JsonReader {
  private readonly stack: Frame[] = []
  private root: unknown
  private hasRoot = false
  private token: 'string' | 'atom' | undefined
  // Already unescaped text for strings, original digits/letters for numbers and literals.
  private scalar = ''
  // An unfinished JSON escape occupies at most five characters, e.g. '\u012'.
  private escapeTail = ''
  // JSON forbids literal U+0000..U+001F inside strings.
  // oxlint-disable-next-line no-control-regex
  private readonly stringSpecial = /["\\\x00-\x1f]/g
  private readonly atomEnd = /[\x20\t\r\n,[\]{}:"]/g
  private readonly spaces = /[\x20\t\r\n]+/y

  private wantsValue() {
    const frame = this.stack[this.stack.length - 1]
    if (!frame) {
      return !this.hasRoot
    }
    return frame.state === 'value' || (frame.type === 'array' && frame.state === 'first')
  }

  private addValue(value: unknown) {
    if (!this.wantsValue()) {
      invalid()
    }
    const frame = this.stack[this.stack.length - 1]
    if (!frame) {
      this.root = value
      this.hasRoot = true
    } else {
      if (frame.type === 'array') {
        frame.data.push(value)
      } else {
        // JSON.parse creates enumerable own data properties, including duplicate keys and __proto__.
        Object.defineProperty(frame.data, frame.key, {
          value,
          enumerable: true,
          writable: true,
          configurable: true,
        })
        frame.key = ''
      }
      frame.state = 'next'
    }
  }

  private endString() {
    const frame = this.stack[this.stack.length - 1]
    if (frame?.type === 'object' && (frame.state === 'first' || frame.state === 'key')) {
      frame.key = this.scalar
      frame.state = 'colon'
    } else {
      this.addValue(this.scalar)
    }
    this.scalar = ''
    this.token = undefined
  }

  /** Consume one complete escape-aligned segment. Native JSON.parse handles all eight
   * short escapes, UTF-16 escape code units and invalid escape sequences. */
  private readString(text: string, start: number): number {
    let escaped = false
    let end = text.length
    let closed = false
    this.stringSpecial.lastIndex = start
    for (let match = this.stringSpecial.exec(text); match; match = this.stringSpecial.exec(text)) {
      const i = match.index
      if (text[i] === '"') {
        end = i
        closed = true
        break
      }
      if (text[i] !== '\\') {
        invalid()
      }
      const afterEscape = i + (text[i + 1] === 'u' ? 6 : 2)
      if (afterEscape > text.length) {
        end = i
        this.escapeTail = text.slice(i)
        break
      }
      escaped = true
      this.stringSpecial.lastIndex = afterEscape
    }
    if (end > start) {
      const segment = text.slice(start, end)
      // Parsing a small slice independently also avoids retaining its entire source window.
      this.scalar +=
        escaped || segment.length < text.length / 2 ? JSON.parse(`"${segment}"`) : segment
    }
    if (closed) {
      this.endString()
    }
    return closed ? end + 1 : text.length
  }

  private endAtom() {
    const value: unknown = JSON.parse(this.scalar)
    this.addValue(value)
    this.scalar = ''
    this.token = undefined
  }

  feed(chunk: string) {
    const text = this.escapeTail + chunk
    this.escapeTail = ''
    let i = 0
    while (i < text.length) {
      if (this.token === 'string') {
        i = this.readString(text, i)
        continue
      }
      if (this.token === 'atom') {
        this.atomEnd.lastIndex = i
        const end = this.atomEnd.exec(text)?.index ?? text.length
        this.scalar += text.slice(i, end)
        i = end
        if (i < text.length) {
          this.endAtom()
        }
        continue
      }
      this.spaces.lastIndex = i
      if (this.spaces.test(text)) {
        i = this.spaces.lastIndex
        continue
      }
      const frame = this.stack[this.stack.length - 1]
      const ch = text[i++]
      switch (ch) {
        case '"':
          if (
            !(frame?.type === 'object' && (frame.state === 'first' || frame.state === 'key')) &&
            !this.wantsValue()
          ) {
            invalid()
          }
          this.token = 'string'
          break
        case '[': {
          const data: unknown[] = []
          this.addValue(data)
          this.stack.push({ type: 'array', data, state: 'first' })
          break
        }
        case '{': {
          const data = {}
          this.addValue(data)
          this.stack.push({ type: 'object', data, key: '', state: 'first' })
          break
        }
        case ']':
        case '}':
          if (
            !frame ||
            frame.type !== (ch === ']' ? 'array' : 'object') ||
            (frame.state !== 'first' && frame.state !== 'next')
          ) {
            invalid()
          }
          this.stack.pop()
          break
        case ':':
          if (frame?.type !== 'object' || frame.state !== 'colon') {
            invalid()
          }
          frame.state = 'value'
          break
        case ',':
          if (!frame || frame.state !== 'next') {
            invalid()
          }
          frame.state = frame.type === 'array' ? 'value' : 'key'
          break
        default:
          if (!this.wantsValue() || !/[tfn0-9-]/.test(ch)) {
            invalid()
          }
          this.token = 'atom'
          this.scalar = ch
      }
    }
  }

  finish(): unknown {
    if (this.token === 'atom') {
      this.endAtom()
    }
    if (!this.hasRoot || this.stack.length || this.token) {
      invalid()
    }
    return this.root
  }
}

/** SyntaxError covers malformed JSON and UTF-8 only. I/O errors from chunks propagate. */
export async function parseJsonStream(chunks: AsyncIterable<Uint8Array>): Promise<unknown> {
  const reader = new JsonReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const decode = (bytes?: Uint8Array) => {
    try {
      return decoder.decode(bytes, { stream: bytes !== undefined })
    } catch (error) {
      if (error instanceof TypeError) {
        throw new SyntaxError('Invalid UTF-8 in archive entry')
      }
      throw error
    }
  }
  for await (const chunk of chunks) {
    for (let offset = 0; offset < chunk.length; offset += WINDOW_BYTES) {
      reader.feed(decode(chunk.subarray(offset, offset + WINDOW_BYTES)))
    }
  }
  reader.feed(decode())
  return reader.finish()
}
