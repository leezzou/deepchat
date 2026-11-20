import { describeReply } from '../chat/describe.js'
import type { Message } from '../chat/types.js'
import { buildReplyView } from '../chat/view.js'

export type ShareEntry = {
  role: Message['role']
  body: string
  thinking: string
  files: string[]
  imageBody?: string
  citationIndices?: number[]
}

/** Export the same final answer as the chat. Never expose discarded refusal blocks or tool payloads. */
export const shareEntry = (message: Message): ShareEntry => {
  if (message.role === 'user') {
    return {
      role: 'user',
      body: message.content,
      thinking: '',
      files: message.files.map((file) => file.name),
    }
  }
  const notice = describeReply(message)
  const refused = message.stopReason === 'refusal'
  const view = refused ? null : buildReplyView(message, false)
  const visibleAnswer = (answer?: string) =>
    [answer, notice?.presentation === 'response' ? notice.text : null].filter(Boolean).join('\n\n')
  const body = visibleAnswer(view?.answer?.text)
  const thinking =
    view?.steps
      .flatMap((step) => {
        if (step.type === 'thinking') {
          return step.blocks.map((block) => block.thinking).join('')
        }
        if (step.type === 'text') {
          return step.markdown
        }
        return []
      })
      .join('\n\n') ?? ''
  return {
    role: 'assistant',
    body,
    thinking,
    files: [],
    imageBody:
      view?.answer && view.answer.markdown !== view.answer.text
        ? visibleAnswer(view.answer.markdown)
        : undefined,
    citationIndices: view?.sources.map((source) => source.index),
  }
}

export type ShareDocument = {
  title: string
  sections: {
    role: string
    body: string
    imageBody?: string
    plainBody?: boolean
    citationIndices?: number[]
    thinking: string
    attachments: string
  }[]
  thoughtLabel: string
}

export const asMarkdown = (doc: ShareDocument) =>
  [
    `# ${doc.title}`,
    ...doc.sections.map(({ role, thinking, body, attachments }) =>
      [`## ${role}`, thinking && `### ${doc.thoughtLabel}\n\n${thinking}`, body, attachments]
        .filter(Boolean)
        .join('\n\n')
    ),
  ].join('\n\n')
