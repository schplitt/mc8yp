import { getCoreOpenApiLabel, getCoreOpenApiSpec, getCoreOpenApiVersion } from '#core-openapi'
import { getDtmOpenApiLabel, getDtmOpenApiSpec, getDtmOpenApiVersion } from '#dtm-openapi'
import type { RestrictionRule } from './restrictions'

const HTTP_METHODS = ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT', 'TRACE'] as const
export const OPENAPI_PARTS = ['core', 'dtm'] as const

interface BundledOpenApiOperation {
  api: string
  method: string
  pathPattern: string
}

export const BUNDLED_OPENAPI_ENTRIES = [
  {
    api: 'core',
    version: getCoreOpenApiVersion(),
    label: getCoreOpenApiLabel(),
    spec: getCoreOpenApiSpec(),
  },
  {
    api: 'dtm',
    version: getDtmOpenApiVersion(),
    label: getDtmOpenApiLabel(),
    spec: getDtmOpenApiSpec(),
  },
] as const

export const BUNDLED_OPENAPI_SPECS = Object.freeze({
  core: BUNDLED_OPENAPI_ENTRIES[0].spec,
  dtm: BUNDLED_OPENAPI_ENTRIES[1].spec,
})

export const BUNDLED_OPENAPI_OPERATIONS: BundledOpenApiOperation[] = BUNDLED_OPENAPI_ENTRIES.flatMap((entry) => {
  const spec = entry.spec as { paths?: Record<string, Record<string, unknown>> } | null
  if (!spec?.paths || typeof spec.paths !== 'object') {
    return []
  }

  return Object.entries(spec.paths).flatMap(([path, pathItem]) => {
    if (!pathItem || typeof pathItem !== 'object') {
      return []
    }

    const pathPattern = path === '/'
      ? '/'
      : `/${path.slice(1).split('/').map((segment) => segment.startsWith('{') && segment.endsWith('}') ? '*' : segment).join('/')}`

    return HTTP_METHODS.flatMap((method) => {
      if (!(method.toLowerCase() in pathItem)) {
        return []
      }

      return [{
        api: entry.api,
        method,
        pathPattern,
      }]
    })
  })
})

export function createOpenApiPartRestrictionRules(disabledApis: readonly string[] = []): RestrictionRule[] {
  return BUNDLED_OPENAPI_OPERATIONS.filter((operation) => disabledApis.includes(operation.api)).map((operation) => ({
    type: 'deny',
    method: operation.method as RestrictionRule['method'],
    pathPattern: operation.pathPattern,
    source: `${operation.method}:${operation.pathPattern}`,
  }))
}
