/**
 * Live microservice API spec discovery.
 *
 * The cache is a plain Map<tenantUrl, Promise<DiscoveredApiSpec[]>>. Callers
 * always await the promise — there is no pending/ready distinction. Replacing
 * the map entry is the refresh mechanism.
 *
 * A resolved snapshot is maintained in parallel so sync callers (e.g. the
 * description lambda in CLI mode) can read the last known result without
 * awaiting.
 */

import consola from 'consola'
import type { PathItem, Spec } from './spec-resolution'

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

// ---------------------------------------------------------------------------
// Internal C8y response types
// ---------------------------------------------------------------------------

interface C8yCurrentUser { id?: string }

interface C8yAppManifest {
  openApiSpec?: string | Array<{ label: string, path: string }>
  [key: string]: unknown
}

interface C8yApplication {
  id?: string
  name?: string
  contextPath?: string
  manifest?: C8yAppManifest
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
   * All subscribed app context paths regardless of whether they have a spec URL.
   */
  installedContextPaths: ReadonlySet<string>
}

const specPromises = new Map<string, Promise<DiscoveryResult>>()

const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>()

export const DISCOVERY_REFRESH_INTERVAL_MS = 30 * 60 * 1000

function normalizeTenantUrl(url: string): string {
  try {
    return new URL(url).toString().replace(/\/$/, '')
  } catch {
    return url.replace(/\/$/, '')
  }
}

function clearRefreshTimer(key: string): void {
  const t = refreshTimers.get(key)
  if (t) {
    clearTimeout(t)
    refreshTimers.delete(key)
  }
}

