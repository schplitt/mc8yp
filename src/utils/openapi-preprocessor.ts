/**
 * OpenAPI preprocessing pipeline for code mode.
 *
 * Both the build-time bundled specs (tsdown.config.ts) and the live-discovered
 * specs (api-discovery.ts) are run through this before they are stored and
 * `JSON.stringify`'d into the code-mode query sandbox. The resolved specs are
 * inlined verbatim into the sandbox entry script, so every field that survives
 * here is a byte the model pays for in context. The goal is to keep the
 * OpenAPI *shape* the query sandbox and prompts already expect while stripping
 * everything the code-mode client does not need to plan a request.
 *
 * Stages, in order:
 *   1. dereference  — inline same-document `$ref`s (see {@link resolveInternalRefs})
 *   2. minify       — drop / shorten fields per a configurable rule set ({@link minifySpec})
 *
 * A future third "format" stage (a terser non-OpenAPI representation) can slot
 * in after minify without touching the upstream stages or the callers.
 *
 * The minify rules live in openapi-minify.ts, a leaf module with no relative
 * imports, so tsdown's native build-time config loader can import the minify
 * logic and resolve-refs.ts directly (it cannot resolve extensionless relative
 * imports through this composing module).
 */

import type { MinifyRules } from './openapi-minify'
import { minifySpec, PRODUCTION_MINIFY_RULES, resolveMinifyRules } from './openapi-minify'
import { resolveInternalRefs } from './resolve-refs'

export type { MinifyRules } from './openapi-minify'
export { DEFAULT_MINIFY_RULES } from './openapi-minify'

export interface PreprocessOptions {
  /**
   * Inline same-document `$ref`s before minifying. Default: on.
   */
  dereference?: boolean
  /**
   * Minification config:
   * - `false`/omitted → no minification, dereference only.
   * - `true` → the default lossless rule set.
   * - object → the default rule set with the given fields overridden, so
   *   callers can both enable opt-in passes and disable defaults.
   */
  minify?: boolean | Partial<MinifyRules>
}

/**
 * Single source of truth for the preprocessing applied to every spec that
 * reaches the code-mode sandbox, build-time and runtime alike. Keeping it here
 * (rather than at each call site) means the bundled and live-discovered specs
 * cannot drift apart. The rule set is {@link PRODUCTION_MINIFY_RULES}.
 */
export const DEFAULT_PREPROCESS_OPTIONS: PreprocessOptions = {
  dereference: true,
  minify: PRODUCTION_MINIFY_RULES,
}

/**
 * Dereference and minify an OpenAPI document in place, returning it.
 *
 * Defensive by the same contract as {@link resolveInternalRefs}: dereference
 * failures fall back to the original document, and the minify stage operates
 * only on recognised structures, so an unusual document is shrunk where
 * possible and otherwise passed through.
 * @param spec OpenAPI document. Mutated in place.
 * @param options Pipeline configuration. Defaults to dereference-only.
 */
export async function preprocessOpenApi<T extends object>(
  spec: T,
  options: PreprocessOptions = {},
): Promise<T> {
  const dereferenced = options.dereference === false
    ? spec
    : await resolveInternalRefs(spec)

  const rules = resolveMinifyRules(options.minify)
  if (rules)
    minifySpec(dereferenced as Record<string, unknown>, rules)

  return dereferenced
}
