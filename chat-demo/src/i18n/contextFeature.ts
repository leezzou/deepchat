export const contextFeatureZh = {
  modelContextTitle: '模型上下文',
  modelContextFallback: '该渠道尚无已核实的窗口。当前使用应用的临时预算，可在设置中调整。',
  modelContextInvalid: '请输入大于零的安全整数。',
  contextManage: '管理上下文',
  contextSelectionCount: '当前分支 {total} 轮，已选择 {count} 轮',
  contextRecentFive: '最近 5 轮',
  contextRecentTen: '最近 10 轮',
  contextRestoreAll: '恢复全部原文',
  contextAutoSummary: '自动摘要',
  contextAutoSummaryHint:
    '发送前达到当前模型窗口的 80% 时，用模型总结旧轮次。保留原始记录；会额外调用模型。',
  contextSelectionHint:
    '仅影响后续请求。当前问题和续写内容始终保留；调整轮次会清除旧摘要并重新选择原文。',
  contextEstimateHint: '估算 {tokens} / {window} tokens。附件和工具内容的实际占用由模型决定。',
  contextControlsBusy: '正在生成或整理摘要，完成或停止后可调整上下文。',
  contextNoRounds: '完成一轮对话后，可在这里选择需要带给模型的轮次。',
  contextRoundLabel: '第 {number} 轮',
  contextRoundIncluded: '已包含',
  contextRoundExcluded: '已排除',
  contextRoundSummarized: '已纳入摘要',
  contextRoundFiles: '附件：{names}',
  contextOriginals: '查看本轮原文',
  contextMoreRounds: '显示更早轮次',
  contextOriginalsPreserved:
    '摘要仅替换发给模型的旧上下文。全部原文和分支仍保存在本机，可查看或恢复。',
  contextSummaryRisk:
    '模型摘要可能遗漏细节或产生错误；需要精确原话时，可恢复全部原文或手动选择轮次。',
  contextSummaryInactive: '此摘要属于其他分支，本次请求不会使用。',
  contextAutoFailed: '自动摘要未完成：{message}。原文和原摘要已保留。',
  contextSummaryKeyMissing: '请先配置 API Key。',
  contextSummaryChanged: '对话或模型配置已改变，请重试摘要。',
  contextNothingToSummarize: '没有可摘要的历史轮次，请减少当前问题或续写长度。',
  contextSummaryAttachmentLimit: '单轮附件已超出摘要预算，请选择更大的模型窗口或排除该轮。',
  contextSummaryWindowSmall: '当前模型窗口太小，无法容纳摘要指令和内容。请检查 API 配置。',
  contextSummaryNotSmaller: '摘要未能有效缩短上下文，已保留原文和原摘要。',
  contextSummaryIncomplete: '摘要未完整完成，可能被拒绝或达到输出上限。请重试。',
  contextSummaryCancelled: '已取消摘要，原文和原摘要保持不变。',
  contextRequestTooLarge:
    '当前上下文仍超出模型预算。请在上下文面板选择较少轮次，或减少本轮问题、附件或续写内容后重试。',
  contextDocumentCount:
    '本次对话请求引用了 {count} 份文档，最多支持 {limit} 份。同一文档重复引用也会计数。请减少本轮文档，或在上下文面板排除含附件的旧轮次。',
  contextDocumentTextLimit:
    '本次请求中的纯文本文档合计超过 8 MiB。请拆分文档并分次提问，或在上下文面板排除含附件的旧轮次。',
  contextImageLimit:
    '本次请求中的图片超过上限（最多 600 张，共 200 MiB）。请减少或缩小图片，或在上下文面板排除含图片的旧轮次。',
  contextAttachmentUnavailable: '找不到这条提问的附件原件。请重新添加文件后发送。',
  contextBackupRequested: '已请求下载备份，请在下载列表确认保存结果。',
  contextBackupShared: '已完成分享操作，请在目标位置确认备份已保存。',
} as const

export const contextFeatureEn: Record<keyof typeof contextFeatureZh, string> = {
  modelContextTitle: 'Model context',
  modelContextFallback: 'This channel has no verified window. The app is using a fallback budget, which you can change in Settings.',
  modelContextInvalid: 'Enter a positive safe integer.',
  contextManage: 'Manage context',
  contextSelectionCount: '{count} of {total} rounds selected on this branch',
  contextRecentFive: 'Last 5 rounds',
  contextRecentTen: 'Last 10 rounds',
  contextRestoreAll: 'Restore all originals',
  contextAutoSummary: 'Automatic summaries',
  contextAutoSummaryHint:
    'Before sending, summarize older rounds at 80% of the current model window. Originals are retained; this makes additional model requests.',
  contextSelectionHint:
    'Applies to future requests. The current question and continuation are always kept. Changing rounds clears the old summary and selects originals again.',
  contextEstimateHint:
    'Estimated {tokens} / {window} tokens. Actual attachment and tool usage depends on the model.',
  contextControlsBusy:
    'A reply or summary is in progress. Wait or stop it before changing context.',
  contextNoRounds: 'After completing a round, choose which rounds to include here.',
  contextRoundLabel: 'Round {number}',
  contextRoundIncluded: 'Included',
  contextRoundExcluded: 'Excluded',
  contextRoundSummarized: 'In summary',
  contextRoundFiles: 'Files: {names}',
  contextOriginals: 'View original round',
  contextMoreRounds: 'Show earlier rounds',
  contextOriginalsPreserved:
    'A summary replaces only the older context sent to the model. All original messages and branches remain on this device and can be viewed or restored.',
  contextSummaryRisk:
    'Model summaries may omit details or contain errors. Restore originals or select rounds when exact wording matters.',
  contextSummaryInactive: 'This summary belongs to another branch and will not be sent.',
  contextAutoFailed:
    'Automatic summary did not finish: {message}. Originals and the previous summary were retained.',
  contextSummaryKeyMissing: 'Configure an API key first.',
  contextSummaryChanged: 'The conversation or model configuration changed. Retry the summary.',
  contextNothingToSummarize:
    'There are no historical rounds to summarize. Reduce the current question or continuation.',
  contextSummaryAttachmentLimit:
    'Attachments in one round exceed the summary budget. Choose a larger model window or exclude the round.',
  contextSummaryWindowSmall:
    'The model window is too small for the summary instructions and content. Check the API configuration.',
  contextSummaryNotSmaller:
    'The summary did not reduce context sufficiently. Originals and the previous summary were retained.',
  contextSummaryIncomplete:
    'The summary did not finish completely. It may have been refused or reached the output limit. Retry it.',
  contextSummaryCancelled: 'Summary cancelled. Originals and the previous summary are unchanged.',
  contextRequestTooLarge:
    'Context still exceeds the model budget. Select fewer rounds in the context panel, or reduce the current question, attachments, or continuation before retrying.',
  contextDocumentCount:
    'This request includes {count} document references. The limit is {limit}, and each repeat counts. Remove documents from this question or exclude older rounds with attachments in the context panel.',
  contextDocumentTextLimit:
    'The plain-text documents in this request exceed 8 MiB in total. Split the documents across separate requests or exclude older rounds with attachments in the context panel.',
  contextImageLimit:
    'The images in this request exceed the limit of 600 images or 200 MiB in total. Remove or resize images, or exclude older rounds with images in the context panel.',
  contextAttachmentUnavailable:
    'The original attachment for this question is unavailable. Attach the file again and resend.',
  contextBackupRequested: 'Backup download requested. Confirm it was saved in your downloads.',
  contextBackupShared: 'Sharing completed. Confirm the backup was saved at the destination.',
}
