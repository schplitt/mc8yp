import { resolveInternalRefs } from './resolve-refs.ts'

const PRESERVED_EXTENSION = 'x-codemode'

// `required: false` matches only the parameter boolean form — the schema's
// `required: string[]` array never compares equal to `false`.
const SCHEMA_DEFAULTS: Record<string, unknown> = {
  additionalProperties: true,
  uniqueItems: false,
  readOnly: false,
  writeOnly: false,
  nullable: false,
  deprecated: false,
  exclusiveMinimum: false,
  exclusiveMaximum: false,
  required: false,
  servicePrefix: '',
}

export interface PreprocessOptions {
  // Inline same-document `$ref`s. Orphan schemas (in `components.schemas` /
  // root `definitions`) are always dropped regardless of this flag.
  dereference?: boolean
  // Keep only 2xx responses (falls back to `default` when none).
  dropNon2xxResponses?: boolean
  // Drop `x-*` keys except `x-codemode`.
  dropVendorExtensions?: boolean
  // Drop the JSON Schema dialect marker `$schema`. `example` / `examples` are preserved.
  dropSchemaMeta?: boolean
  // Drop operation `tags` and the top-level `tags[]` array.
  dropTags?: boolean
  // Drop `security` arrays carrying no constraint (`[]` or all-empty scopes).
  dropEmptySecurity?: boolean
  // Drop properties explicitly set to their implicit JSON Schema / OpenAPI default.
  dropSchemaDefaults?: boolean
  // Prefix all paths with this service prefix (e.g. "/service/dtm"). Idempotent:
  // paths that already start with the prefix are left unchanged.
  servicePrefix?: string
}

export const DEFAULT_PREPROCESS_OPTIONS: Required<PreprocessOptions> = {
  dereference: false,
  dropNon2xxResponses: true,
  dropVendorExtensions: true,
  dropSchemaMeta: true,
  dropTags: true,
  dropEmptySecurity: true,
  dropSchemaDefaults: true,
  servicePrefix: '',
}

export async function preprocessOpenApi<T extends object>(spec: T, options: PreprocessOptions = {}): Promise<T> {
  const { servicePrefix, ...minifyOptions } = options
  const opts: Required<PreprocessOptions> = { ...DEFAULT_PREPROCESS_OPTIONS, ...minifyOptions }
  const result: T = opts.dereference ? await resolveInternalRefs(spec) : spec
  minifySpec(result as Record<string, unknown>, minifyOptions)
  if (servicePrefix)
    rewriteServicePaths(result as Record<string, unknown>, servicePrefix)
  return result
}

export function minifySpec(spec: Record<string, unknown>, options: PreprocessOptions = {}): void {
  const opts = { ...DEFAULT_PREPROCESS_OPTIONS, ...options }
  if (opts.dropVendorExtensions || opts.dropSchemaMeta || opts.dropSchemaDefaults)
    cleanValues(spec, opts)
  applyStructural(spec, opts)
  pruneOrphanSchemas(spec)
}

function cleanValues(node: unknown, opts: Required<PreprocessOptions>): void {
  if (Array.isArray(node)) {
    for (const item of node) cleanValues(item, opts)
    return
  }
  if (!isObject(node))
    return
  for (const key of Object.keys(node)) {
    if (opts.dropVendorExtensions && key.startsWith('x-') && key !== PRESERVED_EXTENSION) {
      delete node[key]
      continue
    }
    if (opts.dropSchemaMeta && key === '$schema') {
      delete node[key]
      continue
    }
    if (opts.dropSchemaDefaults && Object.hasOwn(SCHEMA_DEFAULTS, key) && node[key] === SCHEMA_DEFAULTS[key]) {
      delete node[key]
      continue
    }
    cleanValues(node[key], opts)
  }
}

function applyStructural(spec: Record<string, unknown>, opts: Required<PreprocessOptions>): void {
  if (opts.dropTags)
    delete spec.tags
  if (opts.dropEmptySecurity && isEffectivelyEmptySecurity(spec.security))
    delete spec.security

  const paths = spec.paths
  if (!isObject(paths))
    return
  for (const pathItem of Object.values(paths)) {
    if (!isObject(pathItem))
      continue
    // Non-operations (parameters[], summary, $ref, servers[]) fail isObject.
    for (const op of Object.values(pathItem)) {
      if (!isObject(op))
        continue
      if (opts.dropTags)
        delete op.tags
      if (opts.dropEmptySecurity && isEffectivelyEmptySecurity(op.security))
        delete op.security
      if (opts.dropNon2xxResponses && isObject(op.responses))
        filterResponses(op.responses)
    }
  }
}

// Prefer 2xx; fall back to `default`; never empty out an error-only operation.
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

// Drops unreachable entries from `components.schemas` and root `definitions`.
// Custom sections (e.g. `instructions`) are never touched.
function pruneOrphanSchemas(spec: Record<string, unknown>): void {
  const components = isObject(spec.components) ? spec.components as Record<string, unknown> : undefined
  const hasSchemas = !!components && isObject(components.schemas)
  const hasDefinitions = isObject(spec.definitions)
  if (!hasSchemas && !hasDefinitions)
    return

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

  if (hasSchemas) {
    const schemas = components!.schemas as Record<string, unknown>
    for (const name of Object.keys(schemas)) {
      if (!reachable.has(`#/components/schemas/${encodeSegment(name)}`))
        delete schemas[name]
    }
    if (Object.keys(schemas).length === 0)
      delete components!.schemas
    if (Object.keys(components!).length === 0)
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
    for (const item of node) collectRefs(item, out)
    return
  }
  if (!isObject(node))
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
    if (!isObject(current))
      return undefined
    current = current[segment]
  }
  return current
}

function encodeSegment(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1')
}

// `[]` or every requirement object has only empty scope arrays.
function isEffectivelyEmptySecurity(value: unknown): boolean {
  if (!Array.isArray(value))
    return false
  if (value.length === 0)
    return true
  return value.every(
    (req) => isObject(req) && Object.values(req).every((scopes) => Array.isArray(scopes) && scopes.length === 0),
  )
}

function rewriteServicePaths(spec: Record<string, unknown>, servicePrefix: string): void {
  const paths = spec.paths
  if (isObject(paths)) {
    const rewritten: Record<string, unknown> = {}
    for (const [p, item] of Object.entries(paths))
      rewritten[p.startsWith(servicePrefix) ? p : `${servicePrefix}${p}`] = item
    spec.paths = rewritten
  }

  if (Array.isArray(spec.servers)) {
    spec.servers = spec.servers.map((server) => {
      if (!isObject(server) || typeof server.url !== 'string')
        return server
      const url = server.url
      const stripped = url.endsWith(`${servicePrefix}/`)
        ? url.slice(0, -(servicePrefix.length + 1))
        : url.endsWith(servicePrefix)
          ? url.slice(0, -servicePrefix.length)
          : url
      return stripped === url ? server : { ...server, url: stripped || '/' }
    })
  }
}


function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
