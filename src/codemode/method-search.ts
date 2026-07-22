import MiniSearch from 'minisearch'

// ─────────────────────────────────────────────────────────────────────────
// Ranked search over derived namespace methods, backed by MiniSearch — the
// same engine as the docs index. Chosen over hand-tuned token scoring
// because specs are discovered at runtime: fuzzy matching absorbs
// singular/plural and typo drift generically, and OR-combination keeps
// recall when one query word has no counterpart in the spec vocabulary
// ("list assets" still ranks everything matching "assets"). The calling
// agent is the semantic layer — it reformulates queries; this engine just
// has to be forgiving enough that one phrasing hits.
//
// The index is cached by caller-supplied object identity (the resolved-specs
// object) and MUST stay policy-independent: restriction/allow rules differ
// per connection in server mode, so hits are filtered at query time via the
// `isVisible` predicate, never at build time.
// ─────────────────────────────────────────────────────────────────────────

const SEARCH_RESULT_LIMIT = 20

/**
 * One searchable derived method, flattened across namespaces.
 */
export interface SearchableMethod {
  /**
   * Describe target, e.g. `c8y.getAlarmCollectionResource`. Doubles as the
   * index id.
   */
  target: string
  namespace: string
  method: string
  /**
   * Uppercase HTTP method of the underlying operation.
   */
  httpMethod: string
  /**
   * REST path of the underlying operation, e.g. `/alarm/alarms`.
   */
  apiPath: string
  summary?: string
}

export interface MethodSearchResult extends SearchableMethod {
  score: number
}

export interface MethodSearchOutput {
  results: MethodSearchResult[]
  total: number
  truncated: boolean
}

export interface MethodIndex {
  mini: MiniSearch
  methods: Map<string, SearchableMethod>
}

/**
 * Split camelCase and path/identifier separators into searchable terms.
 * @param text
 */
function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
}

const indexCache = new WeakMap<object, MethodIndex>()

/**
 * Build (or return the cached) method index for a stable cache key — callers
 * pass the resolved-specs object, so the index lives exactly as long as the
 * tenant's spec resolution. Items must come from an unfiltered namespace
 * list to keep the cache policy-independent.
 * @param cacheKey
 * @param items
 */
export function getMethodIndex(cacheKey: object, items: () => readonly SearchableMethod[]): MethodIndex {
  const cached = indexCache.get(cacheKey)
  if (cached)
    return cached

  const list = items()
  const mini = new MiniSearch({
    idField: 'target',
    fields: ['method', 'apiPath', 'summary', 'namespace'],
    tokenize,
  })
  mini.addAll([...list])

  const index: MethodIndex = { mini, methods: new Map(list.map((m) => [m.target, m])) }
  indexCache.set(cacheKey, index)
  return index
}

/**
 * Search the method index with one query or several phrasings at once
 * (results are unioned, deduped by best score). The agent is encouraged to
 * pass variants — `["list assets", "asset collection"]` — in a single call.
 * @param index
 * @param query
 * @param isVisible Query-time policy filter — methods blocked for the
 *   current connection must not surface.
 */
export function searchMethods(
  index: MethodIndex,
  query: string | readonly string[],
  isVisible?: (target: string) => boolean,
): MethodSearchOutput {
  const queries = (Array.isArray(query) ? query : [query])
    .map((q) => typeof q === 'string' ? q.trim() : '')
    .filter(Boolean)
  if (queries.length === 0)
    return { results: [], total: 0, truncated: false }

  const bestScore = new Map<string, number>()
  for (const q of queries) {
    for (const hit of index.mini.search(q, {
      fuzzy: 0.2,
      prefix: true,
      boost: { method: 3, apiPath: 2, namespace: 1.5 },
    })) {
      const target = String(hit.id)
      if (isVisible && !isVisible(target))
        continue
      const previous = bestScore.get(target)
      if (previous === undefined || hit.score > previous)
        bestScore.set(target, hit.score)
    }
  }

  const ranked = [...bestScore.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([target, score]) => ({ ...index.methods.get(target)!, score }))

  return {
    results: ranked.slice(0, SEARCH_RESULT_LIMIT),
    total: ranked.length,
    truncated: ranked.length > SEARCH_RESULT_LIMIT,
  }
}
