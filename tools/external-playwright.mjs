// Opt in per process with node --import ./tools/external-playwright.mjs tools/<test>.mjs ...
// PLAYWRIGHT_NODE_MODULES must point to an existing node_modules directory containing playwright.
import { registerHooks } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.env.PLAYWRIGHT_NODE_MODULES
if (!root) throw new Error('Set PLAYWRIGHT_NODE_MODULES to the external node_modules directory')
const parentURL = pathToFileURL(resolve(root, '..', 'external-playwright-runner.mjs')).href
registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(specifier, specifier === 'playwright' ? { ...context, parentURL } : context)
  },
})
console.log(`Playwright dependency ${import.meta.resolve('playwright')}`)
