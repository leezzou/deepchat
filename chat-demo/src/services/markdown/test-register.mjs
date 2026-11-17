// Test-only Node loader: production keeps NodeNext .js specifiers; Node strips the local TS sources.
import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier.startsWith('.') &&
      specifier.endsWith('.js') &&
      context.parentURL?.startsWith(import.meta.url.slice(0, import.meta.url.lastIndexOf('/') + 1))
    ) {
      const source = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (existsSync(fileURLToPath(source))) {
        return nextResolve(source.href, context)
      }
    }
    return nextResolve(specifier, context)
  },
})
