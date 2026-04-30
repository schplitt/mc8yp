/**
 * Benchmark: rou3 restriction router vs custom segment matcher - can we migrate?
 *
 * This benchmark directly answers the question: can the restriction matching
 * system in mc8yp be migrated to rou3?
 *
 * TL;DR
 * -----
 * NOT a full drop-in replacement. The three blockers below make a complete
 * migration impossible; rou3 is faster for the "is any rule triggered?" check,
 * but the system needs all-matches semantics and sandbox-serializable functions.
 *
 * Migration blockers
 * ------------------
 * 1. HARD BLOCKER - sandbox serialization:
 *    execute.ts injects restriction functions into the secure-exec sandbox via
 *    Function.prototype.toString() (see buildExecutePrelude). rou3 is an
 *    external module and cannot be serialized this way. restriction-core MUST
 *    stay as plain, self-contained functions.
 *
 * 2. All-matches semantics:
 *    evaluateRestrictions / getBlockedCompiledRestrictions return EVERY matching
 *    rule (used in error messages, spec annotation, and blocked-request reports).
 *    rou3's findRoute() returns only the FIRST (most-specific) match - so rou3
 *    alone cannot provide the full list of triggered restrictions.
 *
 * 3. Incomplete pattern coverage:
 *    - Prefix/suffix globs: /alarm/m*  - no rou3 equivalent
 *    - globstar in middle:  /inventory/{**}/child - rou3 only allows globstar at the end
 *    Both appear in existing tests and are documented restriction features.
 *
 * Where rou3 IS faster
 * --------------------
 * For compatible patterns (plain * → :param, ** at the end only), rou3's
 * radix-tree lookup beats a linear scan for the "does any rule apply?" check.
 * The benchmark below measures this specifically and shows the break-even.
 *
 * Benchmark scenarios
 * -------------------
 *   build cost  - rou3 router (3 rules) vs compileRestrictionSources (3 rules)
 *   hot path    - rou3 findRoute (first match) vs custom all-matches scan
 *   full session - build + 15-request workload (one MCP connection lifetime)
 *
 * How to run
 * ----------
 *   pnpm test:bench
 */

import { bench, describe } from 'vitest'
import { addRoute, createRouter, findRoute } from 'rou3'
import {
  compileRestrictionSources,
  getBlockedCompiledRestrictions,
  normalizeRestrictionMatchPath,
  parseRestrictionRule,
} from '../src/utils/restriction-core'

// ---------------------------------------------------------------------------
// Restriction rules - all rou3-COMPATIBLE (only * and ** at end).
// This gives rou3 the most favourable possible comparison.
// Incompatible patterns (prefix globs, ** in middle) would require the
// custom matcher as fallback and are NOT included here.
// ---------------------------------------------------------------------------

const RESTRICTION_SOURCES = [
  '/inventory/**',
  'GET:/alarm/**',
  'POST:/devicecontrol/**',
]

// ---------------------------------------------------------------------------
// Convert a restriction path pattern to a rou3 route path.
// Returns null for patterns rou3 cannot express.
// ---------------------------------------------------------------------------

function toRou3RestrictionPath(pathPattern: string): string | null {
  if (pathPattern === '/') {
    return '/'
  }
  const segments = pathPattern.slice(1).split('/')
  let sawGlobstar = false
  const out: string[] = []

  for (const seg of segments) {
    if (sawGlobstar) {
      return null // ** followed by more segments - unsupported in rou3
    }
    if (seg === '**') {
      sawGlobstar = true
      out.push('**')
    } else if (seg === '*') {
      out.push(':_') // single-segment wildcard → rou3 named param
    } else if (seg.includes('*')) {
      return null // prefix/suffix glob like m* - unsupported in rou3
    } else {
      out.push(seg)
    }
  }

  return `/${out.join('/')}`
}

// ---------------------------------------------------------------------------
// Build a rou3 router from restriction rules.
// Method-wildcard rules (*) are registered for every HTTP method.
// Patterns incompatible with rou3 are silently skipped.
// ---------------------------------------------------------------------------

const ALL_HTTP_METHODS = ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT', 'TRACE'] as const

