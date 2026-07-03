// ─────────────────────────────────────────────────────────────────────────
// Runtime vector search over the OpenAPI specs.
//
// VECTOR-ONLY (the bake-off showed pure vector beat keyword/hybrid for the
// vocabulary-gap + cross-reference cases this exists to solve). No MiniSearch,
// no neighbour expansion. A search returns ranked hits, each carrying a
// pasteable `header` accessor; the agent reads the full source there and, if it
// references another part of the surface, follows that in a second search.
//
//   • Core: loaded from the PREBUILT inlined vectors (no startup embedding).
//   • Services: embedded LIVE once per unique spec (content-hashed), cached
//     across tenants — ai-kit@2.1 on N tenants is embedded once.
//
// The query and every corpus vector use the same model (taken from the core
// vector file), so cosine similarities are comparable.
// ─────────────────────────────────────────────────────────────────────────

import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { getCoreOpenApiSpec, getCoreOpenApiVectors, getCoreOpenApiVersion } from '#core-openapi'
import { embed, embedQuery } from './embedder.ts'
import { CHUNKER_VERSION, chunkSpec } from './spec-chunker.ts'
import type { ChunkKind, SpecChunk } from './spec-chunker.ts'

type ChunkableSpec = Parameters<typeof chunkSpec>[1]

export interface VectorIndex {
  chunks: SpecChunk[]
  /**
   * Row-major, normalized: length === chunks.length * dim.
   */
  matrix: Float32Array
  dim: number
}

export interface SpecSearchHit {
  header: string
  text: string
  truncated: boolean
  kind: ChunkKind
  spec: string
  score: number
}

export interface SearchOptions {
  limit?: number
  minScore?: number
  maxTextLength?: number
}

// Model → instruction prefixes. bge-family models are trained with a query
// instruction; passages take none. Unknown models fall back to no prefix.
const MODEL_PREFIXES: Record<string, { query: string, passage: string }> = {
  'Xenova/bge-base-en-v1.5': { query: 'Represent this sentence for searching relevant passages: ', passage: '' },
  'Xenova/bge-small-en-v1.5': { query: 'Represent this sentence for searching relevant passages: ', passage: '' },
  'Xenova/bge-large-en-v1.5': { query: 'Represent this sentence for searching relevant passages: ', passage: '' },
  'Xenova/gte-base': { query: '', passage: '' },
}

// Model/dim/prefixes of the active core vectors — every index uses these.
let activeModel = ''
let activeDim = 0
let activePrefixes = { query: '', passage: '' }

function decodeMatrix(base64: string): Float32Array {
  const buf = Buffer.from(base64, 'base64')
  // Copy into a fresh, 4-byte-aligned buffer — pooled Buffers can have an
  // unaligned byteOffset, which Float32Array rejects.
  const out = new Float32Array(buf.length / 4)
  new Uint8Array(out.buffer).set(buf)
  return out
}

let coreIndexCache: { version: string, index: VectorIndex } | null = null

/**
 * Load (and cache) the core index from the prebuilt inlined vectors: re-chunk
 * the inlined core spec, assert it is byte-identical to what was embedded
 * (chunkerVersion + id alignment), and attach the decoded matrix. Also
 * configures the embedder with the model these vectors were built with.
 */
export function loadCoreIndex(): VectorIndex {
  const version = getCoreOpenApiVersion()
  if (coreIndexCache?.version === version)
    return coreIndexCache.index

  const vectors = getCoreOpenApiVectors()
  if (vectors.chunkerVersion !== CHUNKER_VERSION) {
    throw new Error(
      `Core vectors were built with chunkerVersion ${vectors.chunkerVersion} but the runtime chunker is ${CHUNKER_VERSION}. Rebuild with \`pnpm build:vectors\`.`,
    )
  }
  const chunks = chunkSpec('core', getCoreOpenApiSpec() as ChunkableSpec)
  if (chunks.length !== vectors.ids.length)
    throw new Error(`Core chunk count ${chunks.length} != prebuilt ${vectors.ids.length}. Rebuild with \`pnpm build:vectors\`.`)
  for (let i = 0; i < chunks.length; i++) {
    if (chunks[i]!.id !== vectors.ids[i])
      throw new Error(`Core chunk id mismatch at ${i} (${chunks[i]!.id} != ${vectors.ids[i]}). Rebuild with \`pnpm build:vectors\`.`)
  }
  const matrix = decodeMatrix(vectors.embeddings)
  if (matrix.length !== chunks.length * vectors.dim)
    throw new Error(`Core vector matrix has ${matrix.length} floats, expected ${chunks.length * vectors.dim}. Rebuild with \`pnpm build:vectors\`.`)

  // The embedder reads model/dtype straight from these same core vectors, so
  // query, corpus, and service embeddings all share one model — no wiring here.
  activeModel = vectors.model
  activeDim = vectors.dim
  activePrefixes = MODEL_PREFIXES[vectors.model] ?? { query: '', passage: '' }

  const index: VectorIndex = { chunks, matrix, dim: vectors.dim }
  coreIndexCache = { version, index }
  return index
}

const serviceCache = new Map<string, VectorIndex>()
const inFlight = new Map<string, Promise<VectorIndex>>()

