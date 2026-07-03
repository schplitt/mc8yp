import type { EmittedFile, Plugin } from 'rolldown'
import path from 'node:path'

type AvailableQueryParams = 'worker' | 'sharedworker' | 'thread' | 'importer'

interface ImportQueryParams extends URLSearchParams {
  has: (key: AvailableQueryParams) => boolean
}

function getImportQueryParams(id: string): ImportQueryParams {
  return new URL(id.replace(/^C:/, '/'), 'file:').searchParams
}

const WORKER_ASSET_PREFIX = '__ROLLDOWN_WORKERS_ASSET__'
// Use [^_]+ to match any characters except underscore, then require double underscore at end
// This handles reference IDs that may contain hyphens or other non-word characters
const WORKER_ASSET_PATTERN = /__ROLLDOWN_WORKERS_ASSET__([a-zA-Z0-9-]+)__/g

function plugin(): Plugin {
  return {
    name: 'rolldown/workers',
    resolveId(source, importer): string | void {
      const query = getImportQueryParams(source)
      if (query.has('thread') || query.has('worker')) {
        return `${source}&importer=${importer}`
      }
    },
    async load(id): Promise<string | null | void> {
      const query = getImportQueryParams(id)
      const importer = query.get('importer')
      if (importer && (query.has('thread') || query.has('worker') || query.has('sharedworker'))) {
        let chunkId = id.replace(/\?.*/, '')
        let resolvedId = await this.resolve(chunkId, importer, { skipSelf: true })
        if (resolvedId === null) {
          if (!chunkId.startsWith('.')) {
            chunkId = `./${chunkId}`
            resolvedId = await this.resolve(chunkId, importer, { skipSelf: true })
          }
          if (resolvedId === null) {
            this.info(`Cannot resolve ${id} in ${importer}`)
            return null
          }
        }
        const chunk: EmittedFile = {
          type: 'chunk',
          id: resolvedId.id,
          importer,
        }
        const referenceId = this.emitFile(chunk)
        const assetRefId = `${WORKER_ASSET_PREFIX}${referenceId}__`
        const url = query.has('thread') ? `path.resolve(import.meta.dirname, ${assetRefId})` : assetRefId
        const signature = query.has('sharedworker') ? 'SharedWorker' : 'Worker'

        let code = `export default function createWorker(options) { return new ${signature}(${url}, options); }`
        if (query.has('thread')) {
          code = `import path from 'node:path'; import { Worker } from 'node:worker_threads'; ${code}`
        }

        return code
      }
    },
    renderChunk(code, chunk): string | void {
      if (code.match(WORKER_ASSET_PATTERN)) {
        // Use simple string replacement instead of BindingMagicString
        // to avoid potential issues with index handling
        let result = code

        let match: RegExpExecArray | null
        // Reset regex state
        WORKER_ASSET_PATTERN.lastIndex = 0

        // eslint-disable-next-line no-cond-assign
        while ((match = WORKER_ASSET_PATTERN.exec(code))) {
          const [full, hash] = match
          const filename = this.getFileName(hash!)
          let outputFilepath = path.posix.relative(path.dirname(chunk.fileName), filename)
          if (!outputFilepath.startsWith('.')) {
            outputFilepath = `./${outputFilepath}`
          }
          const replacement = JSON.stringify(outputFilepath)
          result = result.replace(full, replacement)
        }

        return result
      }
    },
  }
}

export default plugin
