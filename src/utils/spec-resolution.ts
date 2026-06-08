import type { DiscoveredApiSpec } from './api-discovery'
import { BUNDLED_SERVICE_SPECS, CORE_SPEC } from './openapi'

/**
 * Flat spec map for the query sandbox.
 * `core` is always present. Every other key is a service contextPath — either a
 * bundled service spec, a live-discovered spec, or null (service known-but-absent
 * with spec removal enabled).
 *
 * Paths inside each spec value are already prefixed with the service route.
 * Bundled service specs are rewritten at build time; discovered specs are
 * rewritten in src/utils/api-discovery.ts.
 */
export type Specs = Record<string, unknown | null>

/**
 * Resolved view passed into the query sandbox.
 */
export interface ResolvedSpecs {
  /**
   * Spec values for sandbox bindings — `core` always present, others keyed by contextPath.
   */
  specs: Specs
  /**
   * Per known bundled service (plus core): is it actually installed on the
   * current tenant? Stays accurate even when --no-spec-removal keeps an absent
   * service's bundled spec visible for reference.
   */
  specsEnabled: Record<string, boolean>
}

/**
 * Resolve all specs for the current tenant by merging:
 *   - core (always),
 *   - bundled service specs (static seed, identical shape to discovery results),
 *   - live discovered specs (override bundled per contextPath; pass through if not bundled).
 *
 * Service-backed resolution per known bundled service:
 *   A. Live discovered → use live spec (live ⇒ installed).
 *   B. Installed but no live spec → use the bundled fallback.
 *   C. Not installed → null (specRemoval true) or bundled (specRemoval false, kept for reference).
 *
 * @param liveDiscovered          - DiscoveredApiSpec[] from the per-tenant discovery cache
 * @param installedContextPaths   - All subscribed app context paths on this tenant
 * @param specRemoval             - Whether to inject null for absent known services
 */
export function resolveSpecs(
  liveDiscovered: readonly DiscoveredApiSpec[],
  installedContextPaths: ReadonlySet<string>,
  specRemoval: boolean,
): ResolvedSpecs {
  const specs: Specs = { [CORE_SPEC.key]: CORE_SPEC.spec }
  const specsEnabled: Record<string, boolean> = { [CORE_SPEC.key]: true }

  const liveByContextPath = new Map(liveDiscovered.map((s) => [s.contextPath, s]))

  // Known bundled service specs — apply A / B / C
  for (const bundled of BUNDLED_SERVICE_SPECS) {
    const cp = bundled.contextPath
    const installed = installedContextPaths.has(cp)
    specsEnabled[cp] = installed

    const live = liveByContextPath.get(cp)
    if (live) {
      specs[cp] = live.spec // A
    } else if (installed) {
      specs[cp] = bundled.spec // B
    } else {
      specs[cp] = specRemoval ? null : bundled.spec // C
    }
  }

  // Non-bundled live-discovered services pass through unchanged
  const bundledContextPaths = new Set(BUNDLED_SERVICE_SPECS.map((s) => s.contextPath))
  for (const live of liveDiscovered) {
    if (!bundledContextPaths.has(live.contextPath)) {
      specs[live.contextPath] = live.spec
    }
  }

  return { specs, specsEnabled }
}
