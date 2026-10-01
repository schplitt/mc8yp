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

// Tenant restored at startup whose TFA session had run out. Nobody can be
// asked for a code before a client connects, so activation is deferred to
// the first codemode / set-active-tenant call (see ensureCliTenantReady).
let _pendingTenantUrl: string | null = null

/**
 * Return the current CLI tenant context, or null if none has been set.
 */
export function getCliTenantContext(): CliTenantContext | null {
  return _context
}

/**
 * Return the tenant that is selected but waits for a new TFA code before it
 * can be activated, or null.
 */
export function getPendingCliTenantUrl(): string | null {
  return _pendingTenantUrl
}

/**
 * Drop the in-memory tenant context. Used by drift-recovery (credentials
 * disappeared for the active tenant) and by the explicit reset path on
 * set-active-tenant. Does not touch persistence — the caller is responsible
 * for that, so the two layers can be exercised independently in tests.
 */
export function clearCliTenantContext(): void {
  _context = null
  _pendingTenantUrl = null
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
  _context = await resolveCliTenantContext(tenantUrl)
  _pendingTenantUrl = null
  return _context
}

/**
 * Restore the persisted tenant at CLI startup. A TFA session that has run
 * out (or is about to) cannot be renewed yet — no client is connected to
 * ask for a code — so the tenant is only marked pending and activated on
 * the first call instead.
 * @param tenantUrl - Persisted active tenant URL
 * @returns The activated context, or null when activation waits for a TFA code
 */
export async function restoreCliTenantContext(tenantUrl: string): Promise<CliTenantContext | null> {
  const creds = await globalThis._getCredentialsByTenantUrl(tenantUrl)
  if (creds.tfaSession && creds.tfaSession.expiresAt - Date.now() <= TFA_REFRESH_MARGIN_MS) {
    _pendingTenantUrl = tenantUrl
    return null
  }
  return setCliTenantContext(tenantUrl)
}

async function resolveCliTenantContext(tenantUrl: string): Promise<CliTenantContext> {
  const creds = await getFreshCliCredentials(tenantUrl)
  const authHeaders = createC8yAuthHeaders(creds)
  const cliClient = createCliClient(creds)

  // startDiscovery is idempotent: returns the cached promise if already running.
  // _context.specs is a resolved snapshot; the cache is busted externally
  // when service-user credentials rotate. Call set-active-tenant again to
  // force a fresh snapshot into the context.
  const { specs: discovered, installedContextPaths, mcpServers } = await startDiscovery(creds.tenantId, cliClient)

  return {
    tenantUrl,
    authorizationHeader: authHeaders.Authorization!,
    specs: resolveCapabilities(discovered, installedContextPaths, mcpServers),
    tfaExpiresAt: creds.tfaSession?.expiresAt,
  }
}

/**
 * Make the selected tenant usable before a codemode run:
 * - a tenant left pending at startup is activated now (asks for the TFA
 *   code, then runs discovery);
 * - an active tenant whose TFA session is about to expire is renewed.
 *
 * The new auth (and, on activation, specs) is pushed into the shared MCP
 * context. Noop for Basic-auth tenants and while the token is still fresh,
 * so the keyring is only read near expiry.
 *
 * Throws (via `getFreshCliCredentials`) when the code cannot be obtained;
 * the codemode tool then fails the call without running the code.
 */
export async function ensureCliTenantReady(): Promise<void> {
  const custom = c8yMcpServer.ctx.custom
  const pending = _pendingTenantUrl
  if (!_context && pending) {
    const ctx = await resolveCliTenantContext(pending)
    // Waited on the user; a set-active-tenant meanwhile wins.
    if (_pendingTenantUrl !== pending || _context) {
      return
    }
    _context = ctx
    _pendingTenantUrl = null
    if (custom) {
      custom.auth = { tenantUrl: ctx.tenantUrl, authorizationHeader: ctx.authorizationHeader }
      custom.specs = ctx.specs
    }
    return
  }

  const ctx = _context
  if (!ctx?.tfaExpiresAt || ctx.tfaExpiresAt - Date.now() > TFA_REFRESH_MARGIN_MS) {
    return
  }

  const creds = await getFreshCliCredentials(ctx.tenantUrl)
  // The renewal may have waited on the user; if set-active-tenant switched
  // tenants meanwhile, writing now would put this tenant's auth back.
  if (_context !== ctx) {
    return
  }
  ctx.authorizationHeader = createC8yAuthHeaders(creds).Authorization!
  ctx.tfaExpiresAt = creds.tfaSession?.expiresAt

  if (custom) {
    custom.auth = { tenantUrl: ctx.tenantUrl, authorizationHeader: ctx.authorizationHeader }
  }
}
