/* eslint-disable no-template-curly-in-string */
import { describe, expect, it } from 'vitest'
import {
  findBlockedRestriction,
  matchesRestrictionPath,
  normalizeAndValidateRestrictionPath,
  normalizeRestrictionMatchPath,
  parseRestrictionRule,
  parseRestrictionSources,
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
  '/inventory/**evil',
  'POST:/inventory/**evil',
  'GET:inventory/managedObjects',
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
    description: 'methodless recursive wildcard matches the top-level inventory path',
    rule: '/inventory/**',
    method: 'DELETE',
    path: '/inventory',
    expected: true,
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
  it('normalizes slash-only path matching consistently', () => {
    expect(normalizeRestrictionMatchPath('/inventory//managedObjects/')).toBe('/inventory/managedObjects')
  })

  it('validates and normalizes safe restriction paths', () => {
    expect(normalizeAndValidateRestrictionPath('/inventory//managedObjects/')).toBe('/inventory/managedObjects')
    expect(parseRestrictionRule('get:/inventory/*/child')).toEqual({
      method: 'GET',
      pathPattern: '/inventory/*/child',
      source: 'get:/inventory/*/child',
    })
    expect(parseRestrictionRule('/inventory/managedObjects*/**/evil')).toEqual({
      method: '*',
      pathPattern: '/inventory/managedObjects*/**/evil',
      source: '/inventory/managedObjects*/**/evil',
    })
  })

  it('accepts explicit wildcard method prefixes', () => {
    expect(parseRestrictionRule('*:/inventory/**')).toEqual({
      method: '*',
      pathPattern: '/inventory/**',
      source: '*:/inventory/**',
    })
  })

  it.each(INVALID_RESTRICTION_PAYLOADS)('rejects invalid restriction payload: %s', (payload) => {
    expect(() => parseRestrictionRule(payload)).toThrow()
  })

  it('matchesRestrictionPath uses Node.js path.matchesGlob semantics', () => {
    expect(matchesRestrictionPath('/inventory/managedObjects', '/inventory/m*')).toBe(true)
    expect(matchesRestrictionPath('/inventory/events', '/inventory/m*')).toBe(false)
    expect(matchesRestrictionPath('/inventory/managedObjects/123', '/inventory/**')).toBe(true)
    expect(matchesRestrictionPath('/inventory', '/inventory/**')).toBe(true)
    expect(matchesRestrictionPath('/inventory/child', '/inventory/**/child')).toBe(true)
  })

  it('matches wildcard rules using Node.js path.matchesGlob semantics', () => {
    const rule = parseRestrictionRule('GET:/inventory/*/child')
    expect(findBlockedRestriction([rule], 'GET', '/inventory/device-1/child')).toBeDefined()
    expect(findBlockedRestriction([rule], 'POST', '/inventory/device-1/child')).toBeUndefined()
    expect(findBlockedRestriction([rule], 'GET', '/inventory/device-1/sibling')).toBeUndefined()
  })

  it('finds the first blocked restriction rule', () => {
    const rules = parseRestrictionSources([
      'GET:/inventory/**',
      '/alarm/*',
    ])

    expect(findBlockedRestriction(rules, 'GET', '/inventory/managedObjects/123')?.source).toBe('GET:/inventory/**')
    expect(findBlockedRestriction(rules, 'POST', '/alarm/alarms')?.source).toBe('/alarm/*')
    expect(findBlockedRestriction(rules, 'POST', '/event/events')).toBeUndefined()
  })

  it.each(MATCH_CASES)('$description', ({ rule, method, path, expected }) => {
    const result = findBlockedRestriction([parseRestrictionRule(rule)], method, path)
    expect(result !== undefined).toBe(expected)
  })

  it.each(BLOCKED_RULE_CASES)('$description', ({ rules, method, path, expected }) => {
    const parsedRules = parseRestrictionSources(rules)
    expect(findBlockedRestriction(parsedRules, method, path)?.source).toBe(expected)
  })
})
