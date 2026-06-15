/**
 * OpenAPI minification — the second stage of the code-mode preprocessing
 * pipeline (see openapi-preprocessor.ts). Kept as a standalone leaf module with
 * no relative imports so it can be loaded directly by tsdown's native config
 * loader at build time (which cannot resolve extensionless relative imports)
 * alongside resolve-refs.ts, while {@link preprocessOpenApi} composes the two.
 *
 * Every rule is a value-deleting or value-shortening pass over a dereferenced,
 * JSON-serialisable document and keeps it JSON-serialisable — the invariant the
 * sandbox entry script depends on. The OpenAPI *shape* is preserved so the
 * query sandbox access patterns and prompts keep working unchanged.
 */

/**
 * The Cumulocity-specific OpenAPI vendor extension that code mode consumes
 * (instructions + include/query hints). It must survive {@link MinifyRules.dropVendorExtensions}.
 */
const PRESERVED_EXTENSION = 'x-codemode'

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace'] as const

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/**
 * Toggles for individual minification passes. All passes are independent; the
 * order in which they run is fixed by {@link minifySpec}, not by this object.
 */
export interface MinifyRules {
  /**
   * Keep only success (2xx) response entries — and `default` when no 2xx exists.
   * Code mode receives the raw HTTP response at runtime, so error-response
   * schemas add no value for planning a call. Default: on.
   */
  dropNon2xxResponses: boolean
  /**
   * Recursively delete vendor extension keys (`x-*`), except {@link PRESERVED_EXTENSION}.
   * Default: on.
   */
  dropVendorExtensions: boolean
  /**
   * Recursively delete JSON-Schema/example noise: `$schema`, `example`, `examples`.
   * Default: on.
   */
  dropSchemaMeta: boolean
  /**
   * Delete operation `tags` and the top-level `tags[]` array. Default: on.
   */
  dropTags: boolean
  /**
   * Delete `security` arrays that carry no meaningful information: a literal
   * empty `[]` or an array whose every requirement object has only empty scope
   * arrays (e.g. `[{"Basic":[]},{"SSO":[]}]` — auth schemes are declared but
   * no OAuth scopes are required). Default: on.
   */
  dropEmptySecurity: boolean
  /**
   * Unconditionally delete all `security` fields (top-level and per-operation),
   * plus `components.securitySchemes` (OpenAPI 3.x) and `securityDefinitions`
   * (OpenAPI 2.x). Use when authentication is handled entirely outside the spec
   * (e.g. by the code-mode request middleware) and the security declarations are
   * pure noise. Takes precedence over {@link dropEmptySecurity}. Default: off.
   */
  dropSecurity: boolean
  /**
   * Truncate every `description` string value to its first sentence. Lossy —
   * opt-in. Mutually superseded by {@link dropDescriptions}. Default: off.
   */
  shortenDescriptions: boolean
  /**
   * Recursively delete every `description` string value (parameters, schemas,
   * operations…). Heaviest reduction, most lossy. Takes precedence over
   * {@link shortenDescriptions}. Default: off.
   */
  dropDescriptions: boolean
  /**
   * Within each `content` map (request bodies, responses, parameters), keep
   * only `application/json` — but only when that key is present, so endpoints
   * that expose only Cumulocity vendor media types are left untouched.
   * Default: off.
   */
  jsonMediaTypeOnly: boolean
  /**
   * Ref-aware pruning of `components`/`definitions`: after dereference these
   * blocks are largely dead duplication, but circular refs are left as `$ref`
   * (resolve-refs.ts uses `circular: 'ignore'`) so they cannot be dropped
   * blindly. This keeps only entries still reachable through a surviving
   * `$ref` (transitively) and drops the rest. Default: off.
   */
  pruneComponents: boolean
  /**
   * Drop operations flagged `deprecated: true`, and any path that becomes empty
   * as a result. Default: off.
   */
  dropDeprecated: boolean
  /**
   * Recursively remove properties whose value equals the JSON Schema / OpenAPI
   * default for that key, since they carry no information beyond the implicit
   * default. Covered keys and their defaults:
   *
   * | key                  | default  | spec origin          |
   * |----------------------|----------|----------------------|
   * | additionalProperties | `true`   | JSON Schema          |
   * | uniqueItems          | `false`  | JSON Schema          |
   * | readOnly             | `false`  | JSON Schema / OAS    |
   * | writeOnly            | `false`  | JSON Schema / OAS    |
   * | nullable             | `false`  | OpenAPI 3.0          |
   * | deprecated           | `false`  | OpenAPI (op+schema)  |
   * | exclusiveMinimum     | `false`  | JSON Schema draft 4  |
   * | exclusiveMaximum     | `false`  | JSON Schema draft 4  |
   * | required             | `false`  | OpenAPI parameter    |
   *
   * Note: `required` here is the boolean parameter field (optional parameter),
   * not the array form used in schema objects. Default: on.
   */
  dropSchemaDefaults: boolean
}

