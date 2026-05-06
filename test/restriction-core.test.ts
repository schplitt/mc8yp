/* eslint-disable no-template-curly-in-string */
import { describe, expect, it } from 'vitest'
import {
  compileRestrictionRule,
  findBlockingRestrictions,
  matchesCompiledRule,
} from '../src/utils/restriction-matcher'
import { parseRestrictionRule } from '../src/utils/restrictions'

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
    description: 'root restriction matches the root path',
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
    description: 'returns every matching rule in source order',
    rules: ['GET:/inventory/m*', '/inventory/m*/**', '/**/status'],
    method: 'GET',
    path: '/inventory/managedObjects/status',
    expected: ['/inventory/m*/**', '/**/status'],
  },
  {
    description: 'keeps method-specific rules scoped while allowing methodless recursive matches',
    rules: ['GET:/inventory/m*', 'POST:/inventory/**', '/inventory/m*/**'],
    method: 'POST',
    path: '/inventory/managedObjects/123',
    expected: ['POST:/inventory/**', '/inventory/m*/**'],
  },
  {
    description: 'returns no rules when only a single-segment wildcard would have matched the parent resource',
    rules: ['/inventory/m*', 'GET:/alarm/**'],
    method: 'GET',
    path: '/inventory/managedObjects/123',
    expected: [],
  },
] as const

function parseSingleRule(input: string) {
  const result = parseRestrictionRule([input])
  const rule = result.parsedRules[0]

  if (!rule || result.failedRules.length > 0) {
    throw new Error(`Expected a valid restriction rule: ${input}`)
  }

  return rule
}

function toPathSegments(path: string): string[] {
  return path === '/' ? [] : path.slice(1).split('/')
}

describe('restriction core helpers', () => {
  it('parses safe restriction paths without normalization', () => {
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

  it.each(INVALID_RESTRICTION_PAYLOADS)('reports invalid restriction payload: %s', (payload) => {
    expect(parseRestrictionRule(payload)).toEqual({
      parsedRules: [],
      failedRules: [{
        rule: payload,
        reason: expect.any(String),
      }],
    })
  })

  it('compiles wildcard rules and matches the expected paths', () => {
    const compiledRule = compileRestrictionRule(parseSingleRule('GET:/inventory/*/child'))

    expect(matchesCompiledRule(compiledRule, 'GET', ['inventory', 'device-1', 'child'])).toBe(true)
    expect(matchesCompiledRule(compiledRule, 'POST', ['inventory', 'device-1', 'child'])).toBe(false)
    expect(matchesCompiledRule(compiledRule, 'GET', ['inventory', 'device-1', 'sibling'])).toBe(false)
  })

  it.each(MATCH_CASES)('$description', ({ rule, method, path, expected }) => {
    const compiledRule = compileRestrictionRule(parseSingleRule(rule))

    expect(matchesCompiledRule(compiledRule, method, toPathSegments(path))).toBe(expected)
  })

  it('finds blocked rules using the shared matching logic', () => {
    const rules = [
      parseSingleRule('GET:/inventory/**'),
      parseSingleRule('/alarm/*'),
    ]

    expect(findBlockingRestrictions(rules, 'GET', '/inventory/managedObjects/123').map((rule) => rule.source)).toEqual(['GET:/inventory/**'])
    expect(findBlockingRestrictions(rules, 'POST', '/alarm/alarms').map((rule) => rule.source)).toEqual(['/alarm/*'])
    expect(findBlockingRestrictions(rules, 'POST', '/event/events')).toEqual([])
  })

  it.each(BLOCKED_RULE_CASES)('$description', ({ rules, method, path, expected }) => {
    expect(findBlockingRestrictions(rules.map((rule) => parseSingleRule(rule)), method, path).map((rule) => rule.source)).toEqual(expected)
  })
})
