import { describe, expect, it } from 'vitest'
import { findBlockingRestrictions, findMatchingRules } from '../src/utils/restriction-matcher'
import {
  ALLOW_HEADER,
  RESTRICTION_HEADER,
  collectServerAllowSources,
  collectServerRestrictionSources,
  parseAllowRule,
  parseRestrictionRule,
} from '../src/utils/restrictions'

function parseSingleRule(input: string) {
  const result = parseRestrictionRule([input])
  const rule = result.parsedRules[0]

  if (!rule || result.failedRules.length > 0) {
    throw new Error(`Expected a valid restriction rule: ${input}`)
  }

  return rule
}

function parseSingleAllowRule(input: string) {
  const result = parseAllowRule([input])
  const rule = result.parsedRules[0]

  if (!rule || result.failedRules.length > 0) {
    throw new Error(`Expected a valid allow rule: ${input}`)
  }

  return rule
}

describe('restriction parsing', () => {
  it('parses methodless restrictions as all-method deny rules', () => {
    expect(parseRestrictionRule('/inventory/**')).toEqual({
      parsedRules: [{
        type: 'deny',
        method: '*',
        pathPattern: '/inventory/**',
        source: '/inventory/**',
      }],
      failedRules: [],
    })
  })

  it('parses method-scoped restrictions', () => {
    expect(parseRestrictionRule('get:/inventory/**')).toEqual({
      parsedRules: [{
        type: 'deny',
        method: 'GET',
        pathPattern: '/inventory/**',
        source: 'get:/inventory/**',
      }],
      failedRules: [],
    })
  })

  it('aggregates parsed and failed restriction values', () => {
    expect(parseRestrictionRule([
      '/inventory/**',
      'POST:/alarm/**',
      'BAD:/devicecontrol/**',
      '',
    ])).toEqual({
      parsedRules: [
        { type: 'deny', method: '*', pathPattern: '/inventory/**', source: '/inventory/**' },
        { type: 'deny', method: 'POST', pathPattern: '/alarm/**', source: 'POST:/alarm/**' },
      ],
      failedRules: [
        { rule: 'BAD:/devicecontrol/**', reason: 'Unsupported restriction method "BAD".' },
        { rule: '', reason: 'Restriction value must not be empty.' },
      ],
    })
  })
})

describe('allow parsing', () => {
  it('parses methodless allow rules as all-method allow rules', () => {
    expect(parseAllowRule('/inventory/**')).toEqual({
      parsedRules: [{
        type: 'allow',
        method: '*',
        pathPattern: '/inventory/**',
        source: '/inventory/**',
      }],
      failedRules: [],
    })
  })

  it('parses method-scoped allow rules', () => {
    expect(parseAllowRule('get:/inventory/**')).toEqual({
      parsedRules: [{
        type: 'allow',
        method: 'GET',
        pathPattern: '/inventory/**',
        source: 'get:/inventory/**',
      }],
      failedRules: [],
    })
  })

  it('aggregates parsed and failed allow values', () => {
    expect(parseAllowRule([
      '/inventory/**',
      'POST:/alarm/**',
      'BAD:/devicecontrol/**',
      '',
    ])).toEqual({
      parsedRules: [
        { type: 'allow', method: '*', pathPattern: '/inventory/**', source: '/inventory/**' },
        { type: 'allow', method: 'POST', pathPattern: '/alarm/**', source: 'POST:/alarm/**' },
      ],
      failedRules: [
        { rule: 'BAD:/devicecontrol/**', reason: 'Unsupported allow method "BAD".' },
        { rule: '', reason: 'Allow value must not be empty.' },
      ],
    })
  })
})

