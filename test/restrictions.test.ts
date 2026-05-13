import http from 'node:http'
import { NodeRuntime, createNodeDriver, createNodeRuntimeDriverFactory } from 'secure-exec'
import { describe, expect, it } from 'vitest'
import { createNetworkPermissionDecision } from '../src/codemode/network-permissions'
import { BUNDLED_OPENAPI_ENTRIES, createOpenApiPartRestrictionRules } from '../src/utils/openapi'
import { findBlockingRestrictions, findMatchingRules } from '../src/utils/restriction-matcher'
import {
  ALLOW_HEADER,
  OPENAPI_DISABLED_HEADER,
  OPENAPI_DISABLED_QUERY_KEY,
  RESTRICTION_HEADER,
  collectServerAllowSources,
  collectServerDisabledOpenApiSources,
  collectServerRestrictionSources,
  parseAllowRule,
  parseDisabledOpenApiParts,
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

describe('bundled openapi selection parsing', () => {
  it('parses disabled bundled openapi parts', () => {
    expect(parseDisabledOpenApiParts(['core', 'dtm', 'core'])).toEqual({
      disabledApis: ['core', 'dtm'],
      failedValues: [],
    })
  })

  it('collects disabled bundled openapi parts from the query parameter and the project-scoped header', () => {
    const headers = new Headers()
    headers.append(OPENAPI_DISABLED_HEADER, 'dtm, core')

    expect(collectServerDisabledOpenApiSources({
      [OPENAPI_DISABLED_QUERY_KEY]: ['core', 'dtm'],
    }, headers)).toEqual(['core', 'dtm', 'dtm', 'core'])
  })

  it('reports unsupported bundled openapi parts', () => {
    expect(parseDisabledOpenApiParts(['core', 'abc'])).toEqual({
      disabledApis: ['core'],
      failedValues: [{ value: 'abc', reason: 'Unsupported OpenAPI value "abc". Available: core, dtm.' }],
    })
  })

  it('keeps the bundled core and dtm route roots disjoint', () => {
    const core = BUNDLED_OPENAPI_ENTRIES.find((entry) => entry.api === 'core')
    const dtm = BUNDLED_OPENAPI_ENTRIES.find((entry) => entry.api === 'dtm')
    const corePaths = Object.keys((core?.spec as { paths?: Record<string, unknown> } | undefined)?.paths ?? {})
    const dtmPaths = Object.keys((dtm?.spec as { paths?: Record<string, unknown> } | undefined)?.paths ?? {})

    expect(corePaths.filter((path) => dtmPaths.includes(path))).toEqual([])
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

describe('network permission decisions', () => {
  const tenantUrl = 'https://tenant.example.com'
  const rules = [parseSingleRule('/inventory/**')]

  it('allows connect requests to the configured tenant host when no method is available', () => {
    expect(createNetworkPermissionDecision(tenantUrl, {
      op: 'connect',
      hostname: 'tenant.example.com',
    }, rules)).toEqual({
      allow: true,
    })
  })

  it('still blocks catch-all restrictions when secure-exec provides blank method metadata', () => {
    expect(createNetworkPermissionDecision(tenantUrl, {
      op: 'connect',
      hostname: 'tenant.example.com',
      method: '',
      url: 'https://tenant.example.com/inventory/managedObjects?pageSize=5',
    }, rules)).toEqual({
      allow: false,
      reason: 'Network connect blocked by MCP restrictions: /inventory/**',
    })
  })

  it('does not treat blank secure-exec method metadata as GET for method-specific rules', () => {
    expect(createNetworkPermissionDecision(tenantUrl, {
      op: 'connect',
      hostname: 'tenant.example.com',
      method: '',
      url: 'https://tenant.example.com/alarm/alarms?pageSize=5',
    }, [parseSingleRule('GET:/alarm/**')])).toEqual({
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
      parseSingleRule('/inventory/**'),
      parseSingleRule('GET:/inventory/**'),
    ])).toEqual({
      allow: false,
      reason: 'Network connect blocked by MCP restrictions: /inventory/**, GET:/inventory/**',
    })
  })

  it('allows requests that match the configured allow list', () => {
    expect(createNetworkPermissionDecision(tenantUrl, {
      op: 'connect',
      hostname: 'tenant.example.com',
      method: 'GET',
      url: 'https://tenant.example.com/inventory/managedObjects?pageSize=5',
    }, [], [parseSingleAllowRule('GET:/inventory/**')])).toEqual({
      allow: true,
    })
  })

  it('blocks requests when disabled bundled openapi parts were expanded into restrictions', () => {
    expect(createNetworkPermissionDecision(tenantUrl, {
      op: 'connect',
      hostname: 'tenant.example.com',
      method: 'GET',
      url: 'https://tenant.example.com/assets?pageSize=5',
    }, createOpenApiPartRestrictionRules(['dtm']))).toEqual({
      allow: false,
      reason: expect.stringContaining('Network connect blocked by MCP restrictions:'),
    })
  })

  it('blocks requests outside the configured allow list when method and url are available', () => {
    expect(createNetworkPermissionDecision(tenantUrl, {
      op: 'connect',
      hostname: 'tenant.example.com',
      method: 'GET',
      url: 'https://tenant.example.com/alarm/alarms?pageSize=5',
    }, [], [parseSingleAllowRule('GET:/inventory/**')])).toEqual({
      allow: false,
      reason: 'Network connect blocked by MCP allow list: no allow rule matched GET /alarm/alarms. Configured allow rules: GET:/inventory/**',
    })
  })

  it('lets restrictions take priority over matching allow rules', () => {
    expect(createNetworkPermissionDecision(tenantUrl, {
      op: 'connect',
      hostname: 'tenant.example.com',
      method: 'GET',
      url: 'https://tenant.example.com/inventory/managedObjects?pageSize=5',
    }, [parseSingleRule('/inventory/managedObjects')], [parseSingleAllowRule('/inventory/**')])).toEqual({
      allow: false,
      reason: 'Network connect blocked by MCP restrictions: /inventory/managedObjects',
    })
  })

  it('does not enforce allow lists when secure-exec omits the request method', () => {
    expect(createNetworkPermissionDecision(tenantUrl, {
      op: 'connect',
      hostname: 'tenant.example.com',
      method: '',
      url: 'https://tenant.example.com/alarm/alarms?pageSize=5',
    }, [], [parseSingleAllowRule('GET:/inventory/**')])).toEqual({
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

describe('secure-exec network metadata', () => {
  async function captureNetworkPermissionRequests(code: string): Promise<Array<Record<string, unknown>>> {
    const requests: Array<Record<string, unknown>> = []
    const runtime = new NodeRuntime({
      systemDriver: createNodeDriver({
        useDefaultNetwork: true,
        permissions: {
          network: (request) => {
            requests.push({ ...request })
            return { allow: true }
          },
        },
      }),
      runtimeDriverFactory: createNodeRuntimeDriverFactory(),
    })

    try {
      const result = await runtime.run(code, '/secure-exec-network-test.mjs')
      expect(result.code).toBe(0)
      return requests
    } finally {
      runtime.dispose()
    }
  }

  it('reports only connect+hostname for fetch GET and POST requests in the current runtime', async () => {
    const server = http.createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: true }))
      })
    })

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Expected an ephemeral TCP port for the test server.')
    }

    try {
      const requests = await captureNetworkPermissionRequests(`
        const getResponse = await fetch('http://127.0.0.1:${address.port}/get?x=1')
        await getResponse.text()
        const postResponse = await fetch('http://127.0.0.1:${address.port}/post', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ok: true }),
        })
        await postResponse.text()
        export default true
      `)

      expect(requests).toEqual([
        { op: 'connect', hostname: '127.0.0.1' },
        { op: 'connect', hostname: '127.0.0.1' },
      ])
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error)
            return
          }

          resolve()
        })
      })
    }
  })

  it('reports only connect+hostname for node:http POST requests in the current runtime', async () => {
    const server = http.createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: true }))
      })
    })

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Expected an ephemeral TCP port for the test server.')
    }

    try {
      const requests = await captureNetworkPermissionRequests(`
        import http from 'node:http'
        await new Promise((resolve, reject) => {
          const request = http.request({
            hostname: '127.0.0.1',
            port: ${address.port},
            path: '/post',
            method: 'POST',
            headers: { 'content-type': 'application/json' },
          }, (response) => {
            response.resume()
            response.on('end', () => resolve())
          })
          request.on('error', reject)
          request.write(JSON.stringify({ ok: true }))
          request.end()
        })
        export default true
      `)

      expect(requests).toEqual([
        { op: 'connect', hostname: '127.0.0.1' },
      ])
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error)
            return
          }

          resolve()
        })
      })
    }
  })
})
