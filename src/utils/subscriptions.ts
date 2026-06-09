/**
 * Subscribed-tenant credentials cache for microservice mode.
 *
 * Uses bootstrap credentials (from C8Y_BOOTSTRAP_* env) to call
 * `Client.getMicroserviceSubscriptions` and build a map of tenantId →
 * service-user credentials.
 *
 * The cache is a single promise; readers always await it. A plain
 * setTimeout-driven refresh runs every 15 minutes:
 *   - On success: the cache promise is replaced with the fresh map.
 *   - On failure: the previous map is kept and a warning is logged.
 *
 * This module is server-mode-only. The CLI never calls into it.
 */

import process from 'node:process'
import { BasicAuth, Client } from '@c8y/client'
import type { ICredentials } from '@c8y/client'
import consola from 'consola'
import { bustApiSpecCache, startDiscovery } from './api-discovery'

export const SUBSCRIPTIONS_REFRESH_INTERVAL_MS = 15 * 60 * 1000

type SubscriptionsMap = ReadonlyMap<string, ICredentials>

let currentPromise: Promise<SubscriptionsMap> | null = null
let refreshTimer: ReturnType<typeof setInterval> | null = null

function readBootstrap(): { tenant: string, user: string, password: string, baseUrl: string } {
  const tenant = process.env.C8Y_BOOTSTRAP_TENANT
  const user = process.env.C8Y_BOOTSTRAP_USER
  const password = process.env.C8Y_BOOTSTRAP_PASSWORD
  const baseUrl = process.env.C8Y_BASEURL
  if (!tenant || !user || !password || !baseUrl) {
    throw new Error('Missing one of C8Y_BOOTSTRAP_TENANT, C8Y_BOOTSTRAP_USER, C8Y_BOOTSTRAP_PASSWORD, C8Y_BASEURL')
  }
  return { tenant, user, password, baseUrl }
}

async function fetchSubscriptions(): Promise<SubscriptionsMap> {
  const { tenant, user, password, baseUrl } = readBootstrap()
  const subs = await Client.getMicroserviceSubscriptions({ tenant, user, password }, baseUrl)
  const map = new Map<string, ICredentials>()
  for (const cred of subs) {
    if (cred.tenant)
      map.set(cred.tenant, cred)
  }
  return map
}

function warmDiscoveryCache(map: ReadonlyMap<string, ICredentials>): void {
  const baseUrl = process.env.C8Y_BASEURL!
  // Drop existing entries so each tenant gets a fresh discovery run with
  // the (potentially rotated) service-user credentials. startDiscovery is
  // fire-and-forget here — the resulting promises sit in the cache for
  // per-request lookups to await.
  bustApiSpecCache()
  for (const [tenantId, cred] of map) {
    startDiscovery(tenantId, new Client(new BasicAuth(cred), baseUrl))
      .catch(() => { /* logged inside startDiscovery; cache self-cleans on failure */ })
  }
}

function refresh(): void {
  // Fire-and-forget. The interval timer drives the cadence; this function
  // never reschedules itself, so there is no callback chain to grow.
  fetchSubscriptions().then(
    (map) => {
      currentPromise = Promise.resolve(map)
      consola.info(`Subscriptions cache refreshed: ${map.size} subscribed tenant(s) [${[...map.keys()].join(', ') || 'none'}]`)
      warmDiscoveryCache(map)
    },
    (err: unknown) => {
      consola.warn('Subscriptions refresh failed, keeping previous cache:', err instanceof Error ? err.message : String(err))
    },
  )
}

/**
 * Kick off the subscribed-tenant credentials cache and schedule the 15-minute
 * proactive refresh. Idempotent - calling it more than once is a no-op.
 *
 * Throws synchronously if any required env var is missing. Callers in
 * src/index.ts gate on env presence before invoking this.
 *
 * @returns The initial fetch promise (which itself never rejects - failures
 *   are logged and the cache is left in a "no subscribed tenants" state until
 *   the next refresh succeeds).
 */
export function startSubscriptionsRefresh(): Promise<SubscriptionsMap> {
  if (currentPromise)
    return currentPromise
  readBootstrap() // throws if env incomplete
  const initial = fetchSubscriptions().then(
    (map) => {
      consola.info(`Subscriptions cache initialised: ${map.size} subscribed tenant(s) [${[...map.keys()].join(', ') || 'none'}]`)
      warmDiscoveryCache(map)
      return map
    },
    (err: unknown): SubscriptionsMap => {
      consola.warn('Initial subscriptions fetch failed:', err instanceof Error ? err.message : String(err))
      return new Map()
    },
  )
  currentPromise = initial
  refreshTimer = setInterval(refresh, SUBSCRIPTIONS_REFRESH_INTERVAL_MS)
  refreshTimer.unref?.()
  return initial
}

/**
 * Resolve the service-user credentials for the given tenant, awaiting the
 * current (or initial) refresh promise. Returns undefined when the cache is
 * not active or the tenant is not subscribed.
 * @param tenantId Cumulocity tenant ID (e.g. "t12345").
 */
export async function getServiceUserCredentials(tenantId: string): Promise<ICredentials | undefined> {
  if (!currentPromise)
    return undefined
  const map = await currentPromise
  return map.get(tenantId)
}
