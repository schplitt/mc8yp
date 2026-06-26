// ─────────────────────────────────────────────────────────────────────────
// Spec → search documents
//
// The query sandbox gets a prebuilt minisearch index over every visible spec
// so the agent can keyword-search the whole OpenAPI surface at once (e.g. the
// Cumulocity query language, documented only in core but reused by other
// services) instead of walking each spec by hand.
//
// Sources are heterogeneous (endpoints vs tags vs the spec's own info block),
// so every document is collapsed to the SAME shape: a single searchable `text`
// field plus a human-readable `header` telling the agent what a hit is and
// which spec it came from. After a hit the agent reads `coreSpec` /
// `serviceSpecs` for the full detail.
// ─────────────────────────────────────────────────────────────────────────

// Runtime specs carry more than the narrow `Spec` type declares — `info`
// survives preprocessing, and operations keep `operationId`. Loose local views
// for exactly the fields we index.
interface IndexOperation {
  operationId?: string
  summary?: string
  description?: string
  tags?: string[]
  parameters?: Array<{ name?: string, description?: string, schema?: { format?: string }, examples?: Record<string, { value?: unknown, description?: string }> }>
}
interface IndexSpec {
  info?: { title?: string, description?: string }
  paths?: Record<string, Record<string, unknown>>
  tags?: Array<{ name?: string, description?: string }>
}

export interface SpecDoc {
  id: string
  header: string
  text: string
  kind: 'endpoint' | 'tag' | 'spec'
  spec: string
}

/**
 * MiniSearch constructor options. MUST be identical wherever the index is
 * built. A single indexed `text` field keeps the heterogeneous sources
 * uniform; `storeFields` carries back everything the agent reads off a hit.
 */
export const SPEC_INDEX_OPTIONS = {
  fields: ['text'],
  storeFields: ['header', 'text', 'kind', 'spec'],
} as const

/**
 * Flatten every visible spec into uniform search documents: one per endpoint,
 * one per declared tag, and one per spec (from its `info` block).
 *
 * IMPORTANT: this function is also serialized via `.toString()` into the query
 * run script and executed INSIDE the sandbox against the already-declared
 * `coreSpec` / `serviceSpecs` bindings (see {@link buildSpecSearchSource}), so
 * the spec content is not serialized a second time.
 * Keep it fully self-contained — no references to module-scope helpers,
 * imports, or constants — or the in-sandbox copy throws ReferenceError.
 * @param core The core spec (the `coreSpec` binding).
 * @param serviceSpecs The service-spec map (the `serviceSpecs` binding).
 */
export function buildSpecDocs(core: IndexSpec, serviceSpecs: Record<string, IndexSpec>): SpecDoc[] {
  const HTTP_OPERATIONS = ['get', 'post', 'put', 'patch', 'delete']
  const joinText = (parts: Array<string | undefined>): string =>
    parts.filter((p) => typeof p === 'string' && p.length > 0).join(' ')
  // JS accessor the agent can paste back into a query to read the full source
  // of a hit: `coreSpec` for core, `serviceSpecs["<contextPath>"]` otherwise.
  const specAccessor = (specKey: string): string =>
    specKey === 'core' ? 'coreSpec' : `serviceSpecs[${JSON.stringify(specKey)}]`

  const docs: SpecDoc[] = []
  const entries: Array<[string, IndexSpec]> = [['core', core], ...Object.entries(serviceSpecs)]

  for (const [specKey, spec] of entries) {
    const accessor = specAccessor(specKey)

    // spec doc — info.title / info.description. The header is a pasteable
    // accessor: reading it returns the full info block.
    const specText = joinText([spec.info?.title, spec.info?.description])
    if (specText) {
      docs.push({
        id: `${specKey}::spec`,
        header: `${accessor}.info`,
        text: specText,
        kind: 'spec',
        spec: specKey,
      })
    }

    // tag docs. The header is a pasteable accessor that resolves to the tag
    // object (read `.description` off it for the full text).
    for (const tag of spec.tags ?? []) {
      if (!tag?.name)
        continue
      docs.push({
        id: `${specKey}::tag::${tag.name}`,
        header: `${accessor}.tags.find((t) => t.name === ${JSON.stringify(tag.name)})`,
        text: joinText([tag.name, tag.description]),
        kind: 'tag',
        spec: specKey,
      })
    }

    // endpoint docs — one per operation
    for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
      if (!pathItem || typeof pathItem !== 'object')
        continue
      for (const method of HTTP_OPERATIONS) {
        const op = (pathItem as Record<string, unknown>)[method] as IndexOperation | undefined
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
        docs.push({
          id: `${specKey}::op::${method}::${path}`,
          // Points straight at the source: e.g. coreSpec.paths["/x"].get
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
          kind: 'endpoint',
          spec: specKey,
        })
      }
    }
  }

  return docs
}

