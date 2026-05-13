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

declare module '#dtm-openapi' {
  export interface DtmOpenApiEntry {
    version: string
    label: string
    spec: unknown
  }
  export const specs: ReadonlyArray<DtmOpenApiEntry>
  export function getDtmOpenApiSpec(): unknown
  export function getDtmOpenApiVersion(): string
  export function setDtmOpenApiVersion(version: string): void
  export function getDtmOpenApiLabel(): string
}
