import { endpointProvider } from './modelWindows.js'
import { isOpenAiOrigin } from './openAiModels.js'
import type { ApiProtocol } from './origin.js'
import { isDeepSeekApiOrigin } from './providerParity.js'
import { isAnthropicOrigin, supportsClaudeFiles } from './anthropicOfficial.js'

export type FileInputMode = 'upload' | 'text' | 'choice'
export const isOpenAiFiles = isOpenAiOrigin
export const OPENAI_FILE_BYTES = 50_000_000

const pdfAccept = '.pdf,application/pdf'
const claudeTypes: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

export function originalAccept(origin: string, all: string) {
  if (isAnthropicOrigin(origin)) {
    return '.pdf,.png,.jpg,.jpeg,.gif,.webp,application/pdf,image/png,image/jpeg,image/gif,image/webp'
  }
  return isOpenAiFiles(origin) ? pdfAccept : all
}

export function originalFileIssue(
  origin: string,
  file: { name: string; type: string; size?: number; isImage?: boolean }
) {
  if (!isOpenAiFiles(origin) && !isAnthropicOrigin(origin)) {
    return undefined
  }
  if (isOpenAiFiles(origin) && (file.size ?? 0) >= OPENAI_FILE_BYTES) {
    return 'uploadOpenAiFileSize' as const
  }
  const ext = file.name.match(/\.([a-z0-9]+)$/i)?.[1].toLowerCase() ?? ''
  const mime = file.type?.toLowerCase().split(';')[0].trim() ?? ''
  const matches = (expected: string | undefined) =>
    expected && (!mime || mime === 'application/octet-stream' || mime === expected)
  if (isOpenAiFiles(origin) && (file.isImage || !(ext === 'pdf' && matches('application/pdf')))) {
    return 'uploadPdfOnly' as const
  }
  if (
    isAnthropicOrigin(origin) &&
    (!matches(
      Object.prototype.hasOwnProperty.call(claudeTypes, ext) ? claudeTypes[ext] : undefined
    ) ||
      (file.isImage !== undefined && file.isImage !== (ext !== 'pdf')))
  ) {
    return 'uploadClaudeTypes' as const
  }
  return undefined
}

/** Chat Completions alone does not establish a Files API + reusable file ID contract. */
export function endpointFileInput(
  origin: string,
  model: string,
  providerId?: string,
  protocol?: ApiProtocol
): FileInputMode {
  if (isDeepSeekApiOrigin(origin)) {
    return model === 'deepseek-v4-pro' ? 'text' : 'upload'
  }
  if (isAnthropicOrigin(origin)) {
    return protocol !== 'deepseek' && supportsClaudeFiles(model) ? 'choice' : 'text'
  }
  if (isOpenAiFiles(origin)) {
    // The upload format exposed here is limited to PDF on vision-capable models.
    const vision =
      /^(?:gpt-(?:4o(?:-mini)?|4\.1(?:-(?:mini|nano))?|[56](?:\.\d+)?(?:-(?:mini|nano|pro|codex|luna|terra|sol|astra))?)|o1(?:-pro)?|o3(?:-pro)?|o4-mini)(?:-\d{4}-\d{2}-\d{2})?$/.test(
        model
      )
    return (!protocol || protocol === 'openai') && vision ? 'choice' : 'text'
  }
  // Listed deployments use text until we implement their specific original-file transport.
  // Keep the explicit upload option on custom gateways that do implement file IDs.
  return endpointProvider(origin, providerId) ? 'text' : 'choice'
}
