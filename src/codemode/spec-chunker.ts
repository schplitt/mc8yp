// ─────────────────────────────────────────────────────────────────────────
// Spec → search chunks (host-side)
//
// Host-side counterpart to the in-sandbox `buildSpecDocs` in spec-index.ts.
// Because this runs in the Node host (not serialized via `.toString()` into the
// V8 isolate), it is free to use module-scope helpers — which lets it do the
// one thing the in-sandbox version cannot: SPLIT long sources into multiple
// focused chunks so a single oversized tag/operation description does not get
// averaged into one blurry vector.
//
// Every chunk collapses to the same shape: a searchable `text`, a pasteable
// `header` accessor pointing at the FULL untruncated source, a stable
// `sourceId` shared by every fragment of the same source, and `part` info when
// the source was split. Search dedupes neighbours by `sourceId` so the N
// fragments of one source never come back as N separate "related" hits.
// ─────────────────────────────────────────────────────────────────────────

// Runtime specs carry more than the narrow `Spec` type declares — `info`
// survives preprocessing and operations keep `operationId`. Loose local views
// for exactly the fields we index (mirrors spec-index.ts).
interface ChunkOperation {
  operationId?: string
  summary?: string
  description?: string
  tags?: string[]
  parameters?: Array<{ name?: string, description?: string, schema?: { format?: string }, examples?: Record<string, { value?: unknown, description?: string }> }>
}
// `paths` values are typed `unknown` (not Record<string, …>) so a stricter
// runtime `Spec` (whose path values are `PathItem`) is assignable; chunkSpec
// narrows each path item internally before reading it.
export interface ChunkSpec {
  info?: { title?: string, description?: string }
  paths?: Record<string, unknown>
  tags?: Array<{ name?: string, description?: string }>
}

export type ChunkKind = 'endpoint' | 'tag' | 'spec'

export interface SpecChunk {
  /**
   * Unique per chunk: `${sourceId}#part${i}` when split, else === sourceId.
   */
  id: string
  /**
   * Stable id of the SOURCE doc; every fragment of one source shares it.
   */
  sourceId: string
  /**
   * 'core' or a serviceSpecs key.
   */
  spec: string
  kind: ChunkKind
  /**
   * Pasteable JS accessor that resolves to the FULL untruncated source.
   */
  header: string
  /**
   * This chunk's searchable text (a fragment when `part` is set).
   */
  text: string
  /**
   * Present ONLY when the source description was split across chunks.
   */
  part?: { index: number, count: number }
}

export interface ChunkOptions {
  /**
   * Soft upper bound on chunk length before splitting kicks in (chars).
   */
  maxChars?: number
  /**
   * Chars of trailing context carried into the next fragment on a split.
   */
  overlapChars?: number
}

const DEFAULT_MAX_CHARS = 1000
const DEFAULT_OVERLAP_CHARS = 150

function joinText(parts: Array<string | undefined>): string {
  return parts.filter((p) => typeof p === 'string' && p.length > 0).join(' ')
}

// 'core' → coreSpec; everything else → serviceSpecs["<contextPath>"]. The
// accessor an agent pastes back into a query to read a hit's full source.
function specAccessor(specKey: string): string {
  return specKey === 'core' ? 'coreSpec' : `serviceSpecs[${JSON.stringify(specKey)}]`
}

/**
 * Split `text` into <= maxChars windows on sentence/paragraph boundaries, each
 * carrying ~overlapChars of trailing context from the previous window so a
 * concept straddling a boundary still appears whole in one fragment. Returns a
 * single-element array (no copy) when the text already fits.
 * @param text The source text to split.
 * @param maxChars Soft upper bound on each window's length.
 * @param overlapChars Trailing context carried into the next window.
 */
function splitText(text: string, maxChars: number, overlapChars: number): string[] {
  if (text.length <= maxChars)
    return [text]

  // Atomic pieces: sentence/line boundaries. Keeps related clauses together.
  const pieces = text.split(/(?<=[.!?\n])\s+/)
  const chunks: string[] = []
  let cur = ''

  const flush = (): void => {
    const trimmed = cur.trim()
    if (trimmed)
      chunks.push(trimmed)
  }

  for (const piece of pieces) {
    // A single piece longer than the budget (e.g. a giant code block with no
    // sentence breaks): hard-split it on raw char count.
    if (piece.length > maxChars) {
      flush()
      cur = ''
      for (let i = 0; i < piece.length; i += maxChars - overlapChars)
        chunks.push(piece.slice(i, i + maxChars))
      continue
    }
    if (cur.length > 0 && cur.length + piece.length + 1 > maxChars) {
      flush()
      const tail = cur.slice(Math.max(0, cur.length - overlapChars))
      cur = `${tail} ${piece}`
    } else {
      cur = cur ? `${cur} ${piece}` : piece
    }
  }
  flush()
  return chunks
}

