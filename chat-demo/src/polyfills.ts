/* eslint-disable */
/**
 * 旧版 Android System WebView 兼容层。
 * 这些 API 在较新的 Chrome 才有；缺失时启动脚本会直接抛错，页面表现为白屏。
 */
const define = (target: object, key: PropertyKey, value: unknown) => {
  if (!(key in target)) {
    Object.defineProperty(target, key, { value, writable: true, configurable: true })
  }
}

if (!('hasOwn' in Object)) {
  define(Object, 'hasOwn', (object: object, key: PropertyKey) =>
    Object.prototype.hasOwnProperty.call(object, key)
  )
}

if (!('at' in Array.prototype)) {
  define(Array.prototype, 'at', function (this: unknown[], index: number) {
    const length = this.length >>> 0
    const offset = Math.trunc(index) || 0
    const position = offset < 0 ? length + offset : offset
    return position < 0 || position >= length ? undefined : this[position]
  })
}

if (!('findLast' in Array.prototype)) {
  define(Array.prototype, 'findLast', function <T>(
    this: T[],
    predicate: (value: T, index: number, array: T[]) => unknown,
    thisArg?: unknown
  ) {
    for (let index = this.length - 1; index >= 0; index -= 1) {
      if (predicate.call(thisArg, this[index], index, this)) {
        return this[index]
      }
    }
    return undefined
  })
}

if (!('findLastIndex' in Array.prototype)) {
  define(Array.prototype, 'findLastIndex', function <T>(
    this: T[],
    predicate: (value: T, index: number, array: T[]) => unknown,
    thisArg?: unknown
  ) {
    for (let index = this.length - 1; index >= 0; index -= 1) {
      if (predicate.call(thisArg, this[index], index, this)) {
        return index
      }
    }
    return -1
  })
}

if (!('toReversed' in Array.prototype)) {
  define(Array.prototype, 'toReversed', function <T>(this: T[]) {
    return this.slice().reverse()
  })
}

if (!('toSorted' in Array.prototype)) {
  define(Array.prototype, 'toSorted', function <T>(
    this: T[],
    compareFn?: (a: T, b: T) => number
  ) {
    return this.slice().sort(compareFn)
  })
}

if (!('replaceAll' in String.prototype)) {
  define(String.prototype, 'replaceAll', function (
    this: string,
    search: string | RegExp,
    replacement: string
  ) {
    if (search instanceof RegExp) {
      if (!search.global) {
        throw new TypeError('replaceAll must be called with a global RegExp')
      }
      return this.replace(search, replacement)
    }
    const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return this.replace(new RegExp(escaped, 'g'), replacement)
  })
}

if (!('throwIfAborted' in AbortSignal.prototype)) {
  define(AbortSignal.prototype, 'throwIfAborted', function (this: AbortSignal) {
    if (this.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError')
    }
  })
}

if (typeof crypto !== 'undefined' && !('randomUUID' in crypto)) {
  const fallback = () => {
    const bytes = new Uint8Array(16)
    if (typeof crypto.getRandomValues === 'function') {
      crypto.getRandomValues(bytes)
    } else {
      for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = Math.floor(Math.random() * 256)
      }
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }
  define(crypto, 'randomUUID', fallback)
}

export {}
