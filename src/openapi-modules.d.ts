declare module '#core-openapi' {
  export interface CoreOpenApiEntry {
    version: string
    label: string
    spec: unknown
  }
  export const specs: ReadonlyArray<CoreOpenApiEntry>
  export function getCoreOpenApiSpec(): unknown
  export function getCoreOpenApiVersion(): string
  export function setCoreOpenApiVersion(version: string): void
  export function getCoreOpenApiLabel(): string
}

declare module '#bundled-services' {
  import type { DiscoveredApiSpec } from './utils/api-discovery'
  /**
   * Statically bundled service specs in the same shape produced by live
   * discovery (paths already prefixed with servicePrefix at build time).
   * Live discovery overrides any entry whose contextPath matches a discovered
   * spec on the current tenant.
   */
  export const BUNDLED_SERVICE_SPECS: ReadonlyArray<DiscoveredApiSpec>
}
