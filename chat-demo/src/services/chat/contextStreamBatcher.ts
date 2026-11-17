/** 不依赖动画帧：后台页仍可收尾，pagehide/取消可同步刷新，最终状态绝不留在队列。 */
export const createContextBatcher = (publish: () => void, interval = 80) => {
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending = false
  let finished = false
  const flush = () => {
    if (timer !== undefined) {
      clearTimeout(timer)
    }
    timer = undefined
    if (pending) {
      pending = false
      publish()
    }
  }
  return {
    schedule() {
      if (finished) {
        return
      }
      pending = true
      timer ??= setTimeout(flush, interval)
    },
    flush,
    finish() {
      if (finished) {
        return
      }
      finished = true
      pending = true
      flush()
    },
  }
}
