/* eslint-disable no-template-curly-in-string */
import { matchesGlob } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  findBlockingRestrictions,
  parseRestrictionRule,
} from '../src/utils/restriction-core'

const INVALID_RESTRICTION_PAYLOADS = [
  '/inventory/managedObjects");globalThis.pwned=true;("',
  '/inventory/${globalThis.pwned=true}',
  '/inventory/managedObjects`);globalThis.pwned=true;//',
  '/inventory/*/..//*/**',
  '/inventory/managedObjects*/globalThis.pwned=true',
  '/inventory/managedObjects\u2028globalThis.pwned=true',
  '/inventory/managedObjects\u2029globalThis.pwned=true',
  'GET:/inventory/managedObjects");globalThis.pwned=true;("',
  'POST:/inventory/${globalThis.pwned=true}',
  '/inventory/managedObjects?x=1',
  '/inventory/managedObjects#frag',
  'BAD:/inventory/managedObjects',
  'GET:inventory/managedObjects',
  '/inventory//managedObjects/',
] as const

const MATCH_CASES = [
  {
    description: 'single-segment wildcard matches an inventory resource name prefix',
    rule: '/inventory/m*',
    method: 'GET',
    path: '/inventory/managedObjects',
    expected: true,
  },
  {
    description: 'single-segment wildcard also matches other inventory names in the same segment',
    rule: '/inventory/m*',
    method: 'POST',
    path: '/inventory/measurements',
    expected: true,
  },
  {
    description: 'single-segment wildcard does not match a different segment prefix',
    rule: '/inventory/m*',
    method: 'GET',
    path: '/inventory/events',
    expected: false,
  },
  {
    description: 'single-segment wildcard does not match deeper descendants on its own',
    rule: '/inventory/m*',
    method: 'GET',
    path: '/inventory/managedObjects/123',
    expected: false,
  },
  {
    description: 'recursive wildcard extends a prefixed segment match to descendants',
    rule: '/inventory/m*/**',
    method: 'GET',
    path: '/inventory/managedObjects/123',
    expected: true,
  },
  {
    description: 'recursive wildcard still keeps the prefixed segment constraint',
    rule: '/inventory/m*/**',
    method: 'GET',
    path: '/inventory/events/123',
    expected: false,
  },
  {
    description: 'methodless recursive wildcard does not match the top-level inventory path without a trailing segment',
    rule: '/inventory/**',
    method: 'DELETE',
    path: '/inventory',
    expected: false,
  },
  {
    description: 'method-specific rules only match the configured method',
    rule: 'GET:/inventory/m*',
    method: 'POST',
    path: '/inventory/managedObjects',
    expected: false,
  },
  {
    description: 'double-star can match zero intermediate segments',
    rule: '/inventory/**/child',
    method: 'GET',
    path: '/inventory/child',
    expected: true,
  },
  {
    description: 'double-star can match multiple intermediate segments',
    rule: '/inventory/**/child',
    method: 'GET',
    path: '/inventory/device-1/nested/child',
    expected: true,
  },
  {
    description: 'double-star still requires the trailing segment to match',
    rule: '/inventory/**/child',
    method: 'GET',
    path: '/inventory/device-1/nested/sibling',
    expected: false,
  },
  {
    description: 'literal dots are matched literally within a path segment',
    rule: '/inventory/device.1',
    method: 'GET',
    path: '/inventory/device.1',
    expected: true,
  },
  {
    description: 'literal dots do not behave like regex wildcards',
    rule: '/inventory/device.1',
    method: 'GET',
    path: '/inventory/deviceX1',
    expected: false,
  },
  {
    description: 'root restriction matches the normalized root path',
    rule: '/',
    method: 'GET',
    path: '/',
    expected: true,
  },
  {
    description: 'root restriction does not match non-root paths',
    rule: '/',
    method: 'GET',
    path: '/inventory',
    expected: false,
  },
] as const

const BLOCKED_RULE_CASES = [
  {
    description: 'returns the first matching rule in source order',
    rules: ['GET:/inventory/m*', '/inventory/m*/**', '/**/status'],
    method: 'GET',
    path: '/inventory/managedObjects/status',
    expected: '/inventory/m*/**',
  },
  {
    description: 'keeps method-specific rules scoped while stopping at the first methodless recursive match',
    rules: ['GET:/inventory/m*', 'POST:/inventory/**', '/inventory/m*/**'],
    method: 'POST',
    path: '/inventory/managedObjects/123',
    expected: 'POST:/inventory/**',
  },
  {
    description: 'returns undefined when only a single-segment wildcard would have matched the parent resource',
    rules: ['/inventory/m*', 'GET:/alarm/**'],
    method: 'GET',
    path: '/inventory/managedObjects/123',
    expected: undefined,
  },
] as const

