/**
 * Live discovery of the capabilities a tenant exposes to the agent.
 *
 * A "capability" is any surface a subscribed microservice offers: an OpenAPI
 * spec, an MCP server (via `exposeMcpServers`), or more surface kinds added
 * later. One discovery run returns all of them together in a {@link DiscoveryResult}.
 *
 * The cache is a plain Map<tenantId, Promise<DiscoveryResult>>. Callers always
 * await the promise — there is no pending/ready distinction. Replacing the map
 * entry is the refresh mechanism.
 */

import consola from 'consola'
import type { Client, IApplication } from '@c8y/client'
import { c8yErrorSummary } from './client'
import { McpHttpClient } from './mcp-client'
import type { McpToolDefinition } from './mcp-client'
import { preprocessOpenApi } from './openapi-preprocessor'
import type { Spec } from './capability-resolution'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DiscoveredApiSpec {
  /**
   * Context path of the Cumulocity application (e.g. "dtm", "myservice")
   */
  contextPath: string
  /**
   * Human-readable application name
   */
  appLabel: string
  /**
   * Label for this specific spec entry (equals appLabel for single-spec apps)
   */
  specLabel: string
  /**
   * URL prefix prepended to spec paths for live requests (e.g. "/service/dtm")
   */
  servicePrefix: string
  /**
   * Full OpenAPI document with paths already rewritten to include servicePrefix
   */
  spec: Spec
}

/**
 * An MCP server declared by a subscribed microservice via `exposeMcpServers`
 * in its manifest, with the tool list already fetched at discovery time.
 */
export interface DiscoveredMcpServer {
  /**
   * Context path of the declaring application — also the namespace key.
   */
  contextPath: string
  /**
   * Human-readable application name
   */
  appLabel: string
  /**
   * Name of the MCP server entry from the manifest.
   */
  mcpName: string
  /**
   * Description from the manifest entry (falls back to server instructions).
   */
  description?: string
  /**
   * Tenant-relative MCP endpoint path (e.g. "/service/foo/mcp").
   */
  url: string
  /**
   * Whether the end user's Authorization header is forwarded on tool calls.
   */
  sendAuthentication: boolean
  /**
   * Tools listed at discovery time. Tool CALLS run as the end user at
   * runtime; this list is only the discoverability snapshot.
   */
  tools: McpToolDefinition[]
}

// ---------------------------------------------------------------------------
// Internal C8y response types
// ---------------------------------------------------------------------------

interface ExposedMcpServerEntry {
  name?: string
  description?: string
  url?: string
  type?: string
  sendAuthentication?: boolean
}

interface AppManifest {
  openApiSpec?: string | Array<{ label: string, path: string }>
  exposeMcpServers?: ExposedMcpServerEntry[]
  [key: string]: unknown
}

type DiscoveryApplication = IApplication & {
  contextPath?: string
  manifest?: AppManifest
}

// ---------------------------------------------------------------------------
// Cache — just promises
// ---------------------------------------------------------------------------

/**
 * Full result of one discovery run for a tenant.
 */
export interface DiscoveryResult {
  /**
   * Apps that expose an OpenAPI spec URL and whose spec fetched successfully.
   */
  specs: DiscoveredApiSpec[]
  /**
   * Apps that declare `exposeMcpServers` (type http) and whose tool list
   * fetched successfully. A service appearing here is preferred over its
   * OpenAPI spec at namespace assembly.
   */
  mcpServers: DiscoveredMcpServer[]
  /**
   * Context paths of all microservices the tenant owns or is subscribed to,
   * regardless of whether they have a spec URL. Discovery filters the
   * applications listing to type=MICROSERVICE, so HOSTED/EXTERNAL apps never
   * appear here.
   */
  installedContextPaths: ReadonlySet<string>
}

// Cache only holds last-known-good results plus any in-flight promise used
// to dedupe concurrent first-time callers. A failed discovery is never
// persisted: the in-flight entry is removed so the next caller retries, and
// the failure propagates to the current request.
const cache = new Map<string, Promise<DiscoveryResult>>()

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start discovery for the given tenant if not already started, or return the
 * existing in-flight / last-known-good promise. Idempotent — safe to call
 * on every request.
 *
 * Failure handling: if the discovery promise rejects and there is no
 * prior cached result, the in-flight entry is removed so the next caller
 * retries, and the rejection propagates to the current caller (the request
 * fails). A prior successful entry is never overwritten by a failure.
 * @param tenantId - Cumulocity tenant ID; used as the cache key
 * @param client - Configured Cumulocity client for all API reads
 */
