/**
 * Internal $ref resolution for OpenAPI documents.
 *
 * Both the build-time bundled specs (tsdown.config.ts) and the live-discovered
 * specs (api-discovery.ts) are run through this before use so consumers — the
 * code-mode query sandbox, prompt builders, tool generation — see fully inlined
 * schemas instead of `$ref` pointers.
 */

import $RefParser from '@apidevtools/json-schema-ref-parser'

/**
 * Dereference same-document ($ref: "#/...") pointers in place and return the
 * spec with refs inlined.
 *
 * - External file/URL resolution is disabled (`resolve.external = false`), so
 *   the operation is purely in-memory: no disk or network access, and only
 *   internal references are touched.
 * - Circular references are left untouched (`circular: 'ignore'`) so the result
 *   stays JSON-serialisable. The specs are later `JSON.stringify`'d into the
 *   sandbox entry script and inlined into the build output; a dereferenced
 *   circular structure would throw "Converting circular structure to JSON".
 * - After `$RefParser` runs, a second pass ({@link resolveRemainingRefs})
 *   expands any `$ref` pointers the parser left unresolved due to its
 *   conservative circular-reference detection. `$RefParser` leaves the entire
 *   reference chain to a circular schema unexpanded even when only one link in
 *   that chain is actually circular. The second pass inlines each remaining ref
 *   and stops only at the exact re-entry that would form a cycle.
 *
 * On any parser error the original spec is returned unchanged so a malformed
 * or unusual document never breaks spec loading.
 * @param spec OpenAPI document to dereference. Mutated in place on success.
 */
export async function resolveInternalRefs<T extends object>(spec: T): Promise<T> {
  let result: T
  try {
    result = await $RefParser.dereference(spec, {
      resolve: { external: false },
      dereference: { circular: 'ignore' },
    }) as T
  } catch {
    return spec
  }
  resolveRemainingRefs(result as Record<string, unknown>)
  return result
}

/**
 * Expand `$ref` pointers left unresolved by `$RefParser` due to conservative
 * circular-reference detection. Runs on all top-level spec sections except
 * `components`/`definitions` — expanding within those containers would cause
 * unbounded self-inlining of recursive schemas.
 *
 * Uses a per-path expanding set: a `$ref` to schema X is left as-is only when
 * X is already open in the current traversal path (i.e. the exact occurrence
 * that closes a cycle), not globally. This allows `PaginatedList → Item ↺`
 * to inline `Item` into `PaginatedList` while leaving `Item`'s self-ref intact.
 *
 * The result is always JSON-serialisable: schemas are deep-cloned before
 * inlining, so no JS circular object references are created.
 *
 * @param spec The dereferenced OpenAPI document to process. Mutated in place.
 */
function resolveRemainingRefs(spec: Record<string, unknown>): void {
  const schemaMap = buildSchemaMap(spec)
  if (schemaMap.size === 0)
    return

  for (const key of Object.keys(spec)) {
    if (key === 'components' || key === 'definitions')
      continue
    const expanded = expandRefs(spec[key], schemaMap, new Set<string>())
    if (expanded !== spec[key])
      spec[key] = expanded
  }
}

function buildSchemaMap(spec: Record<string, unknown>): Map<string, unknown> {
  const map = new Map<string, unknown>()
  if (isObj(spec.components)) {
    const components = spec.components as Record<string, unknown>
    if (isObj(components.schemas)) {
      for (const [name, schema] of Object.entries(components.schemas as Record<string, unknown>))
        map.set(`#/components/schemas/${encodePointer(name)}`, schema)
    }
  }
  if (isObj(spec.definitions)) {
    for (const [name, schema] of Object.entries(spec.definitions as Record<string, unknown>))
      map.set(`#/definitions/${encodePointer(name)}`, schema)
  }
  return map
}

function expandRefs(node: unknown, schemaMap: Map<string, unknown>, expanding: ReadonlySet<string>): unknown {
  if (Array.isArray(node)) {
    let changed = false
    const result = node.map((item) => {
      const expanded = expandRefs(item, schemaMap, expanding)
      if (expanded !== item)
        changed = true
      return expanded
    })
    return changed ? result : node
  }
  if (!isObj(node))
    return node

  if (typeof node['$ref'] === 'string') {
    const ref = node['$ref']
    if (!expanding.has(ref)) {
      const target = schemaMap.get(ref)
      if (target !== undefined) {
        const newExpanding = new Set(expanding)
        newExpanding.add(ref)
        // Deep-clone so mutations during expansion don't corrupt the source
        // entry and so the result has no JS circular object references.
        const cloned = JSON.parse(JSON.stringify(target)) as unknown
        return expandRefs(cloned, schemaMap, newExpanding)
      }
    }
    return node
  }

  let changed = false
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node)) {
    const expanded = expandRefs(value, schemaMap, expanding)
    result[key] = expanded
    if (expanded !== value)
      changed = true
  }
  return changed ? result : node
}

function encodePointer(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1')
}

function isObj(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
