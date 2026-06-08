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
   * Flat resolved spec map for the query sandbox (bundled + discovered, paths
   * already prefixed). Always present — empty object until a tenant is activated
   * in CLI mode; set per-request in server mode.
   */
  specs: Specs
  /**
   * Tenant auth for the current connection.
   * Always set in server mode (per-request from the Authorization header).
   * May be absent in CLI mode until set-active-tenant is called.
   */
  auth?: RequestAuth
}
