import type { Specs } from '../utils/spec-resolution'
import type { AllowRule, RestrictionRule } from '../utils/restrictions'

/**
 * Auth credentials for the current tenant.
 */
export interface RequestAuth {
  tenantUrl: string
  authorizationHeader: string
}

export interface C8yMcpCustomContext extends Record<string, unknown> {
  /**
   * Runtime environment — used for mode-aware error messages inside tool handlers.
   */
  env: 'cli' | 'server'
  restrictions: RestrictionRule[]
  allowRules: AllowRule[]
  /**
   * Flat resolved spec map for the query sandbox (paths already prefixed).
   * `core` always present; bundled service specs keyed by contextPath; live
   * discovered services pass through. Set per-request in server mode and by
   * set-active-tenant in CLI mode.
   */
  specs: Specs
  /**
   * Per bundled spec (core + every known bundled service): is it actually
   * installed on the current tenant? Stays accurate even when --no-spec-removal
   * keeps an absent service's bundled spec visible for reference.
   */
  specsEnabled: Record<string, boolean>
  /**
   * Tenant auth for the current connection.
   * Always set in server mode (per-request from the Authorization header).
   * May be absent in CLI mode until set-active-tenant is called.
   */
  auth?: RequestAuth
}