/**
 * Sandbox-side `searchSpecs` helper, declared at module scope in the query run
 * script (closes over `__specIndex`). Returns minisearch's ranked hits
 * (header/text/truncated/kind/spec/score), filtered by `minScore`, capped at
 * `limit`.
 *
 * Each hit's `text` is a SEARCH PREVIEW: long matches are truncated to
 * `maxTextLength` chars (default 800) and wrapped with `[TRUNCATED PREVIEW …]`
 * markers — at the top and bottom — that name the hit's `header` accessor so
 * the agent reads the full, untruncated source by pasting that accessor into a
 * follow-up `query` call. We deliberately truncate HERE (in search) and never
 * in the spec bindings themselves: a hit is a pointer, the binding is the
 * source of truth.
 */
export const SEARCH_SPECS_SOURCE = `function searchSpecs(query, opts) {
  if (typeof query !== 'string' || query.trim() === '') {
    throw new TypeError('searchSpecs(query, opts): query must be a non-empty string');
  }
  const options = opts || {};
  const limit = typeof options.limit === 'number' ? options.limit : 10;
  const fuzzy = typeof options.fuzzy === 'number' ? options.fuzzy : 0.2;
  const prefix = options.prefix !== false;
  const maxText = typeof options.maxTextLength === 'number' && options.maxTextLength > 0 ? options.maxTextLength : 800;
  let results = __specIndex.search(query, { fuzzy, prefix });
  if (typeof options.minScore === 'number') results = results.filter((r) => r.score >= options.minScore);
  return results.slice(0, limit).map((r) => {
    const full = typeof r.text === 'string' ? r.text : '';
    const truncated = full.length > maxText;
    let text = full;
    if (truncated) {
      const head = '[TRUNCATED PREVIEW — showing first ' + maxText + ' of ' + full.length + ' chars; this text is INCOMPLETE. Read the full, untruncated source in code via: ' + r.header + ']\\n\\n';
      const foot = '\\n\\n[END TRUNCATED PREVIEW — content was cut off. Do not rely on this preview; read the full source via: ' + r.header + ']';
      text = head + full.slice(0, maxText) + foot;
    }
    return { header: r.header, text: text, truncated: truncated, kind: r.kind, spec: r.spec, score: r.score };
  });
}`

/**
 * Source for the search part of the query run script. Assumes `MiniSearch`,
 * `coreSpec`, and `serviceSpecs` are already in scope: builds the minisearch
 * index from the specs (extracting documents in-sandbox so the spec content is
 * not serialized a second time) and declares the `searchSpecs` helper.
 *
 * Built per query() call for now; caching it in a precompiled prefix so the
 * index survives across calls is a planned follow-up.
 */
export function buildSpecSearchSource(): string {
  return [
    `const __specIndex = new MiniSearch(${JSON.stringify(SPEC_INDEX_OPTIONS)});`,
    `__specIndex.addAll((${buildSpecDocs.toString()})(coreSpec, serviceSpecs));`,
    SEARCH_SPECS_SOURCE,
  ].join('\n')
}