export function startDiscovery(tenantId: string, client: Client): Promise<DiscoveryResult> {
  const existing = cache.get(tenantId)
  if (existing)
    return existing

  const promise = discoverTenantCapabilities(client, tenantId)
  cache.set(tenantId, promise)
  promise.catch((err: unknown) => {
    consola.warn(`Capability discovery failed for tenant ${tenantId}:`, c8yErrorSummary(err))
    if (cache.get(tenantId) === promise)
      cache.delete(tenantId)
  })
  return promise
}

/**
 * Bust the cache for a tenant and immediately start fresh discovery.
 * @param tenantId - Cumulocity tenant ID for the cache key
 * @param client - Configured Cumulocity client for the fresh discovery run
 */
export function refreshCapabilities(tenantId: string, client: Client): Promise<DiscoveryResult> {
  cache.delete(tenantId)
  return startDiscovery(tenantId, client)
}

/**
 * Peek the cache without triggering discovery. Returns the in-flight or
 * resolved promise for this tenant, or undefined when no entry exists.
 * @param tenantId - Cumulocity tenant ID for the cache key
 */
export function getCachedDiscovery(tenantId: string): Promise<DiscoveryResult> | undefined {
  return cache.get(tenantId)
}

/**
 * Clear the cache for one tenant or every tenant.
 * @param tenantId - If provided, only that tenant's entry is cleared
 */
export function bustCapabilityCache(tenantId?: string): void {
  if (tenantId)
    cache.delete(tenantId)
  else
    cache.clear()
}

/**
 * Seed the cache with a pre-resolved result. Intended for tests.
 * installedContextPaths defaults to the context paths present in specs.
 * @param tenantId - Cumulocity tenant ID for the cache key
 * @param specs - Discovered specs to cache
 * @param installedContextPaths - Installed context paths (defaults to spec context paths)
 * @param mcpServers - Discovered MCP servers to cache (defaults to none)
 */
export function setCachedCapabilities(
  tenantId: string,
  specs: DiscoveredApiSpec[],
  installedContextPaths?: ReadonlySet<string>,
  mcpServers: DiscoveredMcpServer[] = [],
): void {
  cache.set(tenantId, Promise.resolve({
    specs,
    mcpServers,
    installedContextPaths: installedContextPaths ?? new Set(specs.map((s) => s.contextPath)),
  }))
}

// ---------------------------------------------------------------------------
// Core discovery logic
// ---------------------------------------------------------------------------

// Applications listing page size. Small pages keep each response well under
// the internal gateway's streaming limits — `applicationsByTenant` with
// pageSize=2000 returned every HOSTED web app manifest in one response and
// got cut off mid-body ("Premature close") on app-heavy tenants.
const APPLICATIONS_PAGE_SIZE = 100

// Runaway guard for the pagination loop (100 * 50 = 5000 apps, far above any
// real tenant's microservice count).
const APPLICATIONS_MAX_PAGES = 50

// mc8yp's own contextPath (cumulocity.json). Its manifest declares an MCP
// server too — wrapping our own /mcp endpoint would recurse the codemode
// sandbox into itself, so the self entry is always skipped.
const OWN_CONTEXT_PATH = 'mc8yp-server'

/**
 * Fetch and return every capability discovered for the given tenant — OpenAPI
 * specs and MCP servers alike.
 * Throws on fatal errors (applications listing); individual spec download and
 * MCP handshake failures are skipped.
 *
 * Uses `/application/applications?tenant=<id>&type=MICROSERVICE`, paginated.
 * The `tenant` filter covers apps the tenant owns or is subscribed to, and
 * `type=MICROSERVICE` drops HOSTED/EXTERNAL apps — they can never contribute
 * a spec anyway (spec download goes through `/service/<contextPath>/`, which
 * only exists for microservices) and their large manifests were what made the
 * unpaginated response exceed gateway limits. The endpoint needs only
 * ROLE_APPLICATION_MANAGEMENT_READ and does not depend on /user/currentUser,
 * so it works with service-user credentials.
 *
 * All Cumulocity API calls go through the provided \@c8y/client. This module
 * never touches `fetch` directly so auth strategy choice (Basic, Bearer,
 * cookie, service-user) stays in the client construction layer.
 * @param client - Configured Cumulocity client used for all API reads
 * @param tenantId - Cumulocity tenant ID to list applications for
 */