// Emit one or more chunks for a single source doc, splitting `text` when needed
// and tagging fragments with shared sourceId/header + part info.
function emitChunks(
  out: SpecChunk[],
  source: { sourceId: string, spec: string, kind: ChunkKind, header: string, text: string },
  maxChars: number,
  overlapChars: number,
): void {
  if (!source.text)
    return
  const fragments = splitText(source.text, maxChars, overlapChars)
  if (fragments.length === 1) {
    out.push({ id: source.sourceId, sourceId: source.sourceId, spec: source.spec, kind: source.kind, header: source.header, text: fragments[0]! })
    return
  }
  fragments.forEach((text, index) => {
    out.push({
      id: `${source.sourceId}#part${index}`,
      sourceId: source.sourceId,
      spec: source.spec,
      kind: source.kind,
      header: source.header,
      text,
      part: { index, count: fragments.length },
    })
  })
}

/**
 * Bump when the chunking logic changes in a way that shifts chunk ids or text.
 * Prebuilt vector files store this; the runtime loader rejects a mismatch so
 * stale prebuilt embeddings can never be silently zipped onto fresh chunks.
 */
export const CHUNKER_VERSION = '1'

const HTTP_OPERATIONS = ['get', 'post', 'put', 'patch', 'delete']

/**
 * Chunk a SINGLE spec under the given key (`core`, or a service contextPath like
 * `dtm`). This is the unit both consumers share: {@link buildSpecChunks} calls
 * it per visible spec at runtime, and the build-time prebuild calls it per
 * snapshot so each version is embedded on its own. The `specKey` drives the
 * `sourceId`/`header` namespace, so a chunk's ids are identical whether built
 * here at build time or re-derived at runtime — which is what lets prebuilt
 * embeddings be zipped on by id.
 * @param specKey `core` or the service contextPath this spec is bound under.
 * @param spec The OpenAPI spec to chunk.
 * @param opts Chunking options (split size / overlap).
 */
export function chunkSpec(specKey: string, spec: ChunkSpec, opts: ChunkOptions = {}): SpecChunk[] {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS
  const overlapChars = opts.overlapChars ?? DEFAULT_OVERLAP_CHARS
  const accessor = specAccessor(specKey)
  const out: SpecChunk[] = []

  emitChunks(out, {
    sourceId: `${specKey}::spec`,
    spec: specKey,
    kind: 'spec',
    header: `${accessor}.info`,
    text: joinText([spec.info?.title, spec.info?.description]),
  }, maxChars, overlapChars)

  for (const tag of spec.tags ?? []) {
    if (!tag?.name)
      continue
    emitChunks(out, {
      sourceId: `${specKey}::tag::${tag.name}`,
      spec: specKey,
      kind: 'tag',
      header: `${accessor}.tags.find((t) => t.name === ${JSON.stringify(tag.name)})`,
      text: joinText([tag.name, tag.description]),
    }, maxChars, overlapChars)
  }

  for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
    if (!pathItem || typeof pathItem !== 'object')
      continue
    for (const method of HTTP_OPERATIONS) {
      const op = (pathItem as Record<string, unknown>)[method] as ChunkOperation | undefined
      if (!op || typeof op !== 'object')
        continue
      const paramText = Array.isArray(op.parameters)
        ? op.parameters.map((p) => {
            const exampleValues = p?.examples
              ? Object.values(p.examples).map((e) => joinText([typeof e?.value === 'string' ? e.value : undefined, e?.description])).join(' ')
              : ''
            return joinText([p?.name, p?.description, p?.schema?.format, exampleValues])
          }).join(' ')
        : ''
      emitChunks(out, {
        sourceId: `${specKey}::op::${method}::${path}`,
        spec: specKey,
        kind: 'endpoint',
        header: `${accessor}.paths[${JSON.stringify(path)}].${method}`,
        text: joinText([
          method.toUpperCase(),
          path,
          op.operationId,
          op.summary,
          op.description,
          Array.isArray(op.tags) ? op.tags.join(' ') : undefined,
          paramText,
        ]),
      }, maxChars, overlapChars)
    }
  }

  return out
}

/**
 * Flatten every visible spec into search chunks: one source per endpoint, per
 * declared tag, and per spec info block — each split into focused fragments
 * when its text exceeds `maxChars`. All specs land in ONE flat list (a shared
 * search space) so cross-spec references are discoverable in a single search.
 * @param core The core spec (the `coreSpec` binding).
 * @param serviceSpecs The service-spec map (the `serviceSpecs` binding), keyed by contextPath.
 * @param opts Chunking options (split size / overlap).
 */
export function buildSpecChunks(
  core: ChunkSpec,
  serviceSpecs: Record<string, ChunkSpec>,
  opts: ChunkOptions = {},
): SpecChunk[] {
  const entries: Array<[string, ChunkSpec]> = [['core', core], ...Object.entries(serviceSpecs)]
  return entries.flatMap(([specKey, spec]) => chunkSpec(specKey, spec, opts))
}