describe('restriction core helpers', () => {
  it('parses valid restriction paths without rewriting them', () => {
    expect(parseRestrictionRule('get:/inventory/*/child')).toEqual({
      parsedRules: [{
        method: 'GET',
        pathPattern: '/inventory/*/child',
        source: 'get:/inventory/*/child',
      }],
      failedRules: [],
    })
    expect(parseRestrictionRule('/inventory/managedObjects*/**/evil')).toEqual({
      parsedRules: [{
        method: '*',
        pathPattern: '/inventory/managedObjects*/**/evil',
        source: '/inventory/managedObjects*/**/evil',
      }],
      failedRules: [],
    })
    expect(parseRestrictionRule('/inventory**')).toEqual({
      parsedRules: [{
        method: '*',
        pathPattern: '/inventory**',
        source: '/inventory**',
      }],
      failedRules: [],
    })
  })

  it('accepts explicit wildcard method prefixes', () => {
    expect(parseRestrictionRule('*:/inventory/**')).toEqual({
      parsedRules: [{
        method: '*',
        pathPattern: '/inventory/**',
        source: '*:/inventory/**',
      }],
      failedRules: [],
    })
  })

  it.each(INVALID_RESTRICTION_PAYLOADS)('collects invalid restriction payload: %s', (payload) => {
    expect(parseRestrictionRule(payload)).toEqual({
      parsedRules: [],
      failedRules: [{
        rule: payload,
        reason: expect.any(String),
      }],
    })
  })

  it('uses Node.js path.matchesGlob semantics directly', () => {
    expect(matchesGlob('/inventory/managedObjects', '/inventory/m*')).toBe(true)
    expect(matchesGlob('/inventory/events', '/inventory/m*')).toBe(false)
    expect(matchesGlob('/inventory/managedObjects/123', '/inventory/**')).toBe(true)
    expect(matchesGlob('/inventory', '/inventory/**')).toBe(false)
    expect(matchesGlob('/inventory', '/inventory**')).toBe(true)
    expect(matchesGlob('/inventory/managedObjects', '/inventory**')).toBe(false)
    expect(matchesGlob('/inventory/child', '/inventory/**/child')).toBe(true)
  })

  it('matches exact-path and descendant-path rules separately under standard glob semantics', () => {
    const { parsedRules: rules } = parseRestrictionRule([
      '/inventory',
      '/inventory/**',
    ])

    expect(findBlockingRestrictions(rules, 'GET', '/inventory')[0]?.source).toBe('/inventory')
    expect(findBlockingRestrictions(rules, 'GET', '/inventory/managedObjects')[0]?.source).toBe('/inventory/**')
  })

  it('matches wildcard rules using Node.js path.matchesGlob semantics', () => {
    const rule = parseRestrictionRule('GET:/inventory/*/child').parsedRules[0]
    expect(findBlockingRestrictions([rule], 'GET', '/inventory/device-1/child')[0]).toBeDefined()
    expect(findBlockingRestrictions([rule], 'POST', '/inventory/device-1/child')[0]).toBeUndefined()
    expect(findBlockingRestrictions([rule], 'GET', '/inventory/device-1/sibling')[0]).toBeUndefined()
  })

  it('finds the first blocked restriction rule', () => {
    const { parsedRules: rules } = parseRestrictionRule([
      'GET:/inventory/**',
      '/alarm/*',
    ])

    expect(findBlockingRestrictions(rules, 'GET', '/inventory/managedObjects/123')[0]?.source).toBe('GET:/inventory/**')
    expect(findBlockingRestrictions(rules, 'POST', '/alarm/alarms')[0]?.source).toBe('/alarm/*')
    expect(findBlockingRestrictions(rules, 'POST', '/event/events')[0]).toBeUndefined()
  })

  it.each(MATCH_CASES)('$description', ({ rule, method, path, expected }) => {
    const result = findBlockingRestrictions(parseRestrictionRule(rule).parsedRules, method, path)[0]
    expect(result !== undefined).toBe(expected)
  })

  it.each(BLOCKED_RULE_CASES)('$description', ({ rules, method, path, expected }) => {
    const { parsedRules } = parseRestrictionRule(rules)
    expect(findBlockingRestrictions(parsedRules, method, path)[0]?.source).toBe(expected)
  })

  it('returns valid and invalid restriction parse results without throwing', () => {
    expect(parseRestrictionRule([
      '/inventory/**',
      'BAD:/alarm/**',
      'POST:/event/events',
    ])).toEqual({
      parsedRules: [
        {
          method: '*',
          pathPattern: '/inventory/**',
          source: '/inventory/**',
        },
        {
          method: 'POST',
          pathPattern: '/event/events',
          source: 'POST:/event/events',
        },
      ],
      failedRules: [
        {
          rule: 'BAD:/alarm/**',
          reason: 'Unsupported restriction method "BAD".',
        },
      ],
    })
  })
})
