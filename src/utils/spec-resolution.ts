import type { DiscoveredApiSpec } from './api-discovery'
import { BUNDLED_SPEC_REGISTRY } from './openapi'

/**
 * Flat map of all specs available for the query sandbox — bundled and
 * discovered services in one object, keyed by the name used as the sandbox
 * binding (e.g. "core" → coreSpec, "myservice" → serviceSpecs entry).
 *
 * A null value means the service is not installed on this tenant and
 * specRemoval is enabled. The binding is still injected so the agent can
 * check specsEnabled before attempting to use it.
 *
 * Path rewriting guarantee: all spec values have their paths already
 * prefixed with the service route before being placed in this map.
 * Bundled service specs are rewritten at build time (tsdown.config.ts).
 * Discovered specs are rewritten in discoverApiSpecs before caching.
 */
export type Specs = Record<string, unknown | null>

/**
 * Resolve all specs for the current tenant into a single flat map.
 *
 * Bundled registry entries (see BUNDLED_SPEC_REGISTRY in openapi.ts):
 *   - No contextPath (core): always included.
 *   - With contextPath (service-backed, e.g. dtm once added):
 *     A. Service installed + live OpenAPI spec URL → use discovered spec
 *     B. Service installed + no spec URL in manifest → bundled spec fallback
 *     C. Service not installed → null (specRemoval true) or bundled (false)
 *
 * Non-bundled discovered services are added as-is, keyed by their contextPath.
 * @param discoveredSpecs
 * @param installedContextPaths
 * @param specRemoval
 */
export function resolveSpecs(
  discoveredSpecs: readonly DiscoveredApiSpec[],
  installedContextPaths: ReadonlySet<string>,
  specRemoval: boolean,
): Specs {
  const result: Specs = {}

  // Bundled registry entries
  for (const entry of BUNDLED_SPEC_REGISTRY) {
    const contextPath = 'contextPath' in entry ? entry.contextPath : undefined

    if (contextPath == null) {
      result[entry.key] = entry.spec
      continue
    }

    const discovered = discoveredSpecs.find((s) => s.contextPath === contextPath)
    const installed = installedContextPaths.has(contextPath)

    if (discovered) {
      result[entry.key] = discovered.spec // A: live spec
    } else if (installed) {
      result[entry.key] = entry.spec // B: installed, use bundled fallback
    } else {
      result[entry.key] = specRemoval ? null : entry.spec // C
    }
  }

  // Non-bundled discovered services
  const knownContextPaths = new Set(
    BUNDLED_SPEC_REGISTRY
      .filter((e): e is (typeof e & { contextPath: string }) => 'contextPath' in e && e.contextPath != null)
      .map((e) => e.contextPath),
  )
  for (const ds of discoveredSpecs) {
    if (!knownContextPaths.has(ds.contextPath)) {
      result[ds.contextPath] = ds.spec
    }
  }

  return result
}
