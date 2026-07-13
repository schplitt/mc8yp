import MiniSearch from 'minisearch'

// ─────────────────────────────────────────────────────────────────────────
// Host-side MiniSearch index over spec documentation.
//
// This is the prose search ("how do I use it") complementing the
// name-oriented method search. It carries exactly two kinds of documents:
//
//   - `topic`    — one per spec tag. Tag descriptions hold the cross-cutting
//                  domain docs (the Cumulocity query grammar lives in the
//                  "Query language" tag, notifications in "About
//                  notifications 2.0", …).
//   - `overview` — one per spec info block.
//
// Endpoints deliberately contribute NOTHING here. Per-endpoint prose
// (operation description, parameter docs) is delivered by
// codemode.describe("<ns>.<method>"), and finding endpoints is
// codemode.search's job. When a parameter description points at a concept
// ("details in Query language"), the agent turns that phrase into a
// docs.search — the topic title match ranks it first.
//
// Search hits carry a truncated PREVIEW that names the `docs.read(id)` call
// returning the full text — truncation happens only in search results,
// never in the stored docs.
//
// The index is cached by caller-supplied object identity (the resolved-specs
// object). Topics and overviews are tenant-level documentation, not
// operations, so no per-connection policy filtering applies.
// ─────────────────────────────────────────────────────────────────────────

const DEFAULT_PREVIEW_LENGTH = 800

/**
 * Loose runtime view of the spec fields the index reads.
 */
interface IndexSpec {
  info?: { title?: string, description?: string }
  tags?: Array<{ name?: string, description?: string }>
}

export interface DocsIndexEntry {
  /**
   * Sandbox namespace the spec is exposed under (e.g. `c8y`, `dtm`).
   */
  namespace: string
  spec: unknown
}

export interface SpecDoc {
  id: string
  title: string
  text: string
  kind: 'topic' | 'overview'
  namespace: string
}

export interface DocsSearchOptions {
  limit?: number
  fuzzy?: number
  prefix?: boolean
  minScore?: number
  maxTextLength?: number
}

export interface DocsSearchHit {
  id: string
  title: string
  /**
   * Preview of the matched text — read the full text via `docs.read(id)`.
   */
  text: string
  truncated: boolean
  kind: SpecDoc['kind']
  namespace: string
  score: number
}

export interface DocsIndex {
  mini: MiniSearch
  docs: Map<string, SpecDoc>
}

function joinText(parts: Array<string | undefined>): string {
  return parts.filter((p): p is string => typeof p === 'string' && p.length > 0).join(' ')
}

/**
 * Flatten every visible spec into uniform docs: one per declared tag
 * (topic) and one per spec info block (overview).
 * @param entries
 */
export function buildSpecDocs(entries: readonly DocsIndexEntry[]): SpecDoc[] {
  const docs: SpecDoc[] = []

  for (const { namespace, spec } of entries) {
    const indexSpec = spec as IndexSpec

    const overviewText = joinText([indexSpec.info?.title, indexSpec.info?.description])
    if (overviewText) {
      docs.push({
        id: `${namespace}::overview`,
        title: indexSpec.info?.title ?? namespace,
        text: overviewText,
        kind: 'overview',
        namespace,
      })
    }

    for (const tag of indexSpec.tags ?? []) {
      if (!tag?.name)
        continue
      docs.push({
        id: `${namespace}::topic::${tag.name}`,
        title: tag.name,
        text: joinText([tag.name, tag.description]),
        kind: 'topic',
        namespace,
      })
    }
  }

  return docs
}

const indexCache = new WeakMap<object, DocsIndex>()

/**
 * Build (or return the cached) docs index for a stable cache key — callers
 * pass the resolved-specs object, so the index lives exactly as long as the
 * tenant's spec resolution.
 * @param cacheKey
 * @param entries
 */
export function getDocsIndex(cacheKey: object, entries: () => readonly DocsIndexEntry[]): DocsIndex {
  const cached = indexCache.get(cacheKey)
  if (cached)
    return cached

  const docs = buildSpecDocs(entries())
  // Hits are hydrated from the docs map, so nothing needs storeFields.
  const mini = new MiniSearch({
    fields: ['title', 'text'],
  })
  mini.addAll(docs)

  const index: DocsIndex = { mini, docs: new Map(docs.map((d) => [d.id, d])) }
  indexCache.set(cacheKey, index)
  return index
}

/**
 * Ranked fuzzy/prefix search over the docs. Long matches are truncated to a
 * preview wrapped with markers naming the `docs.read(id)` call that returns
 * the full text.
 * @param index
 * @param query
 * @param options
 */
export function searchDocs(index: DocsIndex, query: string, options: DocsSearchOptions = {}): DocsSearchHit[] {
  if (typeof query !== 'string' || query.trim() === '')
    throw new TypeError('docs.search(query): query must be a non-empty string')

  const limit = options.limit ?? 10
  const maxText = options.maxTextLength && options.maxTextLength > 0 ? options.maxTextLength : DEFAULT_PREVIEW_LENGTH

  let results = index.mini.search(query, {
    fuzzy: options.fuzzy ?? 0.2,
    prefix: options.prefix !== false,
    boost: { title: 2 },
  })
  if (typeof options.minScore === 'number')
    results = results.filter((r) => r.score >= options.minScore!)

  const hits: DocsSearchHit[] = []
  for (const result of results) {
    if (hits.length >= limit)
      break
    const doc = index.docs.get(String(result.id))
    if (!doc)
      continue

    const truncated = doc.text.length > maxText
    const text = truncated
      ? `[TRUNCATED PREVIEW — showing first ${maxText} of ${doc.text.length} chars; this text is INCOMPLETE. Read the full text via: docs.read(${JSON.stringify(doc.id)})]\n\n${doc.text.slice(0, maxText)}\n\n[END TRUNCATED PREVIEW — read the full text via: docs.read(${JSON.stringify(doc.id)})]`
      : doc.text

    hits.push({
      id: doc.id,
      title: doc.title,
      text,
      truncated,
      kind: doc.kind,
      namespace: doc.namespace,
      score: result.score,
    })
  }

  return hits
}

/**
 * Return the full, untruncated doc for an id from a search hit.
 * @param index
 * @param id
 */
export function readDoc(index: DocsIndex, id: string): SpecDoc | null {
  if (typeof id !== 'string' || id.trim() === '')
    throw new TypeError('docs.read(id): id must be a non-empty string')
  return index.docs.get(id) ?? null
}
