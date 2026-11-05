declare module '#core-openapi' {
  import type { Spec } from './utils/capability-resolution'

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
