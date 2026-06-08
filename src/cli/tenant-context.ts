/**
 * CLI tenant context singleton.
 *
 * In CLI mode there is always one active tenant at a time. This module holds
 * the resolved context for that tenant so query and execute tools can read
 * from it directly without going through the MCP request context.
 *
 * Flow:
 *  1. CLI startup reads the persisted tenant URL (active-tenant.json) and
 *     calls setCliTenantContext to warm the context before the first tool call.
 *  2. The set-active-tenant tool calls setCliTenantContext whenever the user
 *     switches tenants — resolves fresh specs via the discovery cache.
 *  3. Tools call getCliTenantContext(); if null they throw a clear error.
 */

import { startDiscovery } from '../utils/api-discovery'
import { createC8yAuthHeaders } from '../utils/client'
import type { ResolvedSpecs } from '../utils/spec-resolution'
import { resolveSpecs } from '../utils/spec-resolution'

export interface CliTenantContext {
  tenantUrl: string
  /**
   * Pre-computed Authorization header value for this tenant.
   */
  authorizationHeader: string
  /**
   * Fully resolved specs (bundled + discovered, paths pre-prefixed).
   */
  specs: ResolvedSpecs
}

let _context: CliTenantContext | null = null

/**
 * Return the current CLI tenant context, or null if none has been set.
 */
export function getCliTenantContext(): CliTenantContext | null {
  return _context
}

/**
 * Set (or update) the active tenant context.
 * Looks up credentials from the keyring, awaits discovery (idempotent —
 * uses the per-tenant cache), resolves specs, and stores the result in
 * memory so subsequent tool calls can read it synchronously.
 *
 * @param tenantUrl - Base URL of the Cumulocity tenant to activate
 * @param specRemoval - Whether to remove specs for services that are not installed on the tenant (true by default)
 */
export async function setCliTenantContext(tenantUrl: string, specRemoval: boolean): Promise<CliTenantContext> {
  const creds = await globalThis._getCredentialsByTenantUrl(tenantUrl)
  const authHeaders = createC8yAuthHeaders(creds)

  // startDiscovery is idempotent: returns the cached promise if already running.
  // It also schedules the 30-minute auto-refresh timer on first call for this
  // tenant so the underlying discovery cache stays current.
  // _context.specs is a resolved snapshot; after a background refresh the
  // discovery cache updates automatically. Call set-active-tenant again to
  // pull a refreshed snapshot into the context (or rely on server restart).
  const { specs: discovered, installedContextPaths } = await startDiscovery(tenantUrl, authHeaders)

  _context = {
    tenantUrl,
    authorizationHeader: authHeaders.Authorization!,
    specs: resolveSpecs(discovered, installedContextPaths, specRemoval),
  }

  return _context
}
