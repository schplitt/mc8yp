import { describe, expect, it } from 'vitest'
import {
  createNetworkPermissionDecision,
  parseRestrictionRule,
} from '../src/utils/restrictions'

describe('network permission decisions', () => {
  const tenantUrl = 'https://tenant.example.com'
  const rules = parseRestrictionRule('/inventory/**').parsedRules

  it('allows connect requests to the configured tenant host when no method is available', () => {
    expect(createNetworkPermissionDecision(tenantUrl, {
      op: 'connect',
      hostname: 'tenant.example.com',
    }, rules)).toEqual({
      allow: true,
    })
  })

  it('keeps method-aware restriction blocking available when request metadata includes method and url', () => {
    expect(createNetworkPermissionDecision(tenantUrl, {
      op: 'connect',
      hostname: 'tenant.example.com',
      method: 'GET',
      url: 'https://tenant.example.com/inventory/managedObjects?pageSize=5',
    }, rules)).toEqual({
      allow: false,
      reason: 'Network connect blocked by MCP restrictions: /inventory/**',
    })
  })

  it('includes all matching restriction rules in the blocked reason', () => {
    expect(createNetworkPermissionDecision(tenantUrl, {
      op: 'connect',
      hostname: 'tenant.example.com',
      method: 'GET',
      url: 'https://tenant.example.com/inventory/managedObjects?pageSize=5',
    }, [
      parseRestrictionRule('/inventory/**').parsedRules[0],
      parseRestrictionRule('GET:/inventory/**').parsedRules[0],
    ])).toEqual({
      allow: false,
      reason: 'Network connect blocked by MCP restrictions: /inventory/**, GET:/inventory/**',
    })
  })

  it('blocks connects to other hosts', () => {
    expect(createNetworkPermissionDecision(tenantUrl, {
      op: 'connect',
      hostname: 'other.example.com',
    })).toEqual({
      allow: false,
      reason: 'Network connect blocked: only tenant.example.com is allowed in execute mode.',
    })
  })

  it('rejects disallowed network operations', () => {
    expect(createNetworkPermissionDecision(tenantUrl, {
      op: 'dns',
      hostname: 'other.example.com',
    })).toEqual({
      allow: false,
      reason: 'Unsupported network operation "dns". Only "connect" is allowed.',
    })
  })
})
