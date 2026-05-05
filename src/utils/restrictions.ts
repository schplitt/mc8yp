import type { createNodeDriver } from 'secure-exec'
import {
  HTTP_METHODS,
  findBlockingRestrictions,
  parseRestrictionRule,
} from './restriction-core'
import type { RestrictionMethod, RestrictionRule } from './restriction-core'

export const RESTRICTION_EXTENSION_KEY = 'x-mc8yp-restrictions'
export const RESTRICTED_OPERATION_FLAG = 'x-mc8yp-restricted'
export const RESTRICTED_OPERATION_MESSAGE = 'x-mc8yp-restrictionMessage'
export const RESTRICTED_OPERATION_TYPE = 'x-mc8yp-restrictionType'
export const RESTRICTED_AGENT_NOTE = 'x-mc8yp-agentNote'

export {
  HTTP_METHODS,
  findBlockingRestrictions,
  parseRestrictionRule,
  type RestrictionMethod,
  type RestrictionRule,
}

type NetworkPermissionDecider = NonNullable<NonNullable<NonNullable<Parameters<typeof createNodeDriver>[0]>['permissions']>['network']>

type NetworkPermissionRequest = Parameters<NetworkPermissionDecider>[0]

type NetworkPermissionDecision = ReturnType<NetworkPermissionDecider>

export function createNetworkPermissionDecision(tenantUrl: string, request: NetworkPermissionRequest, rules: readonly RestrictionRule[] = []): NetworkPermissionDecision {
  const tenantHostname = new URL(tenantUrl).hostname

  if (request.op !== 'connect') {
    return { allow: false, reason: `Unsupported network operation "${request.op}". Only "connect" is allowed.` }
  }

  if (request.hostname !== tenantHostname) {
    return {
      allow: false,
      reason: `Network connect blocked: only ${tenantHostname} is allowed in execute mode.`,
    }
  }

  if (typeof request.method === 'string') {
    const requestPath = typeof request.url === 'string'
      ? new URL(request.url).pathname
      : '/'
    const blockingRules = findBlockingRestrictions(rules, request.method, requestPath)
    if (blockingRules.length > 0) {
      return {
        allow: false,
        reason: `Network connect blocked by MCP restrictions: ${blockingRules.map((rule) => rule.source).join(', ')}`,
      }
    }
  }

  return {
    allow: true,
  }
}
