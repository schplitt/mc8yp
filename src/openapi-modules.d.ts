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