export async function discoverTenantCapabilities(client: Client, tenantId: string): Promise<DiscoveryResult> {
  const apps: DiscoveryApplication[] = []
  try {
    for (let currentPage = 1; currentPage <= APPLICATIONS_MAX_PAGES; currentPage++) {
      const res = await client.application.list({
        tenant: tenantId,
        type: 'MICROSERVICE',
        pageSize: APPLICATIONS_PAGE_SIZE,
        currentPage,
        withTotalPages: false,
      })
      const page = (res.data ?? []) as DiscoveryApplication[]
      apps.push(...page)
      if (page.length < APPLICATIONS_PAGE_SIZE)
        break
    }
  } catch (err) {
    throw new Error(`Failed to fetch applications: ${c8yErrorSummary(err)}`)
  }

  const appsWithSpec = apps.filter(
    (app): app is DiscoveryApplication & { contextPath: string, name: string, manifest: AppManifest & { openApiSpec: NonNullable<AppManifest['openApiSpec']> } } =>
      typeof app.contextPath === 'string' && app.contextPath.length > 0
      && typeof app.name === 'string' && app.name.length > 0
      && app.manifest != null && app.manifest.openApiSpec != null,
  )

  const seenContextPaths = new Map<string, string>()
  for (const app of appsWithSpec) {
    const existing = seenContextPaths.get(app.contextPath)
    if (existing != null && existing !== app.name) {
      throw new Error(
        `Two subscribed applications share context path "${app.contextPath}": `
        + `"${existing}" and "${app.name}". This should not happen. Unsubscribe or remove one of them.`,
      )
    }
    seenContextPaths.set(app.contextPath, app.name)
  }

  // Track all installed context paths (not just those with a spec URL)
  const installedContextPaths = new Set<string>(
    apps
      .filter((app): app is DiscoveryApplication & { contextPath: string } =>
        typeof app.contextPath === 'string' && app.contextPath.length > 0)
      .map((app) => app.contextPath),
  )

  const seenForDownload = new Set<string>()
  const specs: DiscoveredApiSpec[] = []

  for (const app of appsWithSpec) {
    if (seenForDownload.has(app.contextPath))
      continue
    seenForDownload.add(app.contextPath)

    const servicePrefix = `/service/${app.contextPath}`
    const entries: Array<{ label: string, path: string }>
      = typeof app.manifest.openApiSpec === 'string'
        ? [{ label: app.name, path: app.manifest.openApiSpec }]
        : app.manifest.openApiSpec

    for (const entry of entries) {
      try {
        // Use the low-level FetchClient so we get a raw Response (services
        // would throw on >=400 which would defeat per-entry skip).
        const specRes = await client.core.fetch(`${servicePrefix}/${entry.path.replace(/^\//, '')}`)
        if (!specRes.ok) {
          consola.warn(`[discovery] OpenAPI spec "${entry.label}" of "${app.contextPath}" skipped: ${specRes.status} from ${servicePrefix}/${entry.path.replace(/^\//, '')}`)
          continue
        }
        const resolvedSpec = await preprocessOpenApi(await specRes.json() as Spec, { servicePrefix })
        specs.push({
          contextPath: app.contextPath,
          appLabel: app.name,
          specLabel: entry.label,
          servicePrefix,
          spec: resolvedSpec,
        })
      } catch (err) {
        consola.warn(`[discovery] OpenAPI spec "${entry.label}" of "${app.contextPath}" skipped:`, err instanceof Error ? err.message : err)
      }
    }
  }

  const mcpServers = await discoverMcpServers(client, apps)

  logDiscoverySummary(tenantId, specs, mcpServers, installedContextPaths)

  return { specs, mcpServers, installedContextPaths }
}