function scheduleRefresh(key: string, authHeaders: Record<string, string>): void {
  clearRefreshTimer(key)
  const timer = setTimeout(() => {
    refreshTimers.delete(key)
    const empty: DiscoveryResult = { specs: [], installedContextPaths: new Set() }
    const promise = discoverApiSpecs(key, authHeaders).catch((): DiscoveryResult => empty)
    specPromises.set(key, promise)
    promise.then(() => scheduleRefresh(key, authHeaders)).catch(() => {})
  }, DISCOVERY_REFRESH_INTERVAL_MS)
  timer.unref?.()
  refreshTimers.set(key, timer)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start discovery for the given tenant if not already started, or return the
 * existing in-flight promise. Idempotent — safe to call on every request.
 * @param tenantUrl - Base URL of the Cumulocity tenant
 * @param authHeaders - Auth headers used for all discovery requests
 */
export function startDiscovery(
  tenantUrl: string,
  authHeaders: Record<string, string>,
): Promise<DiscoveryResult> {
  const key = normalizeTenantUrl(tenantUrl)
  if (specPromises.has(key))
    return specPromises.get(key)!

  const empty: DiscoveryResult = { specs: [], installedContextPaths: new Set() }
  const promise = discoverApiSpecs(key, authHeaders).catch((err: unknown): DiscoveryResult => {
    consola.warn(`API spec discovery failed for ${key}:`, err instanceof Error ? err.message : String(err))
    return empty
  })

  promise.then(() => scheduleRefresh(key, authHeaders)).catch(() => {})

  specPromises.set(key, promise)
  return promise
}

/**
 * Bust the cache for a tenant and immediately start fresh discovery.
 * @param tenantUrl - Base URL of the Cumulocity tenant
 * @param authHeaders - Auth headers for the new discovery request
 */
export function refreshApiSpecs(
  tenantUrl: string,
  authHeaders: Record<string, string>,
): Promise<DiscoveryResult> {
  const key = normalizeTenantUrl(tenantUrl)
  clearRefreshTimer(key)
  specPromises.delete(key)
  return startDiscovery(key, authHeaders)
}

/**
 * Clear the cache (and refresh timers) for one tenant or all tenants.
 * @param tenantUrl - If provided, only that tenant is cleared
 */
export function bustApiSpecCache(tenantUrl?: string): void {
  if (tenantUrl) {
    const key = normalizeTenantUrl(tenantUrl)
    clearRefreshTimer(key)
    specPromises.delete(key)
  } else {
    for (const key of specPromises.keys()) clearRefreshTimer(key)
    specPromises.clear()
  }
}

/**
 * Seed the cache with a pre-resolved result. Intended for tests.
 * @param tenantUrl - Base URL of the Cumulocity tenant
 * @param specs - Specs to treat as the ready result
 */
/**
 * Seed the cache with a pre-resolved result. Intended for tests.
 * installedContextPaths defaults to the context paths present in specs.
 * @param tenantUrl - Base URL of the Cumulocity tenant
 * @param specs - Discovered specs to cache
 * @param installedContextPaths - Installed context paths (defaults to spec context paths)
 */
export function setCachedApiSpecs(
  tenantUrl: string,
  specs: DiscoveredApiSpec[],
  installedContextPaths?: ReadonlySet<string>,
): void {
  const key = normalizeTenantUrl(tenantUrl)
  clearRefreshTimer(key)
  const result: DiscoveryResult = {
    specs,
    installedContextPaths: installedContextPaths ?? new Set(specs.map((s) => s.contextPath)),
  }
  specPromises.set(key, Promise.resolve(result))
}

// ---------------------------------------------------------------------------
// Path rewriting — mirrors the build-time rewrite in tsdown.config.ts
// ---------------------------------------------------------------------------

function rewriteDiscoveredSpecPaths(spec: Spec, servicePrefix: string): Spec {
  const paths = spec.paths
  if (paths && typeof paths === 'object') {
    const rewritten: Record<string, PathItem> = {}
    for (const [p, item] of Object.entries(paths)) rewritten[`${servicePrefix}${p}`] = item
    spec = { ...spec, paths: rewritten }
  }
  return spec
}

// ---------------------------------------------------------------------------
// Core discovery logic
// ---------------------------------------------------------------------------

/**
 * Fetch and return discovered specs for the given tenant.
 * Throws on fatal errors; individual spec download failures are skipped.
 * @param tenantUrl - Normalised base URL of the Cumulocity tenant
 * @param authHeaders - Auth headers for all HTTP requests
 */
export async function discoverApiSpecs(
  tenantUrl: string,
  authHeaders: Record<string, string>,
): Promise<DiscoveryResult> {
  const baseUrl = normalizeTenantUrl(tenantUrl)
  const headers: Record<string, string> = { ...authHeaders, Accept: 'application/json' }

  const userRes = await fetch(`${baseUrl}/user/currentUser`, { headers })
  if (!userRes.ok)
    throw new Error(`Failed to fetch current user: ${userRes.status} ${userRes.statusText}`)
  const currentUser = await userRes.json() as C8yCurrentUser
  if (!currentUser.id)
    throw new Error('Could not determine current user ID from /user/currentUser response')

  const appsRes = await fetch(
    `${baseUrl}/application/applicationsByUser/${encodeURIComponent(currentUser.id)}?pageSize=2000`,
    { headers },
  )
  if (!appsRes.ok)
    throw new Error(`Failed to fetch applications: ${appsRes.status} ${appsRes.statusText}`)
  const apps = ((await appsRes.json() as { applications?: C8yApplication[] }).applications) ?? []

  const appsWithSpec = apps.filter(
    (app): app is C8yApplication & { contextPath: string, name: string, manifest: C8yAppManifest & { openApiSpec: NonNullable<C8yAppManifest['openApiSpec']> } } =>
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
      .filter((app): app is C8yApplication & { contextPath: string } =>
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
        const specRes = await fetch(`${baseUrl}${servicePrefix}/${entry.path.replace(/^\//, '')}`, { headers })
        if (!specRes.ok)
          continue
        specs.push({
          contextPath: app.contextPath,
          appLabel: app.name,
          specLabel: entry.label,
          servicePrefix,
          spec: rewriteDiscoveredSpecPaths(await specRes.json() as Spec, servicePrefix),
        })
      } catch { /* skip individual spec failures */ }
    }
  }

  return { specs, installedContextPaths }
}
