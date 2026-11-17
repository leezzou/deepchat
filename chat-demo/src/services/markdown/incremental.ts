import type { Nodes, Root, RootContent } from 'mdast'
import { normalizeMdAst, parseMarkdown, usedMathFallback, type MarkdownOptions } from './parse.js'

const sameOptions = (left: MarkdownOptions, right: MarkdownOptions) =>
  left.disableLink === right.disableLink &&
  (left.sources === right.sources ||
    (left.sources !== undefined &&
      right.sources !== undefined &&
      left.sources.length === right.sources.length &&
      left.sources.every((source, index) => {
        const other = right.sources?.[index]
        return (
          other !== undefined &&
          source.index === other.index &&
          source.url === other.url &&
          source.title === other.title &&
          source.siteName === other.siteName &&
          source.publishedAt === other.publishedAt &&
          source.snippet === other.snippet &&
          source.siteIcon === other.siteIcon
        )
      })))

/** 定义可以回头改变此前任意块的分词，不能只在尾部解释。 */
const hasDocumentReferences = (node: Nodes): boolean => {
  if (
    node.type === 'definition' ||
    node.type === 'footnoteDefinition' ||
    node.type === 'linkReference' ||
    node.type === 'imageReference' ||
    node.type === 'footnoteReference'
  ) {
    return true
  }
  return 'children' in node && node.children.some(hasDocumentReferences)
}

const shiftPositions = (node: Nodes, offset: number, lines: number) => {
  if (node.position) {
    for (const point of [node.position.start, node.position.end]) {
      point.line += lines
      if (point.offset !== undefined) {
        point.offset += offset
      }
    }
  }
  if ('children' in node) {
    for (const child of node.children) {
      shiftPositions(child, offset, lines)
    }
  }
}

/**
 * 一个实例对应一个 Markdown 文本流，不做跨消息缓存。
 * 保留两个尾块：例如尚未写完的 `2` 随后成为 `2. item`，会重新并入前面的列表。
 * 只有更早的块才能提交；末尾长段落/代码块仍由调用方的自适应节流限制解析频率。
 * 定义/脚注等全局语法回退全文解析，结束时无条件以完整解析器校准一次。
 */
export class IncrementalMarkdownParser {
  private input = ''
  private cacheKey = ''
  private options: MarkdownOptions | undefined
  private streaming = false
  private ast: Root = { type: 'root', children: [] }
  private stable: RootContent[] = []
  private offset = 0
  private lines = 0
  private documentReferences = false

  /** 可复现的工作量指标；不记录正文，用于回归测试和开发期性能比较。 */
  readonly stats = { parseCalls: 0, fullParseCalls: 0, parsedCharacters: 0 }

  get stableCount() {
    return this.stable.length
  }

  get pendingCharacters() {
    return this.input.length - this.offset
  }

  private parse(input: string, full: boolean) {
    this.stats.parseCalls++
    this.stats.parsedCharacters += input.length
    if (full) {
      this.stats.fullParseCalls++
    }
    return parseMarkdown(input)
  }

  update(input: string, streaming: boolean, options: MarkdownOptions, cacheKey = ''): Root {
    const optionsChanged = !this.options || !sameOptions(this.options, options)
    const keyChanged = this.cacheKey !== cacheKey
    if (!keyChanged && !optionsChanged && input === this.input && streaming === this.streaming) {
      return this.ast
    }

    if (keyChanged || optionsChanged || !input.startsWith(this.input) || !this.streaming) {
      this.stable = []
      this.offset = 0
      this.lines = 0
      this.documentReferences = false
    }
    if (optionsChanged) {
      // 上层每次 buildReplyView 都产生新数组；值相同不清缓存，值变化必须重新生成 citation。
      this.options = {
        disableLink: options.disableLink,
        sources: options.sources?.map((source) => ({ ...source })),
      }
    }
    this.input = input
    this.cacheKey = cacheKey
    this.streaming = streaming

    if (!streaming || this.documentReferences) {
      this.ast = normalizeMdAst(this.parse(input, true), input, options)
      this.stable = []
      this.offset = 0
      this.lines = 0
      return this.ast
    }

    const tail = input.slice(this.offset)
    let parsed = this.parse(tail, this.offset === 0)
    if (usedMathFallback(parsed) || hasDocumentReferences(parsed)) {
      this.documentReferences = true
      // 前缀里可能有尚未解析成引用的 [label]；发现定义后立即校准，而非等到流结束。
      if (this.offset > 0) {
        parsed = this.parse(input, true)
      }
      this.ast = normalizeMdAst(parsed, input, options)
      this.stable = []
      this.offset = 0
      this.lines = 0
      return this.ast
    }

    const commitCount = Math.max(0, parsed.children.length - 2)
    const nextStart = parsed.children[commitCount]?.position?.start.offset ?? 0
    // 从行首重解析，保留列表/块引语等依赖的前导空格。
    const nextOffset =
      Math.max(tail.lastIndexOf('\n', nextStart - 1), tail.lastIndexOf('\r', nextStart - 1)) + 1
    normalizeMdAst(parsed, tail, options)
    shiftPositions(parsed, this.offset, this.lines)
    this.ast = {
      type: 'root',
      children: [...this.stable, ...parsed.children],
      position: parsed.position && {
        start: { line: 1, column: 1, offset: 0 },
        end: parsed.position.end,
      },
    }
    if (commitCount > 0 && nextOffset > 0) {
      this.stable = [...this.stable, ...parsed.children.slice(0, commitCount)]
      this.offset += nextOffset
      this.lines += (tail.slice(0, nextOffset).match(/\r\n|\r|\n/g) ?? []).length
    }
    return this.ast
  }
}
