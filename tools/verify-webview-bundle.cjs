// Offline syntax check. Run with Node 12.4.0 (V8 7.4, the Chromium 74 branch):
//   /path/to/node-12.4/bin/node --no-lazy tools/verify-webview-bundle.cjs [dist-directory | release.apk]
// The system unzip command is needed only for APKs. The scripts are compiled as classic browser scripts.
'use strict'

const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const { Script } = require('vm')

if (!process.versions.v8.startsWith('7.4.')) {
  throw new Error(`Use Node 12.4.0 to check Chromium 74 grammar. Current V8 is ${process.versions.v8}`)
}

const input = path.resolve(process.argv[2] || path.join(__dirname, '../chat-demo/dist'))
function directoryFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).reduce((files, entry) => {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) return files.concat(directoryFiles(file))
    files.push(file)
    return files
  }, [])
}

function unzip(args) {
  return execFileSync('unzip', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
}

const isDirectory = fs.statSync(input).isDirectory()
const files = isDirectory
  ? directoryFiles(input).map(file => path.relative(input, file))
  : unzip(['-Z1', input]).split('\n').filter(file => file.startsWith('assets/'))
const scripts = files.filter(file => file.endsWith('.js')).sort()
if (!scripts.some(file => /(?:^|\/)static\/js\/main\.[\da-f]+\.js$/.test(file))) {
  throw new Error(`Missing production entry in ${input}`)
}

let failures = 0
for (const file of scripts) {
  const source = isDirectory ? fs.readFileSync(path.join(input, file), 'utf8') : unzip(['-p', input, file])
  try {
    new Script(source, { filename: file })
  } catch (error) {
    console.error(`${file} — ${error.message}`)
    failures++
  }
}
console.log(`V8 ${process.versions.v8}: ${scripts.length - failures}/${scripts.length} production scripts compiled`)
if (failures) process.exitCode = 1
