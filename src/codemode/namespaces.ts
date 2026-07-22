import consola from 'consola'
import { deriveOperations } from './derive-operations'
import { sanitizeToolName } from './operation-naming'
import { evaluateAccessPolicy } from '../utils/restriction-matcher'
import type { DerivedOperation } from './derive-operations'
import type { SearchableMethod } from './method-search'
import type { ResolvedSpecs } from '../utils/spec-resolution'
import type { AllowRule, RestrictionRule } from '../utils/restrictions'

// ─────────────────────────────────────────────────────────────────────────
// Namespace assembly — the per-connection view over derived operations.
//
// Derivation (deriveOperations) is cached and policy-independent; THIS is the
// layer that applies the connection's restriction/allow rules, so blocked
// operations never appear in namespaces, search results, or describe output.
// A blocked operation is never retryable through the same connection, so
// advertising it would only send the agent down a dead end. Enforcement
// still happens host-side at request time as the second layer (which also
// covers the `.request` escape hatch and template-vs-concrete path gaps).
// ─────────────────────────────────────────────────────────────────────────

/**
 * The core spec's sandbox namespace.
 */
export const CORE_NAMESPACE = 'c8y'

/**
 * Namespaces that can never be taken by a discovered service contextPath.
 * `codemode`/`docs` are the platform SDK, `c8y` is core, and `cumulocity` is
 * reserved so a service cannot impersonate the historical request global.
 */
export const RESERVED_NAMESPACES = new Set(['codemode', 'docs', 'c8y', 'cumulocity'])

export interface CodemodeNamespace {
  /**
   * Sandbox global name, e.g. `c8y` or `dtm`.
   */
  name: string
  /**
   * Key in the resolved specs: `core` or a service contextPath.
   */
  specKey: string
  /**
   * The spec object the operations were derived from.
   */
  spec: ResolvedSpecs['core']
  /**
   * Policy-filtered operations visible to this connection.
   */
  operations: DerivedOperation[]
}

/**
 * Build the per-connection namespace list: core as `c8y` plus one namespace
 * per available service spec (sanitized contextPath). Operations blocked by
 * the connection policy are omitted. Path templates are matched as-is —
 * a rule targeting a concrete id (e.g. `/inventory/managedObjects/123`) does
 * not hide the templated method; request-time enforcement still applies.
 * @param resolved
 * @param restrictions
 * @param allowRules
 */
export function buildNamespaces(
  resolved: ResolvedSpecs,
  restrictions: readonly RestrictionRule[] = [],
  allowRules: readonly AllowRule[] = [],
): CodemodeNamespace[] {
  const visibleOperations = (spec: ResolvedSpecs['core']): DerivedOperation[] =>
    deriveOperations(spec).filter((op) => !evaluateAccessPolicy(restrictions, allowRules, op.method, op.path).blocked)

  const namespaces: CodemodeNamespace[] = [
    { name: CORE_NAMESPACE, specKey: 'core', spec: resolved.core, operations: visibleOperations(resolved.core) },
  ]
  const used = new Set([CORE_NAMESPACE])

  for (const [contextPath, spec] of Object.entries(resolved.specs)) {
    const name = sanitizeToolName(contextPath)
    if (RESERVED_NAMESPACES.has(name) || used.has(name)) {
      consola.warn(
        `[codemode] service "${contextPath}" maps to namespace "${name}", which is `
        + `${RESERVED_NAMESPACES.has(name) ? 'reserved' : 'already used'} — skipping this service.`,
      )
      continue
    }
    used.add(name)
    namespaces.push({ name, specKey: contextPath, spec, operations: visibleOperations(spec) })
  }

  return namespaces
}

/**
 * Flatten namespaces into the method-search item list.
 * @param namespaces
 */
export function toSearchableMethods(namespaces: readonly CodemodeNamespace[]): SearchableMethod[] {
  return namespaces.flatMap((ns) => ns.operations.map((op) => ({
    target: `${ns.name}.${op.name}`,
    namespace: ns.name,
    method: op.name,
    httpMethod: op.method,
    apiPath: op.path,
    summary: op.summary,
  })))
}