/**
 * The five passes that are safe and lossless enough to run by default. Lossy
 * passes (description handling) and structural passes (`pruneComponents`,
 * `jsonMediaTypeOnly`, `dropDeprecated`) are opt-in and selected explicitly.
 */
export const DEFAULT_MINIFY_RULES: MinifyRules = {
  dropNon2xxResponses: true,
  dropVendorExtensions: true,
  dropSchemaMeta: true,
  dropTags: true,
  dropEmptySecurity: true,
  dropSecurity: false,
  shortenDescriptions: false,
  dropDescriptions: false,
  jsonMediaTypeOnly: false,
  pruneComponents: false,
  dropDeprecated: false,
  dropSchemaDefaults: true,
}

/**
 * The rule set actually applied to every spec that reaches the code-mode
 * sandbox, build-time and runtime alike. On top of the five lossless defaults
 * it enables `pruneComponents` (ref-aware, typically the single largest
 * reduction once schemas are inlined). `jsonMediaTypeOnly` is intentionally
 * left off: Cumulocity exposes canonical vendor media types
 * (`application/vnd.com.nsn.cumulocity.*+json`) that must survive.
 */
export const PRODUCTION_MINIFY_RULES: MinifyRules = {
  ...DEFAULT_MINIFY_RULES,
  pruneComponents: true,
}

/**
 * Normalise a minify selector into a concrete rule set, or `null` for "no
 * minification".
 * - `false`/`undefined` → null
 * - `true` → {@link DEFAULT_MINIFY_RULES}
 * - object → {@link DEFAULT_MINIFY_RULES} with the given fields overridden.
 * @param minify Selector: boolean or a partial rule override.
 */
export function resolveMinifyRules(minify: boolean | Partial<MinifyRules> | undefined): MinifyRules | null {
  if (!minify)
    return null
  if (minify === true)
    return DEFAULT_MINIFY_RULES
  return { ...DEFAULT_MINIFY_RULES, ...minify }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Apply the enabled minification passes to a dereferenced OpenAPI document in
 * place.
 * @param spec Dereferenced OpenAPI document. Mutated in place.
 * @param rules Which passes to run.
 */
export function minifySpec(spec: Record<string, unknown>, rules: MinifyRules): void {
  // 1. Recursive value-level cleanup (extensions, schema meta, descriptions,
  //    redundant schema defaults). Runs first so structural passes and ref
  //    collection see the final, stripped values.
  if (rules.dropVendorExtensions || rules.dropSchemaMeta || rules.dropDescriptions || rules.shortenDescriptions)
    recursiveClean(spec, rules)
  if (rules.dropSchemaDefaults)
    dropSchemaDefaults(spec)

  // 2. Structured per-operation + top-level passes (responses, tags, security,
  //    media types, deprecated). These understand OpenAPI shape, so they are
  //    precise where a blind walk would risk hitting same-named data fields.
  applyStructuralPasses(spec, rules)

  // 3. Ref-aware component pruning. Last, so it sees the refs that survive all
  //    earlier removals (e.g. dropped deprecated operations).
  if (rules.pruneComponents)
    pruneComponents(spec)
}

// ---------------------------------------------------------------------------
// Stage 1 — recursive value cleanup
// ---------------------------------------------------------------------------

function recursiveClean(node: unknown, rules: MinifyRules): void {
  if (Array.isArray(node)) {
    for (const item of node)
      recursiveClean(item, rules)
    return
  }
  if (!isRecord(node))
    return

  for (const key of Object.keys(node)) {
    if (rules.dropVendorExtensions && key.startsWith('x-') && key !== PRESERVED_EXTENSION) {
      delete node[key]
      continue
    }
    if (rules.dropSchemaMeta && (key === '$schema' || key === 'example' || key === 'examples')) {
      delete node[key]
      continue
    }
    if (key === 'description' && typeof node[key] === 'string') {
      if (rules.dropDescriptions) {
        delete node[key]
        continue
      }
      if (rules.shortenDescriptions)
        node[key] = firstSentence(node[key])
    }
    recursiveClean(node[key], rules)
  }
}

/**
 * First sentence of a description: the first line, trimmed to its first
 * sentence-terminator when one exists, otherwise the whole first line.
 * @param text Description string to truncate.
 */
function firstSentence(text: string): string {
  const firstLine = (text.trim().split('\n', 1)[0] ?? '').trim()
  const match = firstLine.match(/^(.*?[.!?])(?:\s|$)/)
  return match?.[1] ?? firstLine
}

/**
 * JSON Schema / OpenAPI keys whose explicit value equals the implicit default.
 * Presence of such a key is pure noise: the consumer would get the same
 * behaviour whether the key is there or not.
 */
const SCHEMA_DEFAULTS: Record<string, unknown> = {
  additionalProperties: true,
  uniqueItems: false,
  readOnly: false,
  writeOnly: false,
  nullable: false,
  deprecated: false,
  exclusiveMinimum: false, // JSON Schema draft 4 boolean form only
  exclusiveMaximum: false, // JSON Schema draft 4 boolean form only
  required: false, // OpenAPI parameter field (not the schema array form)
}

function dropSchemaDefaults(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) dropSchemaDefaults(item)
    return
  }
  if (!isRecord(node))
    return
  for (const key of Object.keys(node)) {
    if (Object.hasOwn(SCHEMA_DEFAULTS, key) && node[key] === SCHEMA_DEFAULTS[key])
      delete node[key]
    else
      dropSchemaDefaults(node[key])
  }
}

