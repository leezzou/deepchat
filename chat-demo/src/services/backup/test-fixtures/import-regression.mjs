import { createHash } from 'node:crypto'
import { zipSync, strToU8 } from 'fflate'

const stamp = '2025-01-01T00:00:00.000Z'
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64')

// Each valid 24-bit BMP expands past the 1 MiB streaming threshold. A regular pattern
// keeps the DEFLATE case small. Different pixel values distinguish the two originals.
function bmp(color) {
  const width = 768,
    height = 512
  const data = Buffer.alloc(54 + 3 * width * height)
  data.write('BM')
  data.writeUInt32LE(data.length, 2)
  data.writeUInt32LE(54, 10)
  data.writeUInt32LE(40, 14)
  data.writeUInt32LE(width, 18)
  data.writeUInt32LE(height, 22)
  data.writeUInt16LE(1, 26)
  data.writeUInt16LE(24, 28)
  data.writeUInt32LE(data.length - 54, 34)
  data.fill(color, 54)
  return data
}

export function historyFixture(large = false) {
  const summary = {
    id: 'new',
    title: 'Imported fixture',
    inserted_at: stamp,
    updated_at: stamp,
    pinned: false,
  }
  const files = [{ id: 'small', name: 'dot.gif', data: gif, width: 1, height: 1, level: 0 }]
  if (large) {
    files.push({
      id: 'stored',
      name: 'stored.bmp',
      data: bmp(7),
      width: 768,
      height: 512,
      level: 0,
    })
    files.push({
      id: 'deflated',
      name: 'deflated.bmp',
      data: bmp(19),
      width: 768,
      height: 512,
      level: 6,
    })
  }
  const attachments = files.map((file) => ({
    id: file.id,
    file_name: file.name,
    file_size: file.data.length,
    inserted_at: stamp,
    token_usage: null,
    export_path: `chat_sessions/new_files/${file.id}_${file.name}`,
    is_image: true,
    width: file.width,
    height: file.height,
  }))
  const message = {
    id: 1,
    parent_id: null,
    role: 'USER',
    status: 'FINISHED',
    inserted_at: stamp,
    thinking_enabled: false,
    search_enabled: false,
    accumulated_token_usage: 0,
    fragments: [
      { type: 'FILE', files: attachments },
      { type: 'REQUEST', content: 'imported message' },
    ],
  }
  const json = (value) => strToU8(JSON.stringify(value))
  const bytes = Buffer.from(
    zipSync(
      {
        'manifest.json': json({ export_format_version: 3 }),
        'chat_sessions/new.json': json({ ...summary, current_message_id: 1, messages: [message] }),
        'chat_session_index.json': json([{ ...summary, message_count: 1 }]),
        ...Object.fromEntries(
          files.map((file, i) => [attachments[i].export_path, [file.data, { level: file.level }]])
        ),
      },
      { level: 0 }
    )
  )
  return {
    bytes,
    ids: files.map((f) => f.id),
    hashes: Object.fromEntries(files.map((f) => [f.id, sha256(f.data)])),
  }
}
