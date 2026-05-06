import type { createNodeDriver } from 'secure-exec'
import { findBlockingRestrictions } from '../utils/restriction-matcher'
import type { RestrictionRule } from '../utils/restrictions'

type NetworkPermissionDecider = NonNullable<NonNullable<NonNullable<Parameters<typeof createNodeDriver>[0]>['permissions']>['network']>

type NetworkPermissionRequest = Parameters<NetworkPermissionDecider>[0]

type NetworkPermissionDecision = ReturnType<NetworkPermissionDecider>

export function createNetworkPermissionDecision(
  tenantUrl: string,
  request: NetworkPermissionRequest,
  rules: readonly RestrictionRule[] = [],
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
    const requestMethod = typeof request.method === 'string' ? request.method.trim() : undefined
    const blockingRules = findBlockingRestrictions(rules, requestMethod, new URL(request.url).pathname)
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