// ---------------------------------------------------------------------------
// Stage 2 — structural passes
// ---------------------------------------------------------------------------

function applyStructuralPasses(spec: Record<string, unknown>, rules: MinifyRules): void {
  if (rules.dropTags)
    delete spec.tags
  if (rules.dropSecurity || (rules.dropEmptySecurity && isEffectivelyEmptySecurity(spec.security)))
    delete spec.security
  if (rules.dropSecurity) {
    if (isRecord(spec.components))
      delete (spec.components as Record<string, unknown>).securitySchemes
    delete spec.securityDefinitions
  }

  const paths = spec.paths
  if (!isRecord(paths))
    return

  for (const pathKey of Object.keys(paths)) {
    const pathItem = paths[pathKey]
    if (!isRecord(pathItem))
      continue

    let remainingMethods = 0
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method]
      if (!isRecord(operation))
        continue

      if (rules.dropDeprecated && operation.deprecated === true) {
        delete pathItem[method]
        continue
      }

      processOperation(operation, rules)
      remainingMethods++
    }

    // A path item with no operations left is dead weight.
    if (rules.dropDeprecated && remainingMethods === 0)
      delete paths[pathKey]
  }
}

function processOperation(operation: Record<string, unknown>, rules: MinifyRules): void {
  if (rules.dropTags)
    delete operation.tags
  if (rules.dropSecurity || (rules.dropEmptySecurity && isEffectivelyEmptySecurity(operation.security)))
    delete operation.security

  if (rules.dropNon2xxResponses && isRecord(operation.responses))
    filterResponses(operation.responses)

  if (rules.jsonMediaTypeOnly) {
    trimContent(operation.requestBody)
    if (isRecord(operation.responses)) {
      for (const response of Object.values(operation.responses))
        trimContent(response)
    }
    if (Array.isArray(operation.parameters)) {
      for (const parameter of operation.parameters)
        trimContent(parameter)
    }
  }
}

/**
 * Keep only success responses. Prefers explicit 2xx codes (and the `2XX`
 * range form); falls back to `default` when there is no 2xx; leaves the
 * responses untouched if neither exists so an error-only operation is never
 * emptied out.
 * @param responses Operation `responses` object, keyed by status code. Mutated in place.
 */
