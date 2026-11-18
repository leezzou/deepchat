import { memo, useMemo } from 'react'
import type { Source } from '../../services/chat/view.js'
import { IncrementalMarkdownParser } from '../../services/markdown/incremental.js'
import { MarkdownAstRenderer } from './MarkdownAstRenderer.js'
import { useThrottleMarkdownRender } from './useThrottleMarkdownRender.js'
import './markdown.css'
import './highlight.css'

/**
 * 渲染链路：小段平滑/自适应节流 → 稳定块复用 + 尾部解析 → 结束全文校准。
 * 传入 sources 时把正文里的 [citation:N] 渲染为角标。
 */
export const Markdown = memo(function Markdown({
  content,
  loading,
  cacheKey,
  className,
  disableLink,
  sources,
}: {
  content: string
  loading: boolean
  cacheKey: string
  className?: string
  disableLink: boolean
  sources?: Source[]
}) {
  const parser = useMemo(() => new IncrementalMarkdownParser(), [])
  const throttledMarkdown = useThrottleMarkdownRender(
    content,
    loading,
    cacheKey,
    parser.pendingCharacters
  )
  const { ast, stableCount } = useMemo(() => {
    const ast = parser.update(throttledMarkdown, loading, { sources, disableLink }, cacheKey)
    return { ast, stableCount: parser.stableCount }
  }, [parser, throttledMarkdown, loading, sources, disableLink, cacheKey])
  return ast.children.length > 0 ? (
    <MarkdownAstRenderer
      key={cacheKey}
      className={className}
      ast={ast}
      stableCount={stableCount}
      loading={loading}
    />
  ) : null
})
