import type { PathItem, Spec } from './spec-resolution'

interface XCodemodeItem {
  instruction: string
  include?: string
  includedPath?: string
  includedSpec?: PathItem
  query?: string
  queryPath?: string
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const

/**
 * Resolve `include` and `query` references in `x-codemode` operation hints.
 *
 * For `include` items: looks up the referenced path in the spec (pre-rewrite
 * paths, so `include` values match directly) and embeds the PathItem inline as
 * `includedSpec`. Also computes `includedPath` = servicePrefix + include so the
 * LLM can call `cumulocity.request()` with the correct post-rewrite path.
 *
 * For `query` items: only computes `queryPath` = servicePrefix + query. The
 * spec is NOT embedded — the LLM decides whether to query based on context.
 *
 * Instruction-only items (no `include`/`query`) pass through unchanged.
 *
 * Must be called BEFORE path rewriting so that `include`/`query` values still
 * match the keys in `spec.paths`.
 *
 * @param spec The OpenAPI spec to enrich in-place with resolved `x-codemode` includes/queries
 * @param servicePrefix Optional prefix to prepend to included/query paths (e.g.
 *   for bundled services, the context path like `/service/dtm`). Should be the
 *   same prefix that will be applied in the path rewriting step later.
 */
export function resolveCodeModeExtension(spec: Spec, servicePrefix?: string): void {
  for (const pathItem of Object.values(spec.paths)) {
    for (const method of HTTP_METHODS) {
      const op = (pathItem as Record<string, unknown>)[method] as Record<string, unknown> | undefined
      const hints = op?.['x-codemode'] as XCodemodeItem[] | undefined
      if (!Array.isArray(hints))
        continue
      for (const hint of hints) {
        if (hint.include) {
          const resolved = spec.paths[hint.include]
          if (resolved)
            hint.includedSpec = resolved
          hint.includedPath = (servicePrefix ?? '') + hint.include
        }
        if (hint.query) {
          hint.queryPath = (servicePrefix ?? '') + hint.query
        }
      }
    }
  }
}