function filterResponses(responses: Record<string, unknown>): void {
  const keys = Object.keys(responses)
  const successKeys = keys.filter((k) => /^2\d\d$/.test(k) || /^2xx$/i.test(k))

  let keep: Set<string>
  if (successKeys.length > 0)
    keep = new Set(successKeys)
  else if ('default' in responses)
    keep = new Set(['default'])
  else
    return

  for (const key of keys) {
    if (!keep.has(key))
      delete responses[key]
  }
}

/**
 * Within a content holder ({ content: { <mediaType>: ... } }), keep only
 * `application/json` — but only if it is present, so vendor-only media types
 * are preserved intact.
 * @param holder Request body / response / parameter object that may carry a `content` map.
 */
function trimContent(holder: unknown): void {
  if (!isRecord(holder) || !isRecord(holder.content))
    return
  const content = holder.content
  if (!('application/json' in content))
    return
  for (const mediaType of Object.keys(content)) {
    if (mediaType !== 'application/json')
      delete content[mediaType]
  }
}

// ---------------------------------------------------------------------------
// Stage 3 — ref-aware component pruning
// ---------------------------------------------------------------------------

function pruneComponents(spec: Record<string, unknown>): void {
  const hasComponents = isRecord(spec.components)
  const hasDefinitions = isRecord(spec.definitions)
  if (!hasComponents && !hasDefinitions)
    return

  // Reachable closure of $ref targets, seeded from everything *outside* the
  // component containers, then expanded through refs found inside reached
  // component nodes.
  const reachable = new Set<string>()
  const pending: string[] = []

  const seed = (refs: Iterable<string>): void => {
    for (const ref of refs) {
      if (!reachable.has(ref)) {
        reachable.add(ref)
        pending.push(ref)
      }
    }
  }

  const initial = new Set<string>()
  for (const [key, value] of Object.entries(spec)) {
    if (key === 'components' || key === 'definitions')
      continue
    collectRefs(value, initial)
  }
  seed(initial)

  while (pending.length > 0) {
    const ref = pending.pop()!
    const segments = refToSegments(ref)
    if (!segments)
      continue
    const node = resolvePointer(spec, segments)
    const found = new Set<string>()
    collectRefs(node, found)
    seed(found)
  }

  if (hasComponents) {
    const components = spec.components as Record<string, unknown>
    for (const [section, entries] of Object.entries(components)) {
      if (!isRecord(entries))
        continue
      for (const name of Object.keys(entries)) {
        if (!reachable.has(`#/components/${encodeSegment(section)}/${encodeSegment(name)}`))
          delete entries[name]
      }
      if (Object.keys(entries).length === 0)
        delete components[section]
    }
    if (Object.keys(components).length === 0)
      delete spec.components
  }

  if (hasDefinitions) {
    const definitions = spec.definitions as Record<string, unknown>
    for (const name of Object.keys(definitions)) {
      if (!reachable.has(`#/definitions/${encodeSegment(name)}`))
        delete definitions[name]
    }
    if (Object.keys(definitions).length === 0)
      delete spec.definitions
  }
}

function collectRefs(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node)
      collectRefs(item, out)
    return
  }
  if (!isRecord(node))
    return
  for (const [key, value] of Object.entries(node)) {
    if (key === '$ref' && typeof value === 'string')
      out.add(value)
    else
      collectRefs(value, out)
  }
}

function refToSegments(ref: string): string[] | null {
  if (!ref.startsWith('#/'))
    return null
  return ref.slice(2).split('/').map((seg) => seg.replace(/~1/g, '/').replace(/~0/g, '~'))
}

function resolvePointer(root: Record<string, unknown>, segments: string[]): unknown {
  let current: unknown = root
  for (const segment of segments) {
    if (!isRecord(current))
      return undefined
    current = current[segment]
  }
  return current
}

function encodeSegment(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1')
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * A security array is "effectively empty" when it carries no meaningful
 * constraint: either it is a literal `[]` (no-auth override) or every
 * requirement object in it has only empty scope arrays (e.g.
 * `[{"Basic":[]},{"SSO":[]}]` — schemes declared, no OAuth scopes required).
 * @param value The `security` field value to test.
 */
function isEffectivelyEmptySecurity(value: unknown): boolean {
  if (!Array.isArray(value))
    return false
  if (value.length === 0)
    return true
  return value.every(
    (req) => isRecord(req) && Object.values(req).every((scopes) => Array.isArray(scopes) && scopes.length === 0),
  )
}
