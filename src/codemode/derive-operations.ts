import consola from 'consola'
import { operationName } from './operation-naming'
import type { JsonSchema, JsonSchemaDefinition } from './type-render'
import { HTTP_METHODS } from '../utils/restrictions'
import type { Spec } from '../utils/spec-resolution'

// ─────────────────────────────────────────────────────────────────────────
// OpenAPI spec → derived operations.
//
// Each operation becomes one callable namespace method: name from its
// operationId, input as a single flattened object (path/query/header params
// as top-level keys plus `body`), output type from the first 2xx JSON
// response.
//
// Derivation is cached in a WeakMap keyed by spec object identity and MUST
// stay policy-independent: restriction/allow rules differ per connection in
// server mode, so policy filtering happens where namespaces are assembled
// per request — never here.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Path-item keys that hold operations — every HTTP method the OpenAPI spec
 * (and the shared restrictions constant) knows, lowercased. Single source of
 * truth with request-time method validation.
 */
export const OPERATION_KEYS = HTTP_METHODS.map((m) => m.toLowerCase())

/**
 * Vendor extension that hides an operation from derivation and discovery.
 */
const EXCLUDE_EXTENSION = 'x-mc8yp-exclude'

/**
 * Names every namespace reserves for its own surface.
 */
export const RESERVED_METHOD_NAMES = new Set(['request'])

interface OpenApiParameter {
  name: string
  in: 'path' | 'query' | 'header' | 'cookie'
  required?: boolean
  description?: string
  schema?: JsonSchemaDefinition
  /**
   * OpenAPI array serialization: `false` → one comma-joined key
   * (`?severity=MAJOR,MINOR`), `true`/absent (the OpenAPI default) →
   * repeated keys (`?severity=MAJOR&severity=MINOR`). Nearly every array
   * parameter in the Cumulocity specs declares `explode: false`.
   */
  explode?: boolean
}

/**
 * Loose runtime view of one operation. The narrow `OperationInfo` type in
 * spec-resolution omits `operationId` and vendor extensions, but they survive
 * preprocessing and are present at runtime.
 */
interface OpenApiOperation {
  'operationId'?: string
  'summary'?: string
  'description'?: string
  'tags'?: string[]
  'parameters'?: OpenApiParameter[]
  'requestBody'?: {
    required?: boolean
    content?: Record<string, { schema?: JsonSchemaDefinition }>
  }
  'responses'?: Record<string, { content?: Record<string, { schema?: JsonSchemaDefinition }> }>
  'x-mc8yp-exclude'?: unknown
}

export interface DerivedOperation {
  /**
   * Sanitized operationId (fallback: `method_path`), unique per spec.
   */
  name: string
  /**
   * Short one-line doc: summary, falling back to `METHOD /path`.
   */
  summary: string
  /**
   * Full operation description when present and distinct from the summary.
   */
  description?: string
  /**
   * Flattened input: path/query/header params as top-level keys plus `body`.
   */
  inputSchema: JsonSchema
  /**
   * First 2xx `application/json` response schema. Absent = `unknown`.
   */
  outputSchema?: JsonSchema
  path: string
  /**
   * Uppercase HTTP method.
   */
  method: string
  parameters: OpenApiParameter[]
  tags: string[]
}

/**
 * A concrete request built from a derived operation and agent-supplied args.
 */
export interface DerivedRequest {
  method: string
  path: string
  query: Record<string, unknown>
  headers: Record<string, string>
  body?: unknown
}

const operationCache = new WeakMap<object, DerivedOperation[]>()

/**
 * Derive every callable operation from a spec. Pure and cached by spec object
 * identity — safe because resolved specs are stable per tenant/build.
 * @param spec
 */
export function deriveOperations(spec: Spec): DerivedOperation[] {
  const cached = operationCache.get(spec)
  if (cached)
    return cached
  const derived = buildOperations(spec as unknown as { paths?: Record<string, Record<string, unknown>> })
  operationCache.set(spec, derived)
  return derived
}

