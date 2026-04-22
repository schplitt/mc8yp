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

  it('extracts repeated query parameters from server-relative MCP URLs', () => {
    expect(parseRestrictionQuery('/mcp?restriction=/inventory/**&restriction=DELETE:/alarm/**')).toEqual([
      { method: '*', pathPattern: '/inventory/**', source: '/inventory/**' },
      { method: 'DELETE', pathPattern: '/alarm/**', source: 'DELETE:/alarm/**' },
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

  it('matches absolute URLs using only the normalized pathname', () => {
    expect(evaluateRestrictions(rules, 'GET', 'https://tenant.example.com/inventory/managedObjects?pageSize=5')).toEqual({
      method: 'GET',
      path: '/inventory/managedObjects',
      matchingRules: [parseRestrictionRule('/inventory/**')],
    })
  })

  it('rejects unsupported HTTP methods', () => {
    expect(() => evaluateRestrictions(rules, 'MERGE', '/inventory/managedObjects')).toThrow('Unsupported HTTP method "MERGE".')
  })
})

describe('network permission decisions', () => {
  const tenantUrl = 'https://tenant.example.com'
  const rules = [parseRestrictionRule('/inventory/**')]

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