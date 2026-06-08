import { getCoreOpenApiLabel, getCoreOpenApiSpec, getCoreOpenApiVersion } from '#core-openapi'
import type { RestrictionRule } from './restrictions'

// ---------------------------------------------------------------------------
// Bundled spec registry
// ---------------------------------------------------------------------------

/**
 * A spec that is always available regardless of tenant (e.g. core).
 * No contextPath means no service-availability check is needed.
 */
interface AlwaysAvailableSpec {
  readonly key: string
  readonly version: string
  readonly label: string
  readonly spec: unknown
  readonly contextPath?: undefined
  readonly servicePrefix?: undefined
}

/**
 * A spec backed by a Cumulocity microservice.
 * Discovery checks whether the service is installed on the current tenant.
 */
interface ServiceBackedSpec {
  readonly key: string
  readonly version: string
  readonly label: string
  readonly spec: unknown
  readonly contextPath: string
  readonly servicePrefix: string
}

export type BundledSpec = AlwaysAvailableSpec | ServiceBackedSpec

/**
 * Single source of truth for all bundled OpenAPI specs.
 *
 * - Entries without contextPath are always injected into the query sandbox.
 * - Entries with contextPath are resolved against live discovery results
 *   (see resolveAvailableSpecs in spec-resolution.ts).
 *
 * To add a new bundled spec: import its virtual-module helpers, add one entry
 * here with the appropriate contextPath/servicePrefix, and wire the virtual
 * module into tsdown.config.ts and openapi-modules.d.ts.
 */
export const BUNDLED_SPEC_REGISTRY: readonly BundledSpec[] = [
  {
    key: 'core',
    version: getCoreOpenApiVersion(),
    label: getCoreOpenApiLabel(),
    spec: getCoreOpenApiSpec(),
    // No contextPath — core is always available on every tenant.
  },
]

// ---------------------------------------------------------------------------
// Derived helpers
// ---------------------------------------------------------------------------

/**
 * Service-backed entries from the registry, keyed by spec key.
 * Used to generate auto-restriction rules and filter serviceSpecs.
 */
export const KNOWN_BUNDLED_SERVICES: Record<string, { contextPath: string, servicePrefix: string }>
  = Object.fromEntries(
    BUNDLED_SPEC_REGISTRY
      .filter((e): e is ServiceBackedSpec => e.contextPath != null)
      .map((e) => [e.key, { contextPath: e.contextPath, servicePrefix: e.servicePrefix }]),
  )

/**
 * Flat entries for display strings (tool descriptions, logs).
 */
export const BUNDLED_OPENAPI_ENTRIES = BUNDLED_SPEC_REGISTRY.map((e) => ({
  api: e.key,
  version: e.version,
  label: e.label,
}))

// ---------------------------------------------------------------------------
// Auto-restriction helpers
// ---------------------------------------------------------------------------

/**
 * Generate deny rules that block all access to a service's routes.
 * Called when a known bundled service is not installed on the current tenant
 * so that execute calls fail with a clear policy message rather than a
 * network error or unexpected 404.
 *
 * @param unavailableContextPaths - Context paths of services confirmed absent on the tenant
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