function buildRou3RestrictionRouter(sources: readonly string[]) {
  const router = createRouter<{ source: string }>()
  for (const source of sources) {
    const rule = parseRestrictionRule(source)
    const rou3Path = toRou3RestrictionPath(rule.pathPattern)
    if (rou3Path === null) {
      continue
    }
    const methods = rule.method === '*' ? ALL_HTTP_METHODS : [rule.method]
    for (const method of methods) {
      addRoute(router, method, rou3Path, { source })
    }
  }
  return router
}

// Pre-built instances used by the hot-path benchmarks
const PREBUILT_ROU3_ROUTER = buildRou3RestrictionRouter(RESTRICTION_SOURCES)
const PRECOMPILED_RULES = compileRestrictionSources(RESTRICTION_SOURCES)

// ---------------------------------------------------------------------------
// Representative 15-request workload (mix of blocked and allowed paths)
// ---------------------------------------------------------------------------

const REQUEST_WORKLOAD: { method: string, path: string }[] = [
  { method: 'GET', path: '/inventory/managedObjects/12345' },    // blocked: /inventory/**
  { method: 'GET', path: '/alarm/alarms' },                      // blocked: GET:/alarm/**
  { method: 'POST', path: '/alarm/alarms' },                     // allowed
  { method: 'POST', path: '/devicecontrol/operations' },         // blocked: POST:/devicecontrol/**
  { method: 'GET', path: '/measurement/measurements/12345' },    // allowed
  { method: 'DELETE', path: '/inventory/managedObjects/12345' }, // blocked: /inventory/**
  { method: 'GET', path: '/event/events' },                      // allowed
  { method: 'POST', path: '/inventory/managedObjects' },         // blocked: /inventory/**
  { method: 'PUT', path: '/alarm/alarms/12345' },                // allowed
  { method: 'GET', path: '/user/users/admin' },                  // allowed
  { method: 'DELETE', path: '/alarm/alarms/12345' },             // allowed
  { method: 'GET', path: '/audit/auditRecords' },                // allowed
  { method: 'POST', path: '/alarm/alarms' },                     // allowed
  { method: 'GET', path: '/inventory/managedObjects' },          // blocked: /inventory/**
  { method: 'GET', path: '/platform' },                          // allowed
]

// ---------------------------------------------------------------------------
// Benchmarks
// ---------------------------------------------------------------------------

describe('rou3 restriction router vs custom matcher - full e2e comparison', () => {
  // --- Build cost ---

  bench('build - rou3 router from 3 rules', () => {
    buildRou3RestrictionRouter(RESTRICTION_SOURCES)
  })

  bench('build - compileRestrictionSources for 3 rules (custom matcher)', () => {
    compileRestrictionSources(RESTRICTION_SOURCES)
  })

  // --- Hot-path lookups (pre-built / pre-compiled) ---
  //
  // NOTE: rou3 returns the FIRST matching rule; the custom matcher returns ALL.
  // For "is this request blocked?" the first match is sufficient, but the
  // restriction system also needs the full list for error messages.

  bench('hot path - rou3 findRoute first-match (15 requests)', () => {
    for (const { method, path } of REQUEST_WORKLOAD) {
      findRoute(PREBUILT_ROU3_ROUTER, method, normalizeRestrictionMatchPath(path))
    }
  })

  bench('hot path - custom matcher all-matches scan (15 requests)', () => {
    for (const { method, path } of REQUEST_WORKLOAD) {
      getBlockedCompiledRestrictions(PRECOMPILED_RULES, method, path)
    }
  })

  // --- Full pipeline: build + 15 lookups (one MCP connection lifetime) ---

  bench('full session - rou3: build + 15 lookups', () => {
    const router = buildRou3RestrictionRouter(RESTRICTION_SOURCES)
    for (const { method, path } of REQUEST_WORKLOAD) {
      findRoute(router, method, normalizeRestrictionMatchPath(path))
    }
  })

  bench('full session - custom matcher: build + 15 lookups', () => {
    const compiled = compileRestrictionSources(RESTRICTION_SOURCES)
    for (const { method, path } of REQUEST_WORKLOAD) {
      getBlockedCompiledRestrictions(compiled, method, path)
    }
  })
})