describe('server access policy input collection', () => {
  it('collects restriction rules from query aliases and the project-scoped header', () => {
    const headers = new Headers({
      [RESTRICTION_HEADER]: 'DELETE:/alarm/**, /event/**',
    })

    expect(collectServerRestrictionSources({
      restriction: '/inventory/**',
      restrict: ['GET:/measurement/**'],
      r: '',
    }, headers)).toEqual([
      '/inventory/**',
      'GET:/measurement/**',
      'DELETE:/alarm/**',
      '/event/**',
    ])
  })

  it('ignores empty restriction header entries created by leading, trailing, or repeated commas', () => {
    const headers = new Headers()
    headers.append(RESTRICTION_HEADER, ' , DELETE:/alarm/** ,, /event/** , ')
    headers.append(RESTRICTION_HEADER, ',, GET:/measurement/**,')

    expect(collectServerRestrictionSources({}, headers)).toEqual([
      'DELETE:/alarm/**',
      '/event/**',
      'GET:/measurement/**',
    ])
  })

  it('treats commas inside a restriction rule as separators, so malformed fragments fail parsing independently', () => {
    const sources = collectServerRestrictionSources({}, new Headers({
      [RESTRICTION_HEADER]: 'GET, /inventory/**, POST:/alarm/**',
    }))

    expect(sources).toEqual([
      'GET',
      '/inventory/**',
      'POST:/alarm/**',
    ])

    expect(parseRestrictionRule(sources)).toEqual({
      parsedRules: [
        { type: 'deny', method: '*', pathPattern: '/inventory/**', source: '/inventory/**' },
        { type: 'deny', method: 'POST', pathPattern: '/alarm/**', source: 'POST:/alarm/**' },
      ],
      failedRules: [
        { rule: 'GET', reason: 'Restriction path pattern must start with "/".' },
      ],
    })
  })

  it('surfaces very malformed restriction header fragments individually after comma splitting', () => {
    const sources = collectServerRestrictionSources({}, new Headers({
      [RESTRICTION_HEADER]: 'GET,:/i**, *:,/',
    }))

    expect(sources).toEqual([
      'GET',
      ':/i**',
      '*:',
      '/',
    ])

    expect(parseRestrictionRule(sources)).toEqual({
      parsedRules: [
        { type: 'deny', method: '*', pathPattern: '/', source: '/' },
      ],
      failedRules: [
        { rule: 'GET', reason: 'Restriction path pattern must start with "/".' },
        { rule: ':/i**', reason: 'Restriction path pattern must start with "/".' },
        { rule: '*:', reason: 'Restriction path pattern must not be empty.' },
      ],
    })
  })

  it('collects allow rules from query aliases and trims comma-separated header values', () => {
    const headers = new Headers()
    headers.append(ALLOW_HEADER, ' /inventory/** ')
    headers.append(ALLOW_HEADER, 'POST:/alarm/**,   ')

    expect(collectServerAllowSources({
      allowed: ['GET:/devicecontrol/**'],
      allow: '/measurement/**',
      a: undefined,
    }, headers)).toEqual([
      'GET:/devicecontrol/**',
      '/measurement/**',
      '/inventory/**',
      'POST:/alarm/**',
    ])
  })

  it('ignores empty allow header entries created by leading, trailing, or repeated commas', () => {
    const headers = new Headers()
    headers.append(ALLOW_HEADER, ', /inventory/** ,, POST:/alarm/** ,')
    headers.append(ALLOW_HEADER, ' , , GET:/measurement/**')

    expect(collectServerAllowSources({}, headers)).toEqual([
      '/inventory/**',
      'POST:/alarm/**',
      'GET:/measurement/**',
    ])
  })

  it('treats commas inside an allow rule as separators, so malformed fragments fail parsing independently', () => {
    const sources = collectServerAllowSources({}, new Headers({
      [ALLOW_HEADER]: 'POST, /inventory/**, GET:/alarm/**',
    }))

    expect(sources).toEqual([
      'POST',
      '/inventory/**',
      'GET:/alarm/**',
    ])

    expect(parseAllowRule(sources)).toEqual({
      parsedRules: [
        { type: 'allow', method: '*', pathPattern: '/inventory/**', source: '/inventory/**' },
        { type: 'allow', method: 'GET', pathPattern: '/alarm/**', source: 'GET:/alarm/**' },
      ],
      failedRules: [
        { rule: 'POST', reason: 'Allow path pattern must start with "/".' },
      ],
    })
  })

  it('surfaces very malformed allow header fragments individually after comma splitting', () => {
    const sources = collectServerAllowSources({}, new Headers({
      [ALLOW_HEADER]: 'GET,:/i**, *:,/',
    }))

    expect(sources).toEqual([
      'GET',
      ':/i**',
      '*:',
      '/',
    ])

    expect(parseAllowRule(sources)).toEqual({
      parsedRules: [
        { type: 'allow', method: '*', pathPattern: '/', source: '/' },
      ],
      failedRules: [
        { rule: 'GET', reason: 'Allow path pattern must start with "/".' },
        { rule: ':/i**', reason: 'Allow path pattern must start with "/".' },
        { rule: '*:', reason: 'Allow path pattern must not be empty.' },
      ],
    })
  })
})

