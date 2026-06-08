import { getCoreOpenApiLabel, getCoreOpenApiSpec, getCoreOpenApiVersion } from '#core-openapi'
import { BUNDLED_SERVICE_SPECS } from '#bundled-services'
import type { RestrictionRule } from './restrictions'

// ---------------------------------------------------------------------------
// Core — the only spec with special handling (version-switchable, named binding)
// ---------------------------------------------------------------------------

/**
 * The bundled Cumulocity core OpenAPI spec for the currently selected version.
 * Always present in the query sandbox as `coreSpec`. Independent of tenant.
 */
export const CORE_SPEC = {
  key: 'core',
  version: getCoreOpenApiVersion(),
  label: getCoreOpenApiLabel(),
  spec: getCoreOpenApiSpec(),
} as const

// ---------------------------------------------------------------------------
// Bundled service specs — generic, identical shape to live discovery results
// ---------------------------------------------------------------------------

export { BUNDLED_SERVICE_SPECS }

/**
 * Per known bundled service: { contextPath, servicePrefix }.
 * Derived generically from the bundled list — used for auto-restriction rules
 * and for computing the `specsEnabled` map in the query sandbox.
 */
export const KNOWN_BUNDLED_SERVICES: ReadonlyArray<{ contextPath: string, servicePrefix: string }>
  = BUNDLED_SERVICE_SPECS.map((s) => ({ contextPath: s.contextPath, servicePrefix: s.servicePrefix }))

/**
 * Flat list of all bundled specs (core + service-backed) for display strings
 * in tool descriptions and logs. Not used for resolution logic.
 */
export const BUNDLED_OPENAPI_ENTRIES: ReadonlyArray<{ api: string, version: string, label: string }> = [
  { api: CORE_SPEC.key, version: CORE_SPEC.version, label: CORE_SPEC.label },
  ...BUNDLED_SERVICE_SPECS.map((s) => ({ api: s.contextPath, version: 'release', label: s.specLabel })),
]

// ---------------------------------------------------------------------------
// Auto-restriction helpers
// ---------------------------------------------------------------------------

/**
 * Generate deny rules that block all access to a service's routes.
 * Called when a known bundled service is not installed on the current tenant
 * so that execute calls fail with a clear policy message rather than a network
 * error or unexpected 404.
 *
 * @param unavailableContextPaths - Context paths confirmed absent on the tenant
 */
export function createServiceUnavailableRestrictionRules(
  unavailableContextPaths: readonly string[],
): RestrictionRule[] {
  return unavailableContextPaths.map((cp) => ({
    type: 'deny',
    method: '*',
    pathPattern: `/service/${cp}/**`,
    source: `*:/service/${cp}/**`,
  }))
}
