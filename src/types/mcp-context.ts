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
  /**
   * Connection-level restrictions. Optional because the probe fast path
   * (platform tool-listing requests without auth) sets no policy at all.
   * Tool handlers default to `[]` when reading this.
   */
  restrictions?: RestrictionRule[]
  /**
   * Connection-level allow rules. Optional for the same reason as
   * `restrictions`. Tool handlers default to `[]` when reading this.
   */
  allowRules?: AllowRule[]
  /**
   * Resolved specs for the query sandbox: always-available `core` plus a
   * service-spec map keyed by contextPath (bundled service entries + any
   * non-bundled discovered services). Paths are already prefixed.
   *
   * Optional because the microservice request handler may receive platform
   * probe calls (e.g. the Cumulocity MCP tool-discovery flow) that arrive
   * without a parseable tenant context. In that case no specs are set, and
   * the query/execute tools throw a clear error if they are invoked.
   */
  specs?: ResolvedSpecs
  /**
   * Tenant auth for the current connection.
   * Always set in server mode (per-request from the Authorization header).
   * May be absent in CLI mode until set-active-tenant is called.
   */
  auth?: RequestAuth
  /**
   * Path to the OPA data.json file for policy-based approval decisions.
   * CLI-only; set via --policy-data flag. When absent, all mutating ops
   * require elicitation (legacy behaviour).
   */
  policyDataPath?: string
}
