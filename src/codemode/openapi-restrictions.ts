import {
  RESTRICTED_AGENT_NOTE,
  RESTRICTED_OPERATION_FLAG,
  RESTRICTED_OPERATION_MESSAGE,
  RESTRICTED_OPERATION_RULES,
  RESTRICTED_OPERATION_TYPE,
  RESTRICTION_EXTENSION_KEY,
  compileRestrictionRule,
  matchesCompiledRule,
  type RestrictionRule,
} from '../utils/restrictions'

const OPENAPI_OPERATION_METHODS = ['delete', 'get', 'head', 'options', 'patch', 'post', 'put', 'trace'] as const

type OpenApiOperation = Record<string, unknown>
type OpenApiPathItem = Record<string, unknown>
type OpenApiPaths = Record<string, OpenApiPathItem>
type OpenApiSpec = Record<string, unknown> & { paths?: OpenApiPaths }

function annotateRestrictedOperation(operation: OpenApiOperation, matchingRules: readonly RestrictionRule[]): OpenApiOperation {
  return {
    ...operation,
    [RESTRICTED_OPERATION_FLAG]: true,
    [RESTRICTED_OPERATION_TYPE]: 'deny',
    [RESTRICTED_OPERATION_RULES]: matchingRules.map((rule) => rule.source),
    [RESTRICTED_OPERATION_MESSAGE]: 'This operation is blocked by the current MCP connection restrictions.',
    [RESTRICTED_AGENT_NOTE]: 'The route exists, but it is intentionally restricted for this MCP connection.',
  }
}

export function applyRestrictionsToOpenApiSpec<TSpec extends OpenApiSpec>(spec: TSpec, rules: readonly RestrictionRule[]): TSpec {
  if (!spec.paths || rules.length === 0) {
    return spec
  }

  const compiledRules = rules.map(compileRestrictionRule)
  let nextPaths: OpenApiPaths | undefined

  for (const [path, pathItem] of Object.entries(spec.paths)) {
    let nextPathItem: OpenApiPathItem | undefined
    const pathSegments = path === '/' ? [] : path.slice(1).split('/')

    for (const method of OPENAPI_OPERATION_METHODS) {
      const operation = pathItem[method]
      if (!operation || typeof operation !== 'object') {
        continue
      }

      const matchingRules = compiledRules.filter((rule) => matchesCompiledRule(rule, method.toUpperCase(), pathSegments))
      if (matchingRules.length === 0) {
        continue
      }

      nextPathItem ??= { ...pathItem }
      nextPathItem[method] = annotateRestrictedOperation(operation as OpenApiOperation, matchingRules)
    }

    if (nextPathItem) {
      nextPaths ??= { ...spec.paths }
      nextPaths[path] = nextPathItem
    }
  }

  return {
    ...spec,
    paths: nextPaths ?? spec.paths,
    [RESTRICTION_EXTENSION_KEY]: {
      mode: 'deny',
      rules: rules.map((rule) => rule.source),
      message: 'Operations marked with x-mc8yp-restricted are intentionally blocked for the current MCP connection.',
    },
  } as TSpec
}