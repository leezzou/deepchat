/** 长尾块需要整块重新分词：降低频率并增大每段文本，避免在手机上反复解析同一大块。 */
export function getStreamUpdateDelay(pendingCharacters: number, renderDuration: number) {
  const sizeFloor = pendingCharacters > 48_000 ? 160 : pendingCharacters > 12_000 ? 80 : 24
  return Math.min(240, Math.max(sizeFloor, renderDuration * 2))
}

const segmenter =
  typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : undefined

/** 返回原文前缀，不补语法、不 normalize；只在下一小段内寻找字符簇边界。 */
export function nextStreamLength(content: string, shown: number, elapsed: number) {
  const pending = content.length - shown
  if (pending <= 0) {
    return content.length
  }
  // 积压越多，每段越大；正常 token 流约 24ms 一小段，大突发也会主动追赶。
  const budget = Math.min(
    8192,
    Math.max(8, Math.ceil(pending * Math.min(1, Math.max(24, elapsed) / 120)))
  )
  if (pending <= budget) {
    return content.length
  }
  // 旧 WebView 没有 Segmenter 时仍保留原文；至少不截断 UTF-16 字符及常见组合字符。
  if (!segmenter) {
    let end = shown + budget
    const code = content.charCodeAt(end)
    if (code >= 0xdc00 && code <= 0xdfff) {
      end--
    }
    while (end < content.length) {
      const next = String.fromCodePoint(content.codePointAt(end) ?? 0)
      if (!/[\p{Mark}\p{Emoji_Modifier}\u200D]/u.test(next) && content[end - 1] !== '\u200D') {
        break
      }
      end += next.length
    }
    if (content[end - 1] === '\r' && content[end] === '\n') {
      end++
    }
    return end
  }
  let end = shown
  const window = content.slice(shown, shown + budget + 64)
  for (const { segment, index } of segmenter.segment(window)) {
    const next = shown + index + segment.length
    // 首个字符簇即使超过预算也整体显示；常见 emoji/组合音标不会在中间断开。
    if (next > shown + budget && end > shown) {
      break
    }
    end = next
  }
  if (content.charCodeAt(end - 1) === 13 && content.charCodeAt(end) === 10) {
    end++
  }
  return end
}
