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
import type { Client, IApplication } from '@c8y/client'
import { c8yErrorSummary } from './client'
import { resolveCodeModeExtension } from './resolve-xcodemode'
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

interface AppManifest {
  openApiSpec?: string | Array<{ label: string, path: string }>
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
   * All subscribed app context paths regardless of whether they have a spec URL.
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

  const promise = discoverApiSpecs(client, tenantId)
  cache.set(tenantId, promise)
  promise.catch((err: unknown) => {
    consola.warn(`API spec discovery failed for tenant ${tenantId}:`, c8yErrorSummary(err))
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
export function refreshApiSpecs(tenantId: string, client: Client): Promise<DiscoveryResult> {
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
export function bustApiSpecCache(tenantId?: string): void {
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
 */
export function setCachedApiSpecs(
  tenantId: string,
  specs: DiscoveredApiSpec[],
  installedContextPaths?: ReadonlySet<string>,
): void {
  cache.set(tenantId, Promise.resolve({
    specs,
    installedContextPaths: installedContextPaths ?? new Set(specs.map((s) => s.contextPath)),
  }))
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
 * Throws on fatal errors (applications listing); individual spec download
 * failures are skipped.
 *
 * Uses `applicationsByTenant/{tenantId}` (via `listByTenant`) rather than
 * the user-scoped `applicationsByUser` endpoint so the call works with
 * service-user credentials — service users cannot call /user/currentUser,
 * which the user-scoped endpoint depends on. The tenantId is always known
 * at the call site (it is the discovery cache key).
 *
 * All Cumulocity API calls go through the provided \@c8y/client. This module
 * never touches `fetch` directly so auth strategy choice (Basic, Bearer,
 * cookie, service-user) stays in the client construction layer.
 * @param client - Configured Cumulocity client used for all API reads
 * @param tenantId - Cumulocity tenant ID to list applications for
 */
export async function discoverApiSpecs(client: Client, tenantId: string): Promise<DiscoveryResult> {
  let apps: DiscoveryApplication[]
  try {
    const res = await client.application.listByTenant(tenantId, { pageSize: 2000 })
    apps = (res.data ?? []) as DiscoveryApplication[]
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
        if (!specRes.ok)
          continue

        const resolvedSpec = await specRes.json() as Spec
        resolveCodeModeExtension(resolvedSpec, servicePrefix)

        specs.push({
          contextPath: app.contextPath,
          appLabel: app.name,
          specLabel: entry.label,
          servicePrefix,
          spec: rewriteDiscoveredSpecPaths(resolvedSpec, servicePrefix),
        })
      } catch { /* skip individual spec failures */ }
    }
  }

  return { specs, installedContextPaths }
}
