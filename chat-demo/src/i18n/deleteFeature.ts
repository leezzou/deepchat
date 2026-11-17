export const deleteFeatureZh = {
  deleteConfirmTitle: '删除消息 · {step}/3',
  deleteScopeLabel: '选择删除范围',
  deleteScopeSingle: '仅删除单条',
  deleteScopeSingleHint: '只删除选中的这条消息，后续消息保留。',
  deleteScopeFollowing: '包括后面的所有消息',
  deleteScopeFollowingHint: '删除这条消息及其所有后续消息，包含其他版本中的后续分支。',
  deleteScopeCount: '将删除 {count} 条消息',
  deleteScopeHidden: '其中 {count} 条来自其他版本。',
  deleteStepOne: '第 1 次确认：选择并确认删除范围。',
  deleteStepTwo: '第 2 次确认：核对以下消息与数量。此时还未删除。',
  deleteStepThree: '第 3 次确认：删除后无法在应用内撤销。请确认要永久删除这些消息。',
  deleteConfirmFirst: '确认范围（1/3）',
  deleteConfirmSecond: '确认消息（2/3）',
  deleteConfirmFinal: '永久删除（3/3）',
  deletePreviewMore: '以及另外 {count} 条消息',
  deletePreviewEmpty: '无文字内容',
  deleteRangeChanged: '消息范围已变化，请重新核对并完成三次确认。',
  deleteMessageUnavailable: '消息不存在或暂时无法删除，请关闭后重试。',
} as const

export const deleteFeatureEn: Record<keyof typeof deleteFeatureZh, string> = {
  deleteConfirmTitle: 'Delete messages · {step}/3',
  deleteScopeLabel: 'Choose what to delete',
  deleteScopeSingle: 'Only this message',
  deleteScopeSingleHint: 'Delete the selected message and keep the messages after it.',
  deleteScopeFollowing: 'Include all following messages',
  deleteScopeFollowingHint:
    'Delete this message and all its descendants, including later branches in other versions.',
  deleteScopeCount: '{count} messages will be deleted',
  deleteScopeHidden: '{count} are in other versions.',
  deleteStepOne: 'Confirmation 1: choose and confirm the deletion scope.',
  deleteStepTwo:
    'Confirmation 2: review the messages and count below. Nothing has been deleted yet.',
  deleteStepThree:
    'Confirmation 3: this cannot be undone in the app. Confirm that you want to permanently delete these messages.',
  deleteConfirmFirst: 'Confirm scope (1/3)',
  deleteConfirmSecond: 'Confirm messages (2/3)',
  deleteConfirmFinal: 'Permanently delete (3/3)',
  deletePreviewMore: 'And {count} more messages',
  deletePreviewEmpty: 'No text content',
  deleteRangeChanged:
    'The message scope changed. Review it again and complete all three confirmations.',
  deleteMessageUnavailable:
    'This message is missing or cannot be deleted now. Close this dialog and retry.',
}
