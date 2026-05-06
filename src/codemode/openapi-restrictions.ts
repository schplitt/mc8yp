import {
  RESTRICTED_AGENT_NOTE,
  RESTRICTED_OPERATION_FLAG,
  RESTRICTED_OPERATION_MESSAGE,
  RESTRICTED_OPERATION_RULES,
  RESTRICTED_OPERATION_TYPE,
  RESTRICTION_EXTENSION_KEY,
} from '../utils/restrictions'
import {
  compileRestrictionRule,
  evaluateAccessPolicy,
  matchesCompiledRule,
} from '../utils/restriction-matcher'
import type { AllowRule, RestrictionRule } from '../utils/restrictions'

const OPENAPI_OPERATION_METHODS = ['delete', 'get', 'head', 'options', 'patch', 'post', 'put', 'trace'] as const

type OpenApiOperation = Record<string, unknown>
type OpenApiPathItem = Record<string, unknown>
type OpenApiPaths = Record<string, OpenApiPathItem>
type OpenApiSpec = Record<string, unknown> & { paths?: OpenApiPaths }

function annotateBlockedOperation(operation: OpenApiOperation, ruleSources: readonly string[]): OpenApiOperation {
  return {
    ...operation,
    [RESTRICTED_OPERATION_FLAG]: true,
    [RESTRICTED_OPERATION_TYPE]: 'deny',
    [RESTRICTED_OPERATION_RULES]: [...ruleSources],
    [RESTRICTED_OPERATION_MESSAGE]: 'This operation is blocked by the current MCP connection policy.',
    [RESTRICTED_AGENT_NOTE]: 'The route exists, but it is intentionally unavailable for this MCP connection.',
  }
}

export function applyRestrictionsToOpenApiSpec<TSpec extends OpenApiSpec>(
  spec: TSpec,
  restrictions: readonly RestrictionRule[],
  allowRules: readonly AllowRule[] = [],
): TSpec {
  if (!spec.paths || (restrictions.length === 0 && allowRules.length === 0)) {
    return spec
  }

  const compiledRestrictions = restrictions.map(compileRestrictionRule)
  const compiledAllowRules = allowRules.map(compileRestrictionRule)
  let nextPaths: OpenApiPaths | undefined

  for (const [path, pathItem] of Object.entries(spec.paths)) {
    let nextPathItem: OpenApiPathItem | undefined
    const pathSegments = path === '/' ? [] : path.slice(1).split('/')

    for (const method of OPENAPI_OPERATION_METHODS) {
      const operation = pathItem[method]
      if (!operation || typeof operation !== 'object') {
        continue
      }

      const decision = evaluateAccessPolicy(restrictions, allowRules, method.toUpperCase(), path)
      if (!decision.blocked) {
        continue
      }

      const restrictionMatches = compiledRestrictions.filter((rule) => matchesCompiledRule(rule, method.toUpperCase(), pathSegments))
      const allowMatches = compiledAllowRules.filter((rule) => matchesCompiledRule(rule, method.toUpperCase(), pathSegments))
      const ruleSources = decision.blockedBy === 'restriction'
        ? (restrictionMatches.length > 0 ? restrictionMatches : decision.matchingRestrictions).map((rule) => rule.source)
        : (allowMatches.length > 0 ? allowMatches : allowRules).map((rule) => rule.source)

      nextPathItem ??= { ...pathItem }
      nextPathItem[method] = annotateBlockedOperation(operation as OpenApiOperation, ruleSources)
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
      restrictions: restrictions.map((rule) => rule.source),
      allowed: allowRules.map((rule) => rule.source),
      message: 'Operations marked with x-mc8yp-restricted are intentionally blocked for the current MCP connection.',
    },
  } as TSpec
}
