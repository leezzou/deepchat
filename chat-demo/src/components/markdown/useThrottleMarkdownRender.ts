import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { getStreamUpdateDelay, nextStreamLength } from '../../services/markdown/streaming.js'

/**
 * 网络批次进一步平滑成小段；根据积压、尾块大小和实际提交耗时主动追赶/降频。
 * 计时器读取最新目标，不因高频输入反复取消而饿死。结束/替换/换消息在当前渲染立即生效。
 */
export const useThrottleMarkdownRender = (
  content: string,
  enable: boolean,
  cacheKey = '',
  pendingCharacters = 0
) => {
  const [output, setOutput] = useState({ content, cacheKey })
  const target = useRef({ content, enable, cacheKey, pendingCharacters })
  target.current = { content, enable, cacheKey, pendingCharacters }
  const shown = useRef(output)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const started = useRef(0)
  const committedAt = useRef(0)
  const renderDuration = useRef(0)
  const reducedMotion = useRef(false)

  const schedule = () => {
    if (timer.current !== undefined || !target.current.enable) {
      return
    }
    if (shown.current.content === target.current.content) {
      return
    }
    const delay = getStreamUpdateDelay(target.current.pendingCharacters, renderDuration.current)
    timer.current = setTimeout(
      () => {
        timer.current = undefined
        const latest = target.current
        if (!latest.enable) {
          return
        }
        const now = performance.now()
        const previous = shown.current
        const immediate =
          reducedMotion.current ||
          document.hidden ||
          previous.cacheKey !== latest.cacheKey ||
          !latest.content.startsWith(previous.content)
        const length = immediate
          ? latest.content.length
          : nextStreamLength(latest.content, previous.content.length, now - committedAt.current)
        const next = { content: latest.content.slice(0, length), cacheKey: latest.cacheKey }
        started.current = now
        shown.current = next
        setOutput(next)
      },
      Math.max(0, committedAt.current + delay - performance.now())
    )
  }
  const scheduleRef = useRef(schedule)
  scheduleRef.current = schedule

  useLayoutEffect(() => {
    const now = performance.now()
    if (started.current > 0) {
      renderDuration.current = now - started.current
    }
    started.current = 0
    committedAt.current = now
    scheduleRef.current()
  }, [output])

  useEffect(() => {
    if (!enable || output.cacheKey !== cacheKey || !content.startsWith(output.content)) {
      clearTimeout(timer.current)
      timer.current = undefined
      shown.current = { content, cacheKey }
      if (output.content !== content || output.cacheKey !== cacheKey) {
        setOutput(shown.current)
      }
    } else {
      scheduleRef.current()
    }
  }, [content, enable, cacheKey, output])

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    reducedMotion.current = media.matches
    const updatePreference = () => {
      reducedMotion.current = media.matches
    }
    media.addEventListener('change', updatePreference)
    return () => {
      clearTimeout(timer.current)
      timer.current = undefined
      media.removeEventListener('change', updatePreference)
    }
  }, [])

  // 不能依赖 effect/timer 清空积压：done、stop、error 到达当次就显示全部正文。
  return !enable || output.cacheKey !== cacheKey || !content.startsWith(output.content)
    ? content
    : output.content
}
