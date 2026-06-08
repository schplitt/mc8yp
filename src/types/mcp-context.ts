import type { ResolvedSpecs } from '../utils/spec-resolution'
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
   * Resolved specs for the query sandbox: always-available `core` plus a
   * service-spec map keyed by contextPath (bundled service entries + any
   * non-bundled discovered services). Paths are already prefixed.
   * Set per-request in server mode; set on tenant activation in CLI mode.
   */
  specs: ResolvedSpecs
  /**
   * Tenant auth for the current connection.
   * Always set in server mode (per-request from the Authorization header).
   * May be absent in CLI mode until set-active-tenant is called.
   */
  auth?: RequestAuth
}
