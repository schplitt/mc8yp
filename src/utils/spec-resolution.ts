import { BUNDLED_SERVICE_SPECS } from '#bundled-services'
import { getCoreOpenApiSpec } from '#core-openapi'
import type { DiscoveredApiSpec } from './api-discovery'

interface OperationInfo {
  summary?: string
  description?: string
  tags?: string[]
  parameters?: Array<{ name: string, in: string, required?: boolean, schema?: unknown, description?: string }>
  requestBody?: { required?: boolean, content?: Record<string, { schema?: unknown }> }
  responses?: Record<string, { description?: string, content?: Record<string, { schema?: unknown }> }>
}

export interface PathItem {
  get?: OperationInfo
  post?: OperationInfo
  put?: OperationInfo
  patch?: OperationInfo
  delete?: OperationInfo
}
export interface Spec {
  paths: Record<string, PathItem>
  tags?: Array<{ name: string, description?: string }>
}

/**
 * Service-spec map keyed by Cumulocity contextPath.
 * A key is only present when the spec is actually usable (live discovery,
 * bundled fallback for installed services, or bundled when specRemoval is
 * disabled). An absent key means the spec is unavailable for this tenant.
 */
export type ServiceSpecs = Record<string, Spec>

/**
 * Everything the query sandbox needs in one object.
 * `core` is always populated from the bundled core OpenAPI snapshot.
 * `specs` carries bundled service specs (e.g. dtm) plus any non-bundled
 * services discovered live on the tenant.
 */
export interface ResolvedSpecs {
  core: Spec
  specs: ServiceSpecs
}

/**
 * Resolve every spec for the current tenant.
 *
 * For each bundled service spec (#bundled-services):
 *   - live discovery available           → use the live spec
 *   - service installed, no live spec    → use the bundled fallback
 *   - service not installed              → null (specRemoval) or bundled
 *
 * Non-bundled discovered services pass through as-is, keyed by contextPath.
 *
 * @param discoveredSpecs Result of live API discovery for the tenant.
 * @param installedContextPaths Subscribed app context paths on the tenant.
 * @param specRemoval When true, absent bundled services collapse to null.
 */
export function resolveSpecs(
  discoveredSpecs: readonly DiscoveredApiSpec[],
  installedContextPaths: ReadonlySet<string>,
  specRemoval: boolean,
): ResolvedSpecs {
  const specs: ServiceSpecs = {}
  const bundledContextPaths = new Set<string>()

  for (const bundled of BUNDLED_SERVICE_SPECS) {
    bundledContextPaths.add(bundled.contextPath)
    const live = discoveredSpecs.find((s) => s.contextPath === bundled.contextPath)
    if (live) {
      specs[bundled.contextPath] = live.spec
    } else if (installedContextPaths.has(bundled.contextPath)) {
      specs[bundled.contextPath] = bundled.spec
    } else if (!specRemoval) {
      specs[bundled.contextPath] = bundled.spec
    }
    // else: omit the key entirely — absence = unavailable.
  }

  for (const live of discoveredSpecs) {
    if (!bundledContextPaths.has(live.contextPath)) {
      specs[live.contextPath] = live.spec
    }
  }

  return { core: getCoreOpenApiSpec(), specs }
}
