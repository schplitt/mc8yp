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
  spec: unknown
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
 * The canonical cache. Awaiting any entry gives the discovered specs.
 */
const specPromises = new Map<string, Promise<DiscoveredApiSpec[]>>()

/**
 * Resolved snapshot updated whenever a promise settles.
 * Used by sync callers (description lambdas in CLI mode) that cannot await.
 */
const specSnapshots = new Map<string, DiscoveredApiSpec[]>()

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
    // Replace the cache entry — anyone already awaiting the old promise
    // gets the old result; new awaits get fresh data.
    const promise = discoverApiSpecs(key, authHeaders).catch((): DiscoveredApiSpec[] => [])
    specPromises.set(key, promise)
    promise.then((specs) => {
      specSnapshots.set(key, specs)
      scheduleRefresh(key, authHeaders)
    }).catch(() => {})
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
): Promise<DiscoveredApiSpec[]> {
  const key = normalizeTenantUrl(tenantUrl)
  if (specPromises.has(key))
    return specPromises.get(key)!

  const promise = discoverApiSpecs(key, authHeaders).catch((err: unknown): DiscoveredApiSpec[] => {
    consola.warn(`API spec discovery failed for ${key}:`, err instanceof Error ? err.message : String(err))
    return []
  })

  promise.then((specs) => {
    specSnapshots.set(key, specs)
    scheduleRefresh(key, authHeaders)
  }).catch(() => {})

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
): Promise<DiscoveredApiSpec[]> {
  const key = normalizeTenantUrl(tenantUrl)
  clearRefreshTimer(key)
  specPromises.delete(key)
  specSnapshots.delete(key)
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
    specSnapshots.delete(key)
  } else {
    for (const key of specPromises.keys()) clearRefreshTimer(key)
    specPromises.clear()
    specSnapshots.clear()
  }
}

/**
 * Seed the cache with a pre-resolved result. Intended for tests.
 * @param tenantUrl - Base URL of the Cumulocity tenant
 * @param specs - Specs to treat as the ready result
 */
export function setCachedApiSpecs(tenantUrl: string, specs: DiscoveredApiSpec[]): void {
  const key = normalizeTenantUrl(tenantUrl)
  clearRefreshTimer(key)
  specPromises.set(key, Promise.resolve(specs))
  specSnapshots.set(key, specs)
}

/**
 * Synchronously return the last resolved specs for a tenant, or null if
 * discovery has not yet completed. Use startDiscovery + await when you can wait.
 * @param tenantUrl - Base URL of the Cumulocity tenant
 */
export function getReadySpecs(tenantUrl: string): DiscoveredApiSpec[] | null {
  return specSnapshots.get(normalizeTenantUrl(tenantUrl)) ?? null
}

/**
 * Synchronously return the merged union of all resolved tenant snapshots,
 * deduplicated by contextPath (last inserted wins). Safe to call at any time.
 */
export function getAllReadySpecs(): DiscoveredApiSpec[] {
  const merged = new Map<string, DiscoveredApiSpec>()
  for (const specs of specSnapshots.values()) {
    for (const spec of specs) merged.set(spec.contextPath, spec)
  }
  return [...merged.values()]
}

// ---------------------------------------------------------------------------
// Path rewriting — mirrors the build-time rewrite in tsdown.config.ts
// ---------------------------------------------------------------------------

function rewriteDiscoveredSpecPaths(spec: Record<string, unknown>, servicePrefix: string): Record<string, unknown> {
  const paths = spec.paths as Record<string, unknown> | undefined
  if (paths && typeof paths === 'object') {
    const rewritten: Record<string, unknown> = {}
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
): Promise<DiscoveredApiSpec[]> {
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

  const seenForDownload = new Set<string>()
  const discovered: DiscoveredApiSpec[] = []

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
        discovered.push({
          contextPath: app.contextPath,
          appLabel: app.name,
          specLabel: entry.label,
          servicePrefix,
          spec: rewriteDiscoveredSpecPaths(await specRes.json() as Record<string, unknown>, servicePrefix),
        })
      } catch { /* skip individual spec failures */ }
    }
  }

  return discovered
}
