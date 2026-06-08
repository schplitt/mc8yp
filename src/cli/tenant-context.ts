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
let _specRemoval: boolean | null = null

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
export async function setCliTenantContext(tenantUrl: string, specRemoval?: boolean): Promise<CliTenantContext> {
  if (specRemoval !== undefined) {
    _specRemoval = specRemoval
  }
  if (_specRemoval === null) {
    throw new Error('specRemoval must be set on first call to setCliTenantContext')
  }

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
    specs: resolveSpecs(discovered, installedContextPaths, _specRemoval),
  }

  return _context
}
