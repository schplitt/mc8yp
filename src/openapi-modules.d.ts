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

  /**
   * Prebuilt embedding vectors for a core spec version (see
   * scripts/build-spec-vectors.ts). `ids[i]` is the chunk id of row `i` in the
   * base64-encoded row-major Float32 `embeddings` matrix; the runtime re-chunks
   * the inlined `spec` and zips these on by id. ALWAYS present for bundled core
   * versions — the build fails if a vector file is missing.
   */
  export interface SpecVectors {
    model: string
    dim: number
    dtype: string
    chunkerVersion: string
    ids: string[]
    embeddings: string
  }

  export interface CoreOpenApiEntry {
    version: string
    label: string
    spec: Spec
    vectors: SpecVectors
  }
  export const specs: ReadonlyArray<CoreOpenApiEntry>
  export function getCoreOpenApiSpec(): Spec
  export function getCoreOpenApiVersion(): string
  export function setCoreOpenApiVersion(version: string): void
  export function getCoreOpenApiLabel(): string
  export function getCoreOpenApiVectors(): SpecVectors
}
