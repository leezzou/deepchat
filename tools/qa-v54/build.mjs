// Copy source before building so concurrent release work cannot overwrite the QA assets.
import { cp, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const app = fileURLToPath(new URL('../../chat-demo/', import.meta.url))
const build = await mkdtemp(path.join(tmpdir(), 'deepchat-v54-source-'))
for (const name of ['src', 'package.json', 'tsconfig.json', 'LICENSE', 'rspack.config.ts']) {
  await cp(path.join(app, name), path.join(build, name), { recursive: true })
}
await symlink(path.join(app, 'node_modules'), path.join(build, 'node_modules'), 'dir')
const hash = createHash('sha256')
async function record(dir) {
  for (const item of (await readdir(path.join(build, dir), { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name)
  )) {
    const name = path.join(dir, item.name)
    if (item.isDirectory()) await record(name)
    else if (item.isFile())
      hash
        .update(name + '\0')
        .update(await readFile(path.join(build, name)))
        .update('\0')
  }
}
await record('src')
for (const name of ['package.json', 'rspack.config.ts', 'tsconfig.json'])
  hash.update(name).update(await readFile(path.join(build, name)))
const sourceHash = hash.digest('hex')
execFileSync(path.join(build, 'node_modules/.bin/rspack'), ['build', '-c', 'rspack.config.ts'], {
  cwd: build,
  env: { ...process.env, NODE_ENV: 'production' },
  stdio: ['ignore', 2, 2],
})
const assets = path.join(build, 'dist')
await writeFile(
  path.join(build, 'input.json'),
  JSON.stringify({ kind: 'source-preflight', sourceHash, assets }, null, 2)
)
console.log(assets)
