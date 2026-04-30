/**
 * Benchmark: rou3 router vs naive scan for OpenAPI path matching
 *
 * Background
 * ----------
 * The repo bundles a ~1.5 MB Cumulocity OpenAPI spec (145 paths, 245 routes).
 * A common task is resolving an incoming request path like `/alarm/alarms/123`
 * against the spec's parameterised patterns (e.g. `/alarm/alarms/{id}`) to
 * extract params or identify the matching operation.
 *
 * The question this benchmark answers
 * ------------------------------------
 * Is the "build router once, do many fast lookups" strategy with rou3 worth it,
 * or is a naive per-lookup scan competitive enough?
 *
 * Scenarios
 * ---------
 *   rou3 router build from spec     — setup cost: build a fresh rou3 router from
 *                                     all spec routes each iteration
 *   rou3 prebuilt router lookup     — hot-path lookup against an already-built router
 *   naive scan per lookup           — iterate all spec paths on every lookup,
 *                                     re-derive a regex from each pattern on the fly
 *   precompiled patterns lookup     — iterate all spec paths on every lookup,
 *                                     but patterns are compiled to regexes upfront
 *
 * How to run
 * ----------
 *   pnpm test:bench
 *
 * Interpreting results
 * --------------------
 * If "rou3 prebuilt router lookup" is significantly faster than both scan
 * approaches, the "build once, match many" strategy pays off for workloads
 * with many lookups.  If the scan approaches are competitive, a router may
 * be unnecessary complexity for this spec size.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { bench, describe } from 'vitest'
import { addRoute, createRouter, findRoute } from 'rou3'

// ---------------------------------------------------------------------------
// Load the real bundled Cumulocity OpenAPI spec
// ---------------------------------------------------------------------------

type OpenApiOperation = { operationId?: string }
type OpenApiPathItem = Partial<Record<string, OpenApiOperation>>
type OpenApiSpec = { paths: Record<string, OpenApiPathItem> }

const specPath = resolve(import.meta.dirname, '../core-openapi/release.json')
const SPEC: OpenApiSpec = JSON.parse(readFileSync(specPath, 'utf8'))

const OPENAPI_METHODS = ['get', 'post', 'put', 'delete', 'patch', 'options', 'head', 'trace'] as const

// ---------------------------------------------------------------------------
// Convert an OpenAPI path to rou3 format: {param} -> :param, drop query string
// ---------------------------------------------------------------------------

function toRou3Path(openApiPath: string): string {
  return openApiPath.replace(/\{([^}]+)\}/g, ':$1').split('?')[0] ?? ''
}

// ---------------------------------------------------------------------------
// Convert an OpenAPI path pattern to a plain regex for the naive scanner
// ---------------------------------------------------------------------------

function openApiPathToRegex(pattern: string): RegExp {
  const clean = pattern.split('?')[0] ?? ''
  const escaped = clean.replace(/[.+^${}()|[\]\\]/g, (c) => {
    // keep { } for param detection after escaping—handled below
    return c === '{' || c === '}' ? c : `\\${c}`
  })
  const regexStr = escaped
    .replace(/\{[^}]+\}/g, '([^/]+)')
    .replace(/\\\*/g, '[^/]*')
  return new RegExp(`^${regexStr}$`)
}

// ---------------------------------------------------------------------------
// Pre-build the rou3 router once (used by the hot-path benchmark)
// ---------------------------------------------------------------------------

function buildRou3Router() {
  const router = createRouter<OpenApiOperation & { _path: string, _method: string }>()
  for (const [path, pathItem] of Object.entries(SPEC.paths)) {
    const rou3Path = toRou3Path(path)
    for (const method of OPENAPI_METHODS) {
      const op = pathItem[method]
      if (op && typeof op === 'object') {
        addRoute(router, method.toUpperCase(), rou3Path, { ...op, _path: path, _method: method })
      }
    }
  }
  return router
}

const PREBUILT_ROUTER = buildRou3Router()

// ---------------------------------------------------------------------------
// Pre-compile path patterns for the scan-based baseline
// ---------------------------------------------------------------------------

type CompiledPattern = { method: string, regex: RegExp, path: string, op: OpenApiOperation }

function buildCompiledPatterns(): CompiledPattern[] {
  const patterns: CompiledPattern[] = []
  for (const [path, pathItem] of Object.entries(SPEC.paths)) {
    const regex = openApiPathToRegex(path)
    for (const method of OPENAPI_METHODS) {
      const op = pathItem[method]
      if (op && typeof op === 'object') {
        patterns.push({ method: method.toUpperCase(), regex, path, op })
      }
    }
  }
  return patterns
}

const PRECOMPILED_PATTERNS = buildCompiledPatterns()

// ---------------------------------------------------------------------------
// Representative lookup workload: a mix of exact and parameterised paths
// covering different parts of the spec
// ---------------------------------------------------------------------------

const LOOKUP_CASES: { method: string, path: string }[] = [
  { method: 'GET', path: '/alarm/alarms/12345' },
  { method: 'GET', path: '/alarm/alarms' },
  { method: 'POST', path: '/alarm/alarms' },
  { method: 'PUT', path: '/alarm/alarms/12345' },
  { method: 'GET', path: '/inventory/managedObjects/12345/childDevices' },
  { method: 'GET', path: '/inventory/managedObjects/12345' },
  { method: 'POST', path: '/inventory/managedObjects' },
  { method: 'GET', path: '/devicecontrol/operations/12345' },
  { method: 'GET', path: '/application/applications/12345/binaries/99' },
  { method: 'GET', path: '/identity/externalIds/c8y_Serial/myDevice' },
  { method: 'GET', path: '/user/users/admin' },
  { method: 'GET', path: '/audit/auditRecords' },
  { method: 'GET', path: '/measurement/measurements/12345' },
  { method: 'GET', path: '/event/events/12345' },
  { method: 'GET', path: '/platform' },
]

// ---------------------------------------------------------------------------
// Benchmarks
// ---------------------------------------------------------------------------

describe('rou3 router vs naive scan — OpenAPI path matching', () => {
  bench('rou3 router build from spec (setup cost)', () => {
    buildRou3Router()
  })

  bench('rou3 prebuilt router lookup (hot path)', () => {
    for (const { method, path } of LOOKUP_CASES) {
      findRoute(PREBUILT_ROUTER, method, path)
    }
  })

  bench('naive scan per lookup (patterns recompiled every call)', () => {
    for (const { method, path } of LOOKUP_CASES) {
      for (const [specPath, pathItem] of Object.entries(SPEC.paths)) {
        const regex = openApiPathToRegex(specPath)
        if (regex.test(path)) {
          const op = pathItem[method.toLowerCase() as typeof OPENAPI_METHODS[number]]
          if (op) break
        }
      }
    }
  })

  bench('precompiled patterns lookup (scan with pre-built regexes)', () => {
    for (const { method, path } of LOOKUP_CASES) {
      for (const entry of PRECOMPILED_PATTERNS) {
        if (entry.method === method && entry.regex.test(path)) {
          break
        }
      }
    }
  })
})