function buildOperations(doc: { paths?: Record<string, Record<string, unknown>> }): DerivedOperation[] {
  const operations: DerivedOperation[] = []
  const used = new Set<string>()

  for (const [path, pathItem] of Object.entries(doc.paths ?? {})) {
    if (!pathItem || typeof pathItem !== 'object')
      continue
    for (const method of OPERATION_KEYS) {
      const operation = pathItem[method] as OpenApiOperation | undefined
      if (!operation || typeof operation !== 'object')
        continue
      if (operation[EXCLUDE_EXTENSION])
        continue

      const name = operationName(method, path, operation.operationId)
      if (RESERVED_METHOD_NAMES.has(name) || used.has(name)) {
        consola.warn(
          `[codemode] operation ${method.toUpperCase()} ${path} maps to method name "${name}", which is `
          + `${RESERVED_METHOD_NAMES.has(name) ? 'reserved' : 'already used'} — skipping. Set a unique operationId to expose it.`,
        )
        continue
      }
      used.add(name)
      const pathItemParameters = Array.isArray(pathItem.parameters) ? pathItem.parameters as OpenApiParameter[] : []
      operations.push(buildOperation(doc, path, method, operation, name, pathItemParameters))
    }
  }

  return operations
}

function buildOperation(
  doc: object,
  path: string,
  method: string,
  operation: OpenApiOperation,
  name: string,
  pathItemParameters: readonly OpenApiParameter[],
): DerivedOperation {
  // The runtime specs are preprocessed but NOT dereferenced — parameter
  // entries, requestBody, and response objects may still be `$ref`s into
  // `components`. Structural refs are resolved here; schema-level refs are
  // inlined by `inlineRefs`. Path-item-level parameters (shared by every
  // operation on the path — Cumulocity declares `{id}` params there) are
  // merged in, with operation-level entries overriding on (in, name).
  const mergedParameters = new Map<string, OpenApiParameter>()
  for (const raw of [...pathItemParameters, ...(operation.parameters ?? [])]) {
    const param = raw && typeof raw === 'object' ? derefObject<OpenApiParameter>(raw, doc) : undefined
    if (param && typeof param === 'object' && param.name)
      mergedParameters.set(`${param.in}:${param.name}`, param)
  }
  const parameters = [...mergedParameters.values()]

  const properties: Record<string, JsonSchemaDefinition> = {}
  const required: string[] = []
  for (const param of parameters) {
    properties[param.name] = withDescription(inlineRefs(param.schema, doc) ?? {}, param.description)
    if (param.required)
      required.push(param.name)
  }

  const requestBody = derefObject(operation.requestBody, doc)
  const bodySchema = inlineRefs(jsonContentSchema(requestBody?.content), doc)
  if (bodySchema !== undefined) {
    properties.body = bodySchema
    if (requestBody?.required === true)
      required.push('body')
  }

  const summary = operation.summary?.trim() || `${method.toUpperCase()} ${path}`
  const detail = operation.description?.trim()

  const outputSchemaDefinition = firstSuccessResponseSchema(operation, doc)

  return {
    name,
    summary,
    description: detail && detail !== summary ? detail : undefined,
    inputSchema: {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
    },
    outputSchema: typeof outputSchemaDefinition === 'object' ? outputSchemaDefinition : undefined,
    path,
    method: method.toUpperCase(),
    parameters,
    tags: Array.isArray(operation.tags) ? operation.tags : [],
  }
}

/**
 * Best-effort output schema: the first 2xx response carrying an
 * `application/json` schema. Any missing link (204, non-JSON content, no
 * responses at all) yields undefined so the rendered type falls back to
 * `unknown`.
 * @param operation
 * @param doc
 */
function firstSuccessResponseSchema(operation: OpenApiOperation, doc: object): JsonSchemaDefinition | undefined {
  const responses = operation.responses
  if (!responses || typeof responses !== 'object')
    return undefined
  // The preprocessor keeps numeric 2xx keys, the `2XX` range form, and a
  // bare `default` — the range form counts as success here too.
  for (const status of Object.keys(responses).sort()) {
    if (!/^2\d\d$/.test(status) && !/^2xx$/i.test(status))
      continue
    const response = derefObject(responses[status], doc)
    const schema = jsonContentSchema(response?.content)
    if (schema !== undefined)
      return inlineRefs(schema, doc)
  }
  return undefined
}

/**
 * Pick the schema of the first JSON-bearing media type. Cumulocity uses
 * vendor types like `application/vnd.com.nsn.cumulocity.alarm+json`, so any
 * media type containing `json` counts — not just `application/json`.
 * @param content
 */
function jsonContentSchema(content: Record<string, { schema?: JsonSchemaDefinition }> | undefined): JsonSchemaDefinition | undefined {
  if (!content || typeof content !== 'object')
    return undefined
  for (const [mediaType, media] of Object.entries(content)) {
    if (mediaType.toLowerCase().includes('json') && media?.schema !== undefined)
      return media.schema
  }
  return undefined
}

