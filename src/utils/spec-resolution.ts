import { BUNDLED_SERVICE_SPECS } from '#bundled-services'
import { getCoreOpenApiSpec } from '#core-openapi'
import type { DiscoveredApiSpec } from './api-discovery'

interface OperationInfo {
  summary?: string
  description?: string
  tags?: string[]
  parameters?: Array<{ name: string, in: string, required?: boolean, schema?: unknown, description?: string }>
  requestBody?: { required?: boolean, content?: Record<string, { schema?: unknown }> }
  responses?: Record<string, { description?: string, content?: Record<string, { schema?: unknown }> }>
}

export interface PathItem {
  get?: OperationInfo
  post?: OperationInfo
  put?: OperationInfo
  patch?: OperationInfo
  delete?: OperationInfo
}
export interface Spec {
  paths: Record<string, PathItem>
  tags?: Array<{ name: string, description?: string }>
}

/**
 * Service-spec map keyed by Cumulocity contextPath.
 * A key is only present when the spec is actually usable (live discovery,
 * bundled fallback for installed services, or bundled when specRemoval is
 * disabled). An absent key means the spec is unavailable for this tenant.
 */
export type ServiceSpecs = Record<string, Spec>

/**
 * Everything the query sandbox needs in one object.
 * `core` is always populated from the bundled core OpenAPI snapshot.
 * `specs` carries bundled service specs (e.g. dtm) plus any non-bundled
 * services discovered live on the tenant.
 */
export interface ResolvedSpecs {
  core: Spec
  specs: ServiceSpecs
}

/**
 * Resolve every spec for the current tenant.
 *
 * For each bundled service spec (#bundled-services):
 *   - live discovery available           → use the live spec
 *   - service installed, no live spec    → use the bundled fallback
 *   - service not installed              → omitted (absent key = unavailable)
 *
 * Non-bundled discovered services pass through as-is, keyed by contextPath.
 *
 * Removal of bundled specs for services the tenant has not installed is
 * unconditional: when the agent has an active tenant context, the query
 * sandbox must only see what is actually reachable on that tenant. To
 * deliberately browse all bundled snapshots regardless of installation,
 * use {@link getBundledOnlySpecs} (the CLI's no-tenant fallback).
 * @param discoveredSpecs Result of live API discovery for the tenant.
 * @param installedContextPaths Context paths of microservices the tenant owns
 *   or is subscribed to (discovery filters to type=MICROSERVICE).
 */
// Memoized per (discoveredSpecs, installedContextPaths) object pair — both
// come from the same per-tenant discovery cache entry, so in server mode the
// H3 handler gets the SAME ResolvedSpecs object back for every request of a
// tenant until its discovery refreshes. That identity is what the codemode
// layer's WeakMap caches (derived operations, docs index) key on; without it
// they would rebuild on every request. A refresh produces a fresh discovery
// result → fresh resolved object → caches repopulate lazily and old entries
// are garbage-collected.
const resolvedSpecsCache = new WeakMap<object, WeakMap<object, ResolvedSpecs>>()

export function resolveSpecs(
  discoveredSpecs: readonly DiscoveredApiSpec[],
  installedContextPaths: ReadonlySet<string>,
): ResolvedSpecs {
  let byInstalled = resolvedSpecsCache.get(discoveredSpecs)
  if (!byInstalled) {
    byInstalled = new WeakMap()
    resolvedSpecsCache.set(discoveredSpecs, byInstalled)
  }
  const cached = byInstalled.get(installedContextPaths)
  if (cached)
    return cached

  const specs: ServiceSpecs = {}
  const bundledContextPaths = new Set<string>()

  for (const bundled of BUNDLED_SERVICE_SPECS) {
    bundledContextPaths.add(bundled.contextPath)
    const live = discoveredSpecs.find((s) => s.contextPath === bundled.contextPath)
    if (live) {
      specs[bundled.contextPath] = live.spec
    } else if (installedContextPaths.has(bundled.contextPath)) {
      specs[bundled.contextPath] = bundled.spec
    }
    // else: omit the key entirely — absence = unavailable.
  }

  for (const live of discoveredSpecs) {
    if (!bundledContextPaths.has(live.contextPath)) {
      specs[live.contextPath] = live.spec
    }
  }

  const resolved: ResolvedSpecs = { core: getCoreOpenApiSpec(), specs }
  byInstalled.set(installedContextPaths, resolved)
  return resolved
}

/**
 * Return every bundled spec unconditionally, ignoring tenant installation
 * state. Used exclusively by the CLI when no tenant is active so the agent
 * can browse the full bundled OpenAPI surface for reference. The query
 * sandbox running on this output must not be used to plan execute calls —
 * visibility here does not imply the service exists on any tenant.
 */
export function getBundledOnlySpecs(): ResolvedSpecs {
  const specs: ServiceSpecs = {}
  for (const bundled of BUNDLED_SERVICE_SPECS) {
    specs[bundled.contextPath] = bundled.spec
  }
  return { core: getCoreOpenApiSpec(), specs }
}
