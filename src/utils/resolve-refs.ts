import $RefParser from '@apidevtools/json-schema-ref-parser'

// Dereference same-document `$ref`s. `circular: 'ignore'` keeps the result
// JSON-serialisable — the spec is later `JSON.stringify`'d into the sandbox
// script. On parser error, return the input untouched.
//
// $RefParser is conservative about cycles: any `$ref` chain that touches a
// recursive schema is left entirely unresolved. `resolveRemainingRefs` below
// expands those, stopping only at the exact re-entry that would close a cycle.
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

// Skip components/definitions: expanding inside them would unfold recursive
// schemas without bound. Their refs are reached via the path-level uses.
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

// `expanding` is per-path: a `$ref` to X is kept only when X is already open
// in this branch (the occurrence that closes a cycle). Deep-clone before
// inlining so the result holds no JS circular references.
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
