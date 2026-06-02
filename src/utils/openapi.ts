import { getCoreOpenApiLabel, getCoreOpenApiSpec, getCoreOpenApiVersion } from '#core-openapi'

export const BUNDLED_OPENAPI_ENTRIES = [
  {
    api: 'core',
    version: getCoreOpenApiVersion(),
    label: getCoreOpenApiLabel(),
    spec: getCoreOpenApiSpec(),
  },
] as const

export const BUNDLED_OPENAPI_SPECS = Object.freeze({
  core: BUNDLED_OPENAPI_ENTRIES[0].spec,
})