/**
 * Resolve an OpenAPI structural-level `$ref` (parameter object, requestBody,
 * response object) against the document root, following chains with a cycle
 * guard. Schema-level refs are handled by `inlineRefs` instead. Unresolvable
 * refs yield undefined so the operation degrades instead of throwing.
 * @param node
 * @param doc
 */
export function derefObject<T extends object>(node: T | undefined, doc: object): T | undefined {
  let current: unknown = node
  const seen = new Set<string>()
  while (current && typeof current === 'object' && typeof (current as { $ref?: unknown }).$ref === 'string') {
    const ref = (current as { $ref: string }).$ref
    if (!ref.startsWith('#/') || seen.has(ref))
      return undefined
    seen.add(ref)
    current = pointer(doc, ref.slice(2).split('/'))
  }
  return current === null || typeof current !== 'object' ? undefined : current as T
}

/**
 * Build the concrete request for a derived operation: substitute path params,
 * split the remaining args into query/header maps, and pass `body` through.
 * @param op
 * @param args
 */
export function toRequest(op: DerivedOperation, args: unknown): DerivedRequest {
  const input = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>
  let resolvedPath = op.path
  const query: Record<string, unknown> = {}
  const headers: Record<string, string> = {}

  for (const param of op.parameters) {
    const value = input[param.name]
    if (value === undefined)
      continue
    if (param.in === 'path') {
      resolvedPath = resolvedPath.replace(`{${param.name}}`, encodeURIComponent(String(value)))
    } else if (param.in === 'query') {
      // `explode: false` arrays serialize as one comma-joined key; the
      // OpenAPI default (explode true) stays an array and is emitted as
      // repeated keys by the request funnel.
      query[param.name] = Array.isArray(value) && param.explode === false ? value.join(',') : value
    } else if (param.in === 'header') {
      headers[param.name] = String(value)
    }
  }

  return {
    method: op.method,
    path: resolvedPath,
    query,
    headers,
    ...('body' in input ? { body: input.body } : {}),
  }
}

function withDescription(schema: JsonSchemaDefinition, description?: string): JsonSchemaDefinition {
  if (!description || typeof schema !== 'object')
    return schema
  return { ...schema, description: schema.description ?? description }
}

/**
 * Inline local `#/...` `$ref`s so flattened input/output schemas stay usable
 * once detached from the OpenAPI document root, recursing through
 * `properties`, `items`, `additionalProperties`, and the combinators.
 * External refs and cycles degrade to an open object rather than throwing.
 * @param schema
 * @param root
 * @param seen
 */
function inlineRefs(
  schema: JsonSchemaDefinition | undefined,
  root: object,
  seen: Set<string> = new Set(),
): JsonSchemaDefinition | undefined {
  if (schema === undefined || typeof schema === 'boolean')
    return schema

  if (typeof schema.$ref === 'string') {
    const ref = schema.$ref
    if (!ref.startsWith('#/') || seen.has(ref))
      return { type: 'object' }
    const target = pointer(root, ref.slice(2).split('/'))
    if (target === undefined || target === null || typeof target !== 'object')
      return { type: 'object' }
    return inlineRefs(target as JsonSchema, root, new Set(seen).add(ref))
  }

  const out: JsonSchema = { ...schema }
  if (schema.properties) {
    out.properties = {}
    for (const [key, value] of Object.entries(schema.properties)) {
      out.properties[key] = inlineRefs(value, root, seen) ?? {}
    }
  }
  if (schema.items && !Array.isArray(schema.items))
    out.items = inlineRefs(schema.items, root, seen)
  if (schema.additionalProperties && typeof schema.additionalProperties === 'object')
    out.additionalProperties = inlineRefs(schema.additionalProperties, root, seen)
  for (const key of ['allOf', 'oneOf', 'anyOf'] as const) {
    const branch = schema[key]
    if (Array.isArray(branch))
      out[key] = branch.map((s) => inlineRefs(s, root, seen) ?? {})
  }
  return out
}

function pointer(root: unknown, segments: string[]): unknown {
  let current: unknown = root
  for (const segment of segments) {
    const key = segment.replace(/~1/g, '/').replace(/~0/g, '~')
    if (!current || typeof current !== 'object')
      return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}