function serviceKey(contextPath: string, spec: unknown): string {
  const hash = createHash('sha256').update(JSON.stringify(spec)).digest('hex').slice(0, 16)
  return `${contextPath}@${hash}@${activeModel}`
}

/**
 * Get (or build) the vector index for a discovered service spec. Keyed by
 * content hash so the same spec on multiple tenants is embedded ONCE; concurrent
 * callers for the same key share one in-flight embedding.
 * @param contextPath Service contextPath (e.g. `dtm`), used as the chunk namespace.
 * @param spec The discovered OpenAPI spec.
 * @param onProgress Optional progress callback during live embedding.
 */
export async function getServiceIndex(contextPath: string, spec: ChunkableSpec, onProgress?: (done: number, total: number, etaMs: number) => void): Promise<VectorIndex> {
  loadCoreIndex() // ensures the embedder is configured + model/dim known
  const key = serviceKey(contextPath, spec)
  const cached = serviceCache.get(key)
  if (cached)
    return cached
  const pending = inFlight.get(key)
  if (pending)
    return pending

  const build = (async (): Promise<VectorIndex> => {
    const chunks = chunkSpec(contextPath, spec)
    const vectors = await embed(chunks.map((c) => c.text), { prefix: activePrefixes.passage, onProgress })
    const matrix = new Float32Array(chunks.length * activeDim)
    vectors.forEach((v, i) => matrix.set(v, i * activeDim))
    const index: VectorIndex = { chunks, matrix, dim: activeDim }
    serviceCache.set(key, index)
    return index
  })()

  inFlight.set(key, build)
  try {
    return await build
  } finally {
    inFlight.delete(key)
  }
}

/**
 * Search `queryText` across the given indexes (vector-only cosine). Collapses
 * fragments to one hit per source (best fragment wins) and returns ranked hits
 * with truncated previews + the pasteable `header` accessor for the full source.
 * @param queryText The agent's search query.
 * @param indexes Visible indexes for this tenant (core + discovered services).
 * @param opts limit / minScore / maxTextLength.
 */
export async function search(queryText: string, indexes: VectorIndex[], opts: SearchOptions = {}): Promise<SpecSearchHit[]> {
  const limit = opts.limit ?? 5
  const maxText = opts.maxTextLength && opts.maxTextLength > 0 ? opts.maxTextLength : 800
  const qVec = await embedQuery(queryText, activePrefixes.query)

  const best = new Map<string, { chunk: SpecChunk, score: number }>()
  for (const idx of indexes) {
    const { chunks, matrix, dim } = idx
    for (let i = 0; i < chunks.length; i++) {
      const off = i * dim
      let score = 0
      for (let k = 0; k < dim; k++)
        score += qVec[k]! * matrix[off + k]!
      const chunk = chunks[i]!
      const cur = best.get(chunk.sourceId)
      if (!cur || score > cur.score)
        best.set(chunk.sourceId, { chunk, score })
    }
  }

  let ranked = [...best.values()].sort((a, b) => b.score - a.score)
  if (typeof opts.minScore === 'number')
    ranked = ranked.filter((r) => r.score >= opts.minScore!)

  return ranked.slice(0, limit).map(({ chunk, score }) => {
    const full = chunk.text
    const truncated = full.length > maxText
    const text = truncated
      ? `[TRUNCATED PREVIEW — first ${maxText} of ${full.length} chars; INCOMPLETE. Read the full source in code via: ${chunk.header}]\n\n${full.slice(0, maxText)}\n\n[END TRUNCATED PREVIEW — read the full source via: ${chunk.header}]`
      : full
    return { header: chunk.header, text, truncated, kind: chunk.kind, spec: chunk.spec, score }
  })
}

/**
 * Eagerly embed every discovered service in the background (fire-and-forget),
 * so the first search does not pay the embedding cost. Cache + in-flight dedup
 * mean an already-known spec is a no-op. Errors are reported, not thrown.
 * @param specs The tenant's resolved service specs (contextPath → spec).
 * @param log Optional logger for progress / completion / failure.
 * @param log.info
 * @param log.warn
 */
export function prewarmServiceIndexes(
  specs: Record<string, ChunkableSpec>,
  log?: { info: (msg: string) => void, warn: (msg: string) => void },
): void {
  loadCoreIndex()
  for (const [contextPath, spec] of Object.entries(specs)) {
    const total = chunkSpec(contextPath, spec).length
    log?.info(`[spec-vectors] discovered "${contextPath}" (${total} chunks) — embedding…`)
    getServiceIndex(contextPath, spec, (done, t, etaMs) => {
      const pct = ((done / t) * 100).toFixed(0)
      const eta = Number.isFinite(etaMs) ? `${Math.ceil(etaMs / 1000)}s` : '…'
      log?.info(`[spec-vectors] ${contextPath}: ${pct}% (${done}/${t}) ~${eta} left`)
    })
      .then(() => log?.info(`[spec-vectors] ${contextPath}: ready (${total} chunks) — now searchable`))
      .catch((err: unknown) => log?.warn(`[spec-vectors] ${contextPath}: embedding failed — ${(err as Error).message}`))
  }
}
