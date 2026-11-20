import type { WorkBuddyModelInfo } from '../../services/workbuddy/models.js'

export function workBuddyRateLabel(row: WorkBuddyModelInfo, english: boolean, compact = false) {
  if (row.rate?.free) {
    return english ? 'Free' : '免费'
  }
  if (row.rate) {
    const unit = english ? 'credits' : '积分'
    return `${row.rate.multiplier}× ${compact ? '' : english ? 'Tencent ' : '腾讯'}${unit}`
  }
  if (row.source === 'bundled') {
    return english ? 'Awaiting rate sync' : '费率待同步'
  }
  return english ? 'Rate not provided' : '未提供费率'
}
