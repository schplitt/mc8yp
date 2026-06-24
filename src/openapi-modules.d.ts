declare module '#bundled-services' {
  import type { Spec } from './utils/spec-resolution'

  export interface BundledServiceSpec {
    contextPath: string
    appLabel: string
    specLabel: string
    servicePrefix: string
    spec: Spec
  }
  export const BUNDLED_SERVICE_SPECS: ReadonlyArray<BundledServiceSpec>
}

/**
 * `import source from '<specifier>?bundle'` — the `?bundle` tsdown plugin
 * (see tsdown.config.ts) bundles `<specifier>` into a single ESM module and
 * inlines its source as a string. Handed to `@iso4/sandbox` as a source-string
 * import so sandbox code can `import X from '<name>'`.
 */
declare module '*?bundle' {
  const source: string
  export default source
}

declare module '#core-openapi' {
  import type { Spec } from './utils/spec-resolution'

  export interface CoreOpenApiEntry {
    version: string
    label: string
    spec: Spec
  }
  export const specs: ReadonlyArray<CoreOpenApiEntry>
  export function getCoreOpenApiSpec(): Spec
  export function getCoreOpenApiVersion(): string
  export function setCoreOpenApiVersion(version: string): void
  export function getCoreOpenApiLabel(): string
}
