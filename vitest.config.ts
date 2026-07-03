import type { Plugin } from 'vitest/config'
import { defineConfig } from 'vitest/config'
import { bundledServicesPlugin, bundleStringPlugin, coreOpenApiPlugin } from './tsdown.config'

// Vite-native `?thread` resolver for the test environment.
//
// The production worker plugin (workerPlugin.ts) is written for rolldown: it
// emits the worker as a bundled chunk (emitFile/renderChunk) and round-trips an
// `&importer=` query from resolveId → load. Neither survives under Vite — Vite's
// resolver re-normalizes ids and drops the custom query, and its build-only
// hooks don't run during vitest's transform, so a `?thread` import falls through
// to executing the raw worker file on the main thread.
//
// Here we don't bundle: resolve `?thread` to a `\0`-prefixed VIRTUAL id (Vite
// preserves `\0` ids verbatim and routes them straight to load, exactly the
// rolldown behaviour the production plugin relied on), then emit a worker
// factory that points at the REAL source file. Tests never spawn the worker, so
// it's only ever imported, not run — but this resolves to valid, runnable code.
function vitestThreadPlugin(): Plugin {
  const PREFIX = '\0thread:'
  return {
    name: 'mc8yp:vitest-thread',
    enforce: 'pre',
    async resolveId(source, importer) {
      if (!source.endsWith('?thread'))
        return null
      const resolved = await this.resolve(source.slice(0, -'?thread'.length), importer, { skipSelf: true })
      return resolved ? PREFIX + resolved.id : null
    },
    load(id) {
      if (!id.startsWith(PREFIX))
        return null
      const realPath = id.slice(PREFIX.length)
      return `import { Worker } from 'node:worker_threads'\nexport default class extends Worker { constructor(options) { super(${JSON.stringify(realPath)}, options) } }`
    },
  }
}

export default defineConfig({
  plugins: [coreOpenApiPlugin({ mode: 'cli' }), bundledServicesPlugin({ mode: 'cli' }), bundleStringPlugin(), vitestThreadPlugin()],
})