/**
 * One-shot summary of what a discovery run produced — which services
 * surfaced an OpenAPI spec, which surfaced an MCP server (and how many
 * tools), and where MCP takes precedence over an also-present spec.
 * @param tenantId - Tenant the run was for
 * @param specs - Successfully fetched OpenAPI specs
 * @param mcpServers - Successfully connected MCP servers
 * @param installedContextPaths - Every installed microservice contextPath
 */
function logDiscoverySummary(
  tenantId: string,
  specs: readonly DiscoveredApiSpec[],
  mcpServers: readonly DiscoveredMcpServer[],
  installedContextPaths: ReadonlySet<string>,
): void {
  const specContextPaths = [...new Set(specs.map((s) => s.contextPath))]
  const mcpList = mcpServers.map((s) => `${s.contextPath} (${s.tools.length} tools)`)
  consola.info(
    `[discovery] tenant ${tenantId}: ${installedContextPaths.size} microservice(s) installed — `
    + `OpenAPI specs: ${specContextPaths.length > 0 ? specContextPaths.join(', ') : 'none'}; `
    + `MCP servers: ${mcpList.length > 0 ? mcpList.join(', ') : 'none'}`,
  )

  const mcpContextPaths = new Set(mcpServers.map((s) => s.contextPath))
  const both = specContextPaths.filter((contextPath) => mcpContextPaths.has(contextPath))
  if (both.length > 0)
    consola.info(`[discovery] MCP preferred over OpenAPI for: ${both.join(', ')} (per-connection fallback via noMcp)`)

  const neither = [...installedContextPaths].filter((contextPath) => !mcpContextPaths.has(contextPath) && !specContextPaths.includes(contextPath))
  if (neither.length > 0)
    consola.info(`[discovery] no API surface (no spec, no MCP): ${neither.join(', ')}`)
}

/**
 * Collect MCP servers declared via `exposeMcpServers` in application
 * manifests and fetch each one's tool list. Only `type: "http"` entries are
 * supported; one MCP server per contextPath (the first valid entry wins —
 * the namespace is keyed by contextPath). Servers whose handshake or tool
 * listing fails are skipped with a warning, mirroring per-spec skip
 * behaviour.
 *
 * The tool list is fetched with the discovery client's credentials (service
 * user in server mode, the active user in CLI mode) purely for
 * discoverability; tool CALLS at runtime always run as the end user.
 * @param client - Configured Cumulocity client used for the MCP handshake
 * @param apps - Applications already fetched by the discovery run
 */
async function discoverMcpServers(client: Client, apps: DiscoveryApplication[]): Promise<DiscoveredMcpServer[]> {
  const servers: DiscoveredMcpServer[] = []
  const seen = new Set<string>()

  for (const app of apps) {
    if (typeof app.contextPath !== 'string' || app.contextPath.length === 0 || typeof app.name !== 'string')
      continue
    if (app.contextPath === OWN_CONTEXT_PATH)
      continue
    if (seen.has(app.contextPath))
      continue
    const entries = app.manifest?.exposeMcpServers
    if (!Array.isArray(entries))
      continue

    const httpEntries = entries.filter((e) => e?.type === 'http' && typeof e.url === 'string' && e.url.length > 0)
    if (httpEntries.length === 0)
      continue
    if (httpEntries.length > 1)
      consola.warn(`[discovery] "${app.contextPath}" declares ${httpEntries.length} http MCP servers — only the first ("${httpEntries[0]!.name}") is wrapped.`)
    const entry = httpEntries[0]!
    seen.add(app.contextPath)

    const mcpClient = new McpHttpClient({
      url: entry.url!,
      fetch: (path, init) => client.core.fetch(path, init as Parameters<typeof client.core.fetch>[1]),
    })
    try {
      const info = await mcpClient.initialize()
      const tools = await mcpClient.listTools()
      servers.push({
        contextPath: app.contextPath,
        appLabel: app.name,
        mcpName: entry.name ?? app.contextPath,
        description: entry.description ?? info.instructions,
        url: entry.url!,
        sendAuthentication: entry.sendAuthentication !== false,
        tools,
      })
    } catch (err) {
      consola.warn(`[discovery] MCP server "${entry.name ?? app.contextPath}" at ${entry.url} skipped:`, err instanceof Error ? err.message : err)
    } finally {
      await mcpClient.close()
    }
  }

  return servers
}