describe('restriction matching', () => {
  const rules = [
    parseSingleRule('/inventory/**'),
    parseSingleRule('POST:/alarm/**'),
  ]

  it('blocks every method when no method prefix is provided', () => {
    expect(findBlockingRestrictions(rules, 'GET', '/inventory/managedObjects').map((rule) => rule.source)).toEqual(['/inventory/**'])
  })

  it('keeps method-specific rules scoped to that method', () => {
    expect(findBlockingRestrictions(rules, 'GET', '/alarm/alarms')).toEqual([])
    expect(findBlockingRestrictions(rules, 'POST', '/alarm/alarms').map((rule) => rule.source)).toEqual(['POST:/alarm/**'])
  })

  it('treats unsupported methods as plain uppercase strings', () => {
    expect(findBlockingRestrictions(rules, 'merge', '/alarm/alarms')).toEqual([])
  })

  it('still applies catch-all restrictions when method metadata is missing', () => {
    expect(findBlockingRestrictions(rules, undefined, '/inventory/managedObjects').map((rule) => rule.source)).toEqual(['/inventory/**'])
    expect(findBlockingRestrictions(rules, '', '/inventory/managedObjects').map((rule) => rule.source)).toEqual(['/inventory/**'])
  })

  it('does not treat missing method metadata as GET for method-specific restrictions', () => {
    expect(findBlockingRestrictions(rules, undefined, '/alarm/alarms')).toEqual([])
    expect(findBlockingRestrictions(rules, '', '/alarm/alarms')).toEqual([])
  })
})

describe('allow matching', () => {
  const rules = [
    parseSingleAllowRule('/inventory/**'),
    parseSingleAllowRule('POST:/alarm/**'),
  ]

  it('matches every method when no method prefix is provided', () => {
    expect(findMatchingRules(rules, 'GET', '/inventory/managedObjects').map((rule) => rule.source)).toEqual(['/inventory/**'])
  })

  it('keeps method-specific allow rules scoped to that method', () => {
    expect(findMatchingRules(rules, 'GET', '/alarm/alarms')).toEqual([])
    expect(findMatchingRules(rules, 'POST', '/alarm/alarms').map((rule) => rule.source)).toEqual(['POST:/alarm/**'])
  })

  it('still applies catch-all allow rules when method metadata is missing', () => {
    expect(findMatchingRules(rules, undefined, '/inventory/managedObjects').map((rule) => rule.source)).toEqual(['/inventory/**'])
    expect(findMatchingRules(rules, '', '/inventory/managedObjects').map((rule) => rule.source)).toEqual(['/inventory/**'])
  })

  it('does not treat missing method metadata as GET for method-specific allow rules', () => {
    expect(findMatchingRules(rules, undefined, '/alarm/alarms')).toEqual([])
    expect(findMatchingRules(rules, '', '/alarm/alarms')).toEqual([])
  })
})
