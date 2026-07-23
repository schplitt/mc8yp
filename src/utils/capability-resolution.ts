import { BUNDLED_SERVICE_SPECS } from '#bundled-services'
import { getCoreOpenApiSpec } from '#core-openapi'
import type { DiscoveredApiSpec, DiscoveredMcpServer } from './capability-discovery'

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
 * The full set of capabilities resolved for a tenant — everything the query
 * sandbox needs in one object.
 * `core` is always populated from the bundled core OpenAPI snapshot.
 * `specs` carries bundled service specs (e.g. dtm) plus any non-bundled
 * services discovered live on the tenant.
 * `mcpServers` carries the MCP servers discovered on the tenant, keyed by
 * contextPath. The prefer-MCP-over-OpenAPI rule is NOT applied here — both
 * views stay available so per-connection opt-outs (`noMcp`) can fall back
 * to the spec at namespace-assembly time.
 * Additional capability kinds can be added as new fields alongside these.
 */
export interface TenantCapabilities {
  core: Spec
  specs: ServiceSpecs
  mcpServers: Record<string, DiscoveredMcpServer>
}

/**
 * Resolve every capability for the current tenant into a {@link TenantCapabilities}.
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
 * use {@link getBundledOnlyCapabilities} (the CLI's no-tenant fallback).
 * @param discoveredSpecs Result of live API discovery for the tenant.
 * @param installedContextPaths Context paths of microservices the tenant owns
 *   or is subscribed to (discovery filters to type=MICROSERVICE).
 */
// Memoized per (discoveredSpecs, installedContextPaths) object pair — both
// come from the same per-tenant discovery cache entry, so in server mode the
// H3 handler gets the SAME TenantCapabilities object back for every request of a
// tenant until its discovery refreshes. That identity is what the codemode
// layer's WeakMap caches (derived operations, docs index) key on; without it
// they would rebuild on every request. A refresh produces a fresh discovery
// result → fresh resolved object → caches repopulate lazily and old entries
// are garbage-collected.
const tenantCapabilitiesCache = new WeakMap<object, WeakMap<object, TenantCapabilities>>()

export function resolveCapabilities(
  discoveredSpecs: readonly DiscoveredApiSpec[],
  installedContextPaths: ReadonlySet<string>,
  discoveredMcpServers: readonly DiscoveredMcpServer[] = [],
): TenantCapabilities {
  let byInstalled = tenantCapabilitiesCache.get(discoveredSpecs)
  if (!byInstalled) {
    byInstalled = new WeakMap()
    tenantCapabilitiesCache.set(discoveredSpecs, byInstalled)
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

  const mcpServers: Record<string, DiscoveredMcpServer> = {}
  for (const server of discoveredMcpServers) {
    mcpServers[server.contextPath] = server
  }

  const resolved: TenantCapabilities = { core: getCoreOpenApiSpec(), specs, mcpServers }
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
export function getBundledOnlyCapabilities(): TenantCapabilities {
  const specs: ServiceSpecs = {}
  for (const bundled of BUNDLED_SERVICE_SPECS) {
    specs[bundled.contextPath] = bundled.spec
  }
  // No bundled MCP servers exist — MCP namespaces are live-discovery only.
  return { core: getCoreOpenApiSpec(), specs, mcpServers: {} }
}
