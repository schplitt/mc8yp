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
 * Service-spec map keyed by Cumulocity contextPath, populated only by live
 * discovery. An absent key means the service publishes no spec on this tenant.
 */
export type ServiceSpecs = Record<string, Spec>

/**
 * The full set of capabilities resolved for a tenant — everything the query
 * sandbox needs in one object.
 * `core` is always populated from the bundled core OpenAPI snapshot — the
 * only bundled spec, since core cannot be discovered from a tenant.
 * `specs` carries the service specs discovered live on the tenant.
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
 * Core comes from the bundled snapshot; every service spec and MCP server
 * comes from live discovery, keyed by contextPath. Nothing else is bundled:
 * a service only gets a namespace when it publishes its own spec or MCP
 * server on the tenant.
 * @param discoveredSpecs Result of live API discovery for the tenant.
 * @param discoveredMcpServers MCP servers discovered on the tenant.
 */
// Memoized per (discoveredSpecs, discoveredMcpServers) object pair — both
// come from the same per-tenant discovery cache entry, so in server mode the
// H3 handler gets the SAME TenantCapabilities object back for every request of a
// tenant until its discovery refreshes. That identity is what the codemode
// layer's WeakMap caches (derived operations, docs index) key on; without it
// they would rebuild on every request. A refresh produces a fresh discovery
// result → fresh resolved object → caches repopulate lazily and old entries
// are garbage-collected.
const tenantCapabilitiesCache = new WeakMap<object, WeakMap<object, TenantCapabilities>>()
const NO_MCP_SERVERS: readonly DiscoveredMcpServer[] = Object.freeze([])

export function resolveCapabilities(
  discoveredSpecs: readonly DiscoveredApiSpec[],
  discoveredMcpServers: readonly DiscoveredMcpServer[] = NO_MCP_SERVERS,
): TenantCapabilities {
  let byMcp = tenantCapabilitiesCache.get(discoveredSpecs)
  if (!byMcp) {
    byMcp = new WeakMap()
    tenantCapabilitiesCache.set(discoveredSpecs, byMcp)
  }
  const cached = byMcp.get(discoveredMcpServers)
  if (cached)
    return cached

  const specs: ServiceSpecs = {}
  for (const live of discoveredSpecs)
    specs[live.contextPath] = live.spec

  const mcpServers: Record<string, DiscoveredMcpServer> = {}
  for (const server of discoveredMcpServers)
    mcpServers[server.contextPath] = server

  const resolved: TenantCapabilities = { core: getCoreOpenApiSpec(), specs, mcpServers }
  byMcp.set(discoveredMcpServers, resolved)
  return resolved
}

/**
 * Core-only capabilities, used by the CLI when no tenant is active so the
 * agent can still browse the bundled core surface for reference. Service
 * namespaces only exist once a tenant is active and discovery has run.
 */
export function getCoreOnlyCapabilities(): TenantCapabilities {
  return { core: getCoreOpenApiSpec(), specs: {}, mcpServers: {} }
}
