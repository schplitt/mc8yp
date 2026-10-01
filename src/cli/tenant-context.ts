import { c8yMcpServer } from '../server-instance'
import { startDiscovery } from '../utils/capability-discovery'
import { createC8yAuthHeaders } from '../utils/client'
import type { TenantCapabilities } from '../utils/capability-resolution'
import { resolveCapabilities } from '../utils/capability-resolution'
import { createCliClient, getFreshCliCredentials, TFA_REFRESH_MARGIN_MS } from './tfa-session'

export interface CliTenantContext {
  tenantUrl: string
  /**
   * Pre-computed Authorization header value for this tenant.
   */
  authorizationHeader: string
  /**
   * Fully resolved specs (bundled + discovered, paths pre-prefixed).
   */
  specs: TenantCapabilities
  /**
   * Expiry (epoch ms) of the TFA session token behind `authorizationHeader`.
   * Absent for Basic-auth credentials, which do not expire.
   */
  tfaExpiresAt?: number
}

let _context: CliTenantContext | null = null

/**
 * Return the current CLI tenant context, or null if none has been set.
 */
export function getCliTenantContext(): CliTenantContext | null {
  return _context
}

/**
 * Drop the in-memory tenant context. Used by drift-recovery (credentials
 * disappeared for the active tenant) and by the explicit reset path on
 * set-active-tenant. Does not touch persistence — the caller is responsible
 * for that, so the two layers can be exercised independently in tests.
 */
export function clearCliTenantContext(): void {
  _context = null
}

/**
 * Set (or update) the active tenant context.
 * Looks up credentials from the keyring, awaits discovery (idempotent —
 * uses the per-tenant cache), resolves specs, and stores the result in
 * memory so subsequent tool calls can read it synchronously.
 *
 * Spec removal is unconditional for an active tenant: bundled specs for
 * services that the tenant has not installed are dropped from the query
 * sandbox so the agent cannot accidentally plan against a surface that
 * isn't actually there. To browse all bundled snapshots, leave the CLI
 * with no active tenant (the no-tenant fallback in cli/index.ts keeps
 * everything visible).
 * @param tenantUrl - Base URL of the Cumulocity tenant to activate
 */
export async function setCliTenantContext(tenantUrl: string): Promise<CliTenantContext> {
  const creds = await getFreshCliCredentials(tenantUrl)
  const authHeaders = createC8yAuthHeaders(creds)
  const cliClient = createCliClient(creds)

  // startDiscovery is idempotent: returns the cached promise if already running.
  // _context.specs is a resolved snapshot; the cache is busted externally
  // when service-user credentials rotate. Call set-active-tenant again to
  // force a fresh snapshot into the context.
  const { specs: discovered, installedContextPaths, mcpServers } = await startDiscovery(creds.tenantId, cliClient)

  _context = {
    tenantUrl,
    authorizationHeader: authHeaders.Authorization!,
    specs: resolveCapabilities(discovered, installedContextPaths, mcpServers),
    tfaExpiresAt: creds.tfaSession?.expiresAt,
  }

  return _context
}

/**
 * Renew the active tenant's TFA session when it is about to expire, and
 * push the new Authorization header into the shared MCP context. Noop for
 * Basic-auth tenants and while the token is still fresh, so the keyring is
 * only read near expiry. Called by the codemode tool before each run.
 *
 * Throws (via `getFreshCliCredentials`) when the session cannot be renewed
 * here; the codemode tool surfaces that message to the agent.
 */
export async function renewCliTenantAuthIfExpiring(): Promise<void> {
  const ctx = _context
  if (!ctx?.tfaExpiresAt || ctx.tfaExpiresAt - Date.now() > TFA_REFRESH_MARGIN_MS) {
    return
  }

  const creds = await getFreshCliCredentials(ctx.tenantUrl)
  ctx.authorizationHeader = createC8yAuthHeaders(creds).Authorization!
  ctx.tfaExpiresAt = creds.tfaSession?.expiresAt

  const custom = c8yMcpServer.ctx.custom
  if (custom) {
    custom.auth = { tenantUrl: ctx.tenantUrl, authorizationHeader: ctx.authorizationHeader }
  }
}
