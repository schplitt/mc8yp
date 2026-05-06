import type { createNodeDriver } from 'secure-exec'
import { evaluateAccessPolicy, findBlockingRestrictions } from '../utils/restriction-matcher'
import type { AllowRule, RestrictionRule } from '../utils/restrictions'

type NetworkPermissionDecider = NonNullable<NonNullable<NonNullable<Parameters<typeof createNodeDriver>[0]>['permissions']>['network']>

type NetworkPermissionRequest = Parameters<NetworkPermissionDecider>[0]

type NetworkPermissionDecision = ReturnType<NetworkPermissionDecider>

export function createNetworkPermissionDecision(
  tenantUrl: string,
  request: NetworkPermissionRequest,
  restrictions: readonly RestrictionRule[] = [],
  allowRules: readonly AllowRule[] = [],
): NetworkPermissionDecision {
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

  if (typeof request.url === 'string') {
    const pathname = new URL(request.url).pathname
    const requestMethod = typeof request.method === 'string' ? request.method.trim() : undefined
    const normalizedMethod = requestMethod?.toUpperCase() ?? ''

    if (normalizedMethod) {
      const decision = evaluateAccessPolicy(restrictions, allowRules, normalizedMethod, pathname)
      if (decision.blocked) {
        if (decision.blockedBy === 'restriction') {
          return {
            allow: false,
            reason: `Network connect blocked by MCP restrictions: ${decision.matchingRestrictions.map((rule) => rule.source).join(', ')}`,
          }
        }

        return {
          allow: false,
          reason: `Network connect blocked by MCP allow list: no allow rule matched ${normalizedMethod} ${pathname}. Configured allow rules: ${allowRules.map((rule) => rule.source).join(', ')}`,
        }
      }
    } else {
      const blockingRules = findBlockingRestrictions(restrictions, requestMethod, pathname)
      if (blockingRules.length > 0) {
        return {
          allow: false,
          reason: `Network connect blocked by MCP restrictions: ${blockingRules.map((rule) => rule.source).join(', ')}`,
        }
      }
    }
  }

  return {
    allow: true,
  }
}
