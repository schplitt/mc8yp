import { describe, expect, it } from 'vitest'
import {
  createNetworkPermissionDecision,
  evaluateRestrictions,
  parseRestrictionQuery,
  parseRestrictionRule,
} from '../src/utils/restrictions'

describe('restriction parsing', () => {
  it('parses methodless restrictions as all-method deny rules', () => {
    expect(parseRestrictionRule('/inventory/**')).toEqual({
      method: '*',
      pathPattern: '/inventory/**',
      source: '/inventory/**',
    })
  })

  it('parses method-scoped restrictions', () => {
    expect(parseRestrictionRule('get:/inventory/**')).toEqual({
      method: 'GET',
      pathPattern: '/inventory/**',
      source: 'get:/inventory/**',
    })
  })

  it('extracts repeated query parameters', () => {
    expect(parseRestrictionQuery('https://example.test/mcp?restriction=/inventory/**&restriction=POST:/alarm/**')).toEqual([
      { method: '*', pathPattern: '/inventory/**', source: '/inventory/**' },
      { method: 'POST', pathPattern: '/alarm/**', source: 'POST:/alarm/**' },
    ])
  })
})

describe('restriction matching', () => {
  const rules = [
    parseRestrictionRule('/inventory/**'),
    parseRestrictionRule('POST:/alarm/**'),
  ]

  it('blocks every method when no method prefix is provided', () => {
    const evaluation = evaluateRestrictions(rules, 'GET', '/inventory/managedObjects?pageSize=5')
    expect(evaluation.matchingRules.map((rule) => rule.source)).toEqual(['/inventory/**'])
  })

  it('keeps method-specific rules scoped to that method', () => {
    expect(evaluateRestrictions(rules, 'GET', '/alarm/alarms').matchingRules).toEqual([])
    expect(evaluateRestrictions(rules, 'POST', '/alarm/alarms').matchingRules.map((rule) => rule.source)).toEqual(['POST:/alarm/**'])
  })

  it('reports the normalized method, path, and matching rules', () => {
    expect(evaluateRestrictions(rules, 'DELETE', '/inventory/managedObjects/123')).toEqual({
      method: 'DELETE',
      path: '/inventory/managedObjects/123',
      matchingRules: [parseRestrictionRule('/inventory/**')],
    })
  })
})

describe('network permission decisions', () => {
  const tenantUrl = 'https://tenant.example.com'

  it('rejects fetch requests', () => {
    expect(createNetworkPermissionDecision(tenantUrl, {
      op: 'fetch',
      method: 'GET',
      url: 'https://tenant.example.com/inventory/managedObjects',
    })).toEqual({
      allow: false,
      reason: 'Unsupported network operation "fetch". Only "connect" is allowed.',
    })
  })

  it('allows connects to the configured tenant host', () => {
    expect(createNetworkPermissionDecision(tenantUrl, {
      op: 'connect',
      hostname: 'tenant.example.com',
    })).toEqual({
      allow: true,
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