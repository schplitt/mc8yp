/* eslint-disable no-template-curly-in-string */
import type { Buffer } from 'node:buffer'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { encode } from '@toon-format/toon'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BLOCKED_REQUEST_PREFIX, disposeSandbox, execute, query } from '../src/codemode/execute'
import type { ResolvedSpecs } from '../src/utils/spec-resolution'
import { resolveSpecs } from '../src/utils/spec-resolution'
import { bustApiSpecCache, setCachedApiSpecs } from '../src/utils/api-discovery'
import { c8yMcpServer } from '../src/server-instance'
import { parseAllowRule, parseRestrictionRule } from '../src/utils/restrictions'
import type { AllowRule, RestrictionRule } from '../src/utils/restrictions'
import * as client from '../src/utils/client'

const TEST_TENANT = 'https://tenant.example.com'

function parseSingleRule(input: string): RestrictionRule {
  const result = parseRestrictionRule([input])
  const rule = result.parsedRules[0]
  if (!rule || result.failedRules.length > 0) {
    throw new Error(`Expected a valid restriction rule: ${input}`)
  }
  return rule
}

function parseSingleAllowRule(input: string): AllowRule {
  const result = parseAllowRule([input])
  const rule = result.parsedRules[0]
  if (!rule || result.failedRules.length > 0) {
    throw new Error(`Expected a valid allow rule: ${input}`)
  }
  return rule
}

const INVALID_RESTRICTION_QUERY_PAYLOADS = [
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

function expectedRestrictedRequestMessage(method: string, path: string, matchingRules: readonly string[]): string {
  return [
    BLOCKED_REQUEST_PREFIX,
    '',
    'This operation is intentionally denied by the current MCP connection configuration.',
    'It did not fail at the Cumulocity API and it was not executed against the tenant.',
    'Retrying or trying the same operation again through this connection will not succeed.',
    '',
    'Report this to the user as a connection-level access restriction.',
    'If the operation is needed, the MCP restrictions for this connection must be updated by whoever manages that configuration.',
    '',
    'Blocked operation:',
    `Method: ${method}`,
    `Path: ${path}`,
    'Matching restrictions:',
    ...matchingRules.map((rule) => `- ${rule}`),
  ].join('\n')
}

function expectedAllowedRequestMessage(method: string, path: string, allowRules: readonly string[]): string {
  return [
    BLOCKED_REQUEST_PREFIX,
    '',
    'This operation is intentionally blocked because it is not included in the current MCP connection allow list.',
    'It did not fail at the Cumulocity API and it was not executed against the tenant.',
    'Retrying or trying the same operation again through this connection will not succeed.',
    '',
    'Report this to the user as a connection-level access restriction.',
    'If the operation is needed, the MCP allow list for this connection must be updated by whoever manages that configuration.',
    '',
    'Blocked operation:',
    `Method: ${method}`,
    `Path: ${path}`,
    'Configured allow rules:',
    ...allowRules.map((rule) => `- ${rule}`),
  ].join('\n')
}

// ─────────────────────────────────────────────────────────────────────────
// Shared harness: stub the MCP context so execute() picks up restrictions
// and stub resolveC8yAuth so it does not look in the keychain.
// ─────────────────────────────────────────────────────────────────────────

function stubExecuteCtx(opts: {
  restrictions?: readonly RestrictionRule[]
  allowRules?: readonly AllowRule[]
  env?: 'cli' | 'server'
  auth?: { tenantUrl: string, authorizationHeader: string } | undefined
} = {}): () => void {
  const ctxSpy = vi.spyOn(c8yMcpServer, 'ctx', 'get').mockReturnValue({
    custom: {
      env: opts.env ?? 'cli',
      restrictions: opts.restrictions ?? [],
      allowRules: opts.allowRules ?? [],
      specs: { core: { paths: {} }, specs: {} },
      auth: opts.auth,
    },
  } as unknown as ReturnType<typeof c8yMcpServer['ctx']['valueOf']>)
  return () => ctxSpy.mockRestore()
}

function mockAuth(tenantUrl: string, authorizationHeader = 'Bearer test'): void {
  vi.spyOn(client, 'resolveC8yAuth').mockResolvedValueOnce({ tenantUrl, authorizationHeader })
}

beforeEach(() => {
  setCachedApiSpecs(TEST_TENANT, [])
})

afterEach(() => {
  vi.restoreAllMocks()
  bustApiSpecCache()
})

afterAll(async () => {
  // Tear down the lazy sandbox singleton so the Rust child process exits.
  await disposeSandbox()
})

// CLI-mode execute prepends `Executed against tenant: <url>\n\n`. query
// appends `\n\n---\n<tenant-aware footer>`. The behavioural tests below
// strip those off so they keep asserting on the actual function body;
// dedicated tests further down cover the marker / footer presence
// explicitly so they cannot regress silently.
function stripCliTenantMarker(text: string): string {
  const match = /^Executed against tenant: [^\n]+\n\n/.exec(text)
  return match ? text.slice(match[0].length) : text
}

function stripQueryFooter(text: string): string {
  const idx = text.lastIndexOf('\n\n---\n')
  return idx === -1 ? text : text.slice(0, idx)
}

// ─────────────────────────────────────────────────────────────────────────
// Sandbox-side wrapper validation — these errors happen *before* any bridge
// call, so they never touch the network.
// ─────────────────────────────────────────────────────────────────────────

describe('cumulocity.request — sandbox-side input validation', () => {
  it('rejects requests without an explicit method', async () => {
    const restore = stubExecuteCtx()
    try {
      mockAuth(TEST_TENANT)
      const result = await execute(`async () => await cumulocity.request({ path: '/event/events' })`)
      expect(stripCliTenantMarker(result)).toBe('request method must be a non-empty string')
    } finally {
      restore()
    }
  })

  it('rejects unsupported request methods', async () => {
    const restore = stubExecuteCtx()
    try {
      mockAuth(TEST_TENANT)
      const result = await execute(`async () => await cumulocity.request({ method: 'MERGE', path: '/event/events' })`)
      expect(stripCliTenantMarker(result)).toBe('request method must be one of: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT, TRACE')
    } finally {
      restore()
    }
  })

  it('rejects non-object options', async () => {
    const restore = stubExecuteCtx()
    try {
      mockAuth(TEST_TENANT)
      const result = await execute(`async () => await cumulocity.request('hello')`)
      expect(stripCliTenantMarker(result)).toBe('request options must be an object')
    } finally {
      restore()
    }
  })

  it('rejects empty paths', async () => {
    const restore = stubExecuteCtx()
    try {
      mockAuth(TEST_TENANT)
      const result = await execute(`async () => await cumulocity.request({ method: 'GET', path: '' })`)
      expect(stripCliTenantMarker(result)).toBe('request path must be a non-empty string')
    } finally {
      restore()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────
// safeFetch middleware — restriction and allow-list enforcement.
// These run host-side and throw before undici is touched, so they need no
// HTTP server.
// ─────────────────────────────────────────────────────────────────────────

describe('cumulocity.request — policy enforcement (middleware)', () => {
  it('blocks restricted requests before any HTTP call', async () => {
    const restore = stubExecuteCtx({ restrictions: [parseSingleRule('GET:/inventory/**')] })
    try {
      mockAuth(TEST_TENANT)
      const result = await execute(
        `async () => await cumulocity.request({ method: 'GET', path: '/inventory/managedObjects?pageSize=5' })`,
      )
      expect(stripCliTenantMarker(result)).toBe(
        expectedRestrictedRequestMessage('GET', '/inventory/managedObjects', ['GET:/inventory/**']),
      )
    } finally {
      restore()
    }
  })

  it('blocks requests outside the configured allow list', async () => {
    const restore = stubExecuteCtx({ allowRules: [parseSingleAllowRule('GET:/inventory/**')] })
    try {
      mockAuth(TEST_TENANT)
      const result = await execute(
        `async () => await cumulocity.request({ method: 'GET', path: '/alarm/alarms?pageSize=5' })`,
      )
      expect(stripCliTenantMarker(result)).toBe(
        expectedAllowedRequestMessage('GET', '/alarm/alarms', ['GET:/inventory/**']),
      )
    } finally {
      restore()
    }
  })

  it('lets restrictions take priority over matching allow rules', async () => {
    const restore = stubExecuteCtx({
      restrictions: [parseSingleRule('GET:/inventory/managedObjects')],
      allowRules: [parseSingleAllowRule('GET:/inventory/**')],
    })
    try {
      mockAuth(TEST_TENANT)
      const result = await execute(
        `async () => await cumulocity.request({ method: 'GET', path: '/inventory/managedObjects?pageSize=5' })`,
      )
      expect(stripCliTenantMarker(result)).toBe(
        expectedRestrictedRequestMessage('GET', '/inventory/managedObjects', ['GET:/inventory/managedObjects']),
      )
    } finally {
      restore()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Success-path tests — run a local HTTP server and point the tenant URL at
// it so the full sandbox → bridge → safeFetch → undici → server roundtrip
// is exercised.
// ─────────────────────────────────────────────────────────────────────────

interface CapturedHttpRequest {
  method: string
  url: string
  headers: http.IncomingHttpHeaders
  body: string
}

interface TestServer {
  url: string
  requests: CapturedHttpRequest[]
  setResponse: (response: { status?: number, body?: unknown, contentType?: string }) => void
  close: () => Promise<void>
}

async function startTestServer(): Promise<TestServer> {
  const requests: CapturedHttpRequest[] = []
  let nextResponse = {
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true }) as string,
  }

  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8')
    })
    req.on('end', () => {
      requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body,
      })
      res.statusCode = nextResponse.status
      res.setHeader('content-type', nextResponse.contentType)
      res.end(nextResponse.body)
    })
  })

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve()
    })
  })
  const port = (server.address() as AddressInfo).port

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    setResponse: (next) => {
      nextResponse = {
        status: next.status ?? 200,
        contentType: next.contentType ?? 'application/json',
        body: typeof next.body === 'string'
          ? next.body
          : next.body == null ? '' : JSON.stringify(next.body),
      }
    },
    close: () => new Promise<void>((resolve) => {
      server.close(() => {
        resolve()
      })
    }),
  }
}

describe('cumulocity.request — success path', () => {
  let testServer: TestServer

  beforeEach(async () => {
    testServer = await startTestServer()
  })

  afterEach(async () => {
    await testServer.close()
  })

  it('issues the request, injects auth, and returns the parsed JSON body', async () => {
    const restore = stubExecuteCtx({ restrictions: [parseSingleRule('GET:/forbidden/**')] })
    try {
      mockAuth(testServer.url, 'Bearer host-token')
      const result = await execute(
        `async () => await cumulocity.request({ method: 'POST', path: '/event/events' })`,
      )

      expect(stripCliTenantMarker(result)).toBe(encode({ ok: true }))
      expect(testServer.requests).toHaveLength(1)
      expect(testServer.requests[0]!.method).toBe('POST')
      expect(testServer.requests[0]!.url).toBe('/event/events')
      expect(testServer.requests[0]!.headers.authorization).toBe('Bearer host-token')
    } finally {
      restore()
    }
  })

  it('allows requests that match the configured allow list', async () => {
    const restore = stubExecuteCtx({ allowRules: [parseSingleAllowRule('GET:/inventory/**')] })
    try {
      mockAuth(testServer.url)
      const result = await execute(
        `async () => await cumulocity.request({ method: 'GET', path: '/inventory/managedObjects?pageSize=5' })`,
      )

      expect(stripCliTenantMarker(result)).toBe(encode({ ok: true }))
      expect(testServer.requests[0]!.method).toBe('GET')
      expect(testServer.requests[0]!.url).toBe('/inventory/managedObjects?pageSize=5')
    } finally {
      restore()
    }
  })

  it('does not let sandbox-supplied headers override the configured auth header', async () => {
    const restore = stubExecuteCtx()
    try {
      mockAuth(testServer.url, 'Bearer host-only')
      await execute(
        `async () => await cumulocity.request({
          method: 'GET',
          path: '/inventory/managedObjects',
          headers: { Authorization: 'Bearer agent-injected' },
        })`,
      )

      expect(testServer.requests[0]!.headers.authorization).toBe('Bearer host-only')
    } finally {
      restore()
    }
  })

  it('JSON-encodes object bodies and sets a JSON content-type when absent', async () => {
    const restore = stubExecuteCtx()
    try {
      mockAuth(testServer.url)
      await execute(
        `async () => await cumulocity.request({ method: 'POST', path: '/event/events', body: { type: 'thing' } })`,
      )

      expect(testServer.requests[0]!.body).toBe(JSON.stringify({ type: 'thing' }))
      expect(testServer.requests[0]!.headers['content-type']).toBe('application/json')
    } finally {
      restore()
    }
  })

  it('surfaces non-2xx Cumulocity responses as failed execution', async () => {
    const restore = stubExecuteCtx()
    try {
      testServer.setResponse({ status: 404, body: { message: 'no such resource' } })
      mockAuth(testServer.url)
      const result = await execute(
        `async () => await cumulocity.request({ method: 'GET', path: '/inventory/managedObjects' })`,
      )

      expect(result).toMatch(/Cumulocity request failed with 404[\s\S]*no such resource/)
      expect(result).not.toContain(BLOCKED_REQUEST_PREFIX)
    } finally {
      restore()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Restriction / allow rule parsing — unaffected by the sandbox swap.
// ─────────────────────────────────────────────────────────────────────────

describe('restriction & allow rule parsing rejects malicious payloads', () => {
  it.each(INVALID_RESTRICTION_QUERY_PAYLOADS)('reports invalid malicious restriction text: %s', (payload) => {
    expect(parseRestrictionRule([payload])).toEqual({
      parsedRules: [],
      failedRules: [{ rule: payload, reason: expect.any(String) }],
    })
    expect(parseAllowRule([payload])).toEqual({
      parsedRules: [],
      failedRules: [{ rule: payload, reason: expect.any(String) }],
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────
// query — unchanged behavioural coverage.
// ─────────────────────────────────────────────────────────────────────────

describe('query', () => {
  function withSpecs(specs: ResolvedSpecs, auth?: { tenantUrl: string, authorizationHeader: string }): () => void {
    const ctxSpy = vi.spyOn(c8yMcpServer, 'ctx', 'get').mockReturnValue({
      custom: {
        env: 'cli' as const,
        restrictions: [],
        allowRules: [],
        specs,
        auth,
      },
    } as unknown as ReturnType<typeof c8yMcpServer['ctx']['valueOf']>)
    return () => ctxSpy.mockRestore()
  }

  it('exposes coreSpec and serviceSpecs through the query sandbox', async () => {
    const restore = withSpecs({ core: { paths: {} }, specs: {} })
    try {
      const result = await query(
        '() => ({ hasCore: !!coreSpec, hasServiceSpecs: typeof serviceSpecs === "object", noSpecsEnabled: typeof specsEnabled === "undefined" })',
      )
      expect(JSON.parse(stripQueryFooter(result))).toEqual({ hasCore: true, hasServiceSpecs: true, noSpecsEnabled: true })
    } finally {
      restore()
    }
  })

  it('exposes core as the coreSpec binding', async () => {
    const restore = withSpecs({ core: { paths: { '/inventory/managedObjects': {} } }, specs: {} })
    try {
      const result = await query('() => Object.keys(coreSpec.paths)')
      expect(JSON.parse(stripQueryFooter(result))).toEqual(['/inventory/managedObjects'])
    } finally {
      restore()
    }
  })

  it('reads specs from c8yMcpServer.ctx.custom (no override path exists)', async () => {
    const restore = withSpecs(resolveSpecs([], new Set()))
    try {
      const result = await query('() => typeof coreSpec !== "undefined"')
      expect(JSON.parse(stripQueryFooter(result))).toBe(true)
    } finally {
      restore()
    }
  })

  it('puts service-map entries into serviceSpecs keyed by contextPath', async () => {
    const restore = withSpecs({ core: { paths: {} }, specs: { svc: { paths: {} } } })
    try {
      const result = await query('() => Object.keys(serviceSpecs)')
      expect(JSON.parse(stripQueryFooter(result))).toEqual(['svc'])
    } finally {
      restore()
    }
  })

  it('serviceSpecs entries are bare Spec objects (no wrapper) so paths read directly', async () => {
    const restore = withSpecs({ core: { paths: {} }, specs: { dtm: { paths: { '/service/dtm/assets': {} } } } })
    try {
      const result = await query(`() => Object.keys(serviceSpecs.dtm.paths)`)
      expect(JSON.parse(stripQueryFooter(result))).toEqual(['/service/dtm/assets'])
    } finally {
      restore()
    }
  })

  it('unavailable services are simply absent from serviceSpecs', async () => {
    const restore = withSpecs({ core: { paths: {} }, specs: {} })
    try {
      const result = await query(`() => ({ keys: Object.keys(serviceSpecs), hasDtm: 'dtm' in serviceSpecs })`)
      expect(JSON.parse(stripQueryFooter(result))).toEqual({ keys: [], hasDtm: false })
    } finally {
      restore()
    }
  })

  it('cannot make network calls from the query sandbox', async () => {
    const restore = withSpecs({ core: { paths: {} }, specs: {} })
    try {
      await expect(query('() => fetch("https://example.com")')).rejects.toThrow()
    } finally {
      restore()
    }
  })

  it('exposes searchSpecs over endpoints, tags, and spec info with source headers', async () => {
    const restore = withSpecs({
      // Runtime specs carry `info` and `operationId`; the narrow Spec type does
      // not, hence the cast.
      core: {
        info: { title: 'Cumulocity core', description: 'The core REST API' },
        tags: [{ name: 'Query language', description: 'OData $filter eq operator with wildcards' }],
        paths: {
          '/inventory/managedObjects': {
            get: {
              operationId: 'getManagedObjectCollection',
              summary: 'Retrieve managed objects',
              description: 'List the inventory of managed objects',
              tags: ['Inventory'],
            },
          },
        },
      },
      specs: { dtm: { paths: { '/service/dtm/assets': { get: { summary: 'List digital twin assets' } } } } },
    } as unknown as ResolvedSpecs)
    try {
      const result = await query(
        '() => searchSpecs("odata filter operator", { limit: 5 }).map(r => ({ header: r.header, kind: r.kind, spec: r.spec, hasText: typeof r.text === "string", hasScore: typeof r.score === "number" }))',
      )
      const hits = JSON.parse(stripQueryFooter(result)) as Array<{ header: string, kind: string, spec: string, hasText: boolean, hasScore: boolean }>
      expect(hits.length).toBeGreaterThan(0)
      // Top hit is the core "Query language" tag, identified by its header.
      expect(hits[0]).toMatchObject({ kind: 'tag', spec: 'core', hasText: true, hasScore: true })
      expect(hits[0].header).toBe('coreSpec.tags.find((t) => t.name === "Query language")')
    } finally {
      restore()
    }
  })

  it('truncates long hit text to a preview that names the header to read in full', async () => {
    const longDesc = `OData filter reference. ${'isinhierarchyof predicate. '.repeat(80)}`
    const restore = withSpecs({
      core: { tags: [{ name: 'Query language', description: longDesc }], paths: {} },
      specs: {},
    } as unknown as ResolvedSpecs)
    try {
      const result = await query(
        '() => { const h = searchSpecs("isinhierarchyof", { limit: 1 })[0]; return { truncated: h.truncated, header: h.header, len: h.text.length, hasMarker: h.text.includes("TRUNCATED PREVIEW"), pointsToSource: h.text.includes(h.header) } }',
      )
      const hit = JSON.parse(stripQueryFooter(result)) as {
        truncated: boolean
        header: string
        len: number
        hasMarker: boolean
        pointsToSource: boolean
      }
      expect(hit.truncated).toBe(true)
      expect(hit.header).toBe('coreSpec.tags.find((t) => t.name === "Query language")')
      expect(hit.hasMarker).toBe(true)
      expect(hit.pointsToSource).toBe(true)
      expect(hit.len).toBeLessThan(longDesc.length)
    } finally {
      restore()
    }
  })

  it('leaves short hit text untruncated', async () => {
    const restore = withSpecs({
      core: { tags: [{ name: 'Query language', description: 'short eq operator note' }], paths: {} },
      specs: {},
    } as unknown as ResolvedSpecs)
    try {
      const result = await query(
        '() => { const h = searchSpecs("eq operator", { limit: 1 })[0]; return { truncated: h.truncated, hasMarker: h.text.includes("TRUNCATED") } }',
      )
      const hit = JSON.parse(stripQueryFooter(result)) as { truncated: boolean, hasMarker: boolean }
      expect(hit.truncated).toBe(false)
      expect(hit.hasMarker).toBe(false)
    } finally {
      restore()
    }
  })

  it('searchSpecs indexes service endpoints alongside core', async () => {
    const restore = withSpecs({
      core: { paths: { '/inventory/managedObjects': { get: { summary: 'Retrieve managed objects' } } } },
      specs: { dtm: { paths: { '/service/dtm/assets': { get: { summary: 'List managed assets' } } } } },
    } as unknown as ResolvedSpecs)
    try {
      const result = await query(
        '() => searchSpecs("managed assets").map(r => r.spec)',
      )
      const specs = JSON.parse(stripQueryFooter(result)) as string[]
      expect(specs).toContain('dtm')
    } finally {
      restore()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────
// searchSpecs — full end-to-end through the real query() path. Same code as
// production query codemode (precompiled prefix → ?bundle minisearch → index →
// searchSpecs), exercised against a realistic multi-spec surface to prove the
// keyword search behaves as intended: cross-spec discovery, score ordering,
// navigable headers, spec scoping, and chaining a hit back into the binding.
// ─────────────────────────────────────────────────────────────────────────

describe('query — searchSpecs end-to-end', () => {
  interface Hit { header: string, text: string, kind: string, spec: string, score: number }

  const SPECS = {
    core: {
      info: { title: 'Cumulocity core', description: 'Inventory, alarms and measurements REST API' },
      tags: [
        { name: 'Query language', description: 'OData $filter language: eq, gt, and wildcards to filter managed objects' },
        { name: 'Alarms', description: 'Alarm severity, status and acknowledgement handling' },
      ],
      paths: {
        '/inventory/managedObjects': {
          get: {
            operationId: 'getManagedObjectCollection',
            summary: 'Retrieve a collection of managed objects',
            description: 'Paginated inventory listing',
            tags: ['Inventory'],
            parameters: [{ name: 'query', in: 'query', description: 'Filter using the $filter query language' }],
          },
        },
        '/alarm/alarms': {
          get: { operationId: 'getAlarmCollection', summary: 'Retrieve a collection of alarms', tags: ['Alarms'] },
        },
      },
    },
    specs: {
      dtm: {
        info: { title: 'Digital Twin Manager', description: 'Asset model service' },
        paths: {
          '/service/dtm/assets': {
            get: { operationId: 'listAssets', summary: 'List digital twin assets', description: 'Traverse the asset hierarchy' },
          },
        },
      },
    },
  } as unknown as ResolvedSpecs

  async function runSearch<T>(code: string): Promise<T> {
    const ctxSpy = vi.spyOn(c8yMcpServer, 'ctx', 'get').mockReturnValue({
      custom: { env: 'cli' as const, restrictions: [], allowRules: [], specs: SPECS },
    } as unknown as ReturnType<typeof c8yMcpServer['ctx']['valueOf']>)
    try {
      return JSON.parse(stripQueryFooter(await query(code))) as T
    } finally {
      ctxSpy.mockRestore()
    }
  }

  it('finds the core query-language docs from a keyword, ranked first, with a navigable header', async () => {
    const hits = await runSearch<Hit[]>('() => searchSpecs("filter query language")')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]).toMatchObject({ kind: 'tag', spec: 'core' })
    expect(hits[0].header).toBe('coreSpec.tags.find((t) => t.name === "Query language")')
  })

  it('returns hits sorted by descending score', async () => {
    const hits = await runSearch<Hit[]>('() => searchSpecs("managed objects inventory", { limit: 10 })')
    const scores = hits.map((h) => h.score)
    expect(scores.length).toBeGreaterThan(1)
    expect([...scores].sort((a, b) => b - a)).toEqual(scores)
  })

  it('endpoint headers point straight at the source spec node', async () => {
    const hits = await runSearch<Hit[]>('() => searchSpecs("retrieve managed objects collection")')
    const endpoint = hits.find((h) => h.kind === 'endpoint' && h.spec === 'core')
    expect(endpoint?.header).toBe('coreSpec.paths["/inventory/managedObjects"].get')
  })

  it('indexes service endpoints and points into serviceSpecs', async () => {
    const hits = await runSearch<Hit[]>('() => searchSpecs("asset hierarchy")')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.some((h) => h.spec === 'dtm')).toBe(true)
    expect(hits.some((h) => h.header.startsWith('serviceSpecs["dtm"]'))).toBe(true)
  })

  it('respects the limit option', async () => {
    const counts = await runSearch<{ all: number, limited: number }>(
      '() => ({ all: searchSpecs("collection").length, limited: searchSpecs("collection", { limit: 1 }).length })',
    )
    expect(counts.all).toBeGreaterThan(1)
    expect(counts.limited).toBe(1)
  })

  it('supports the intended workflow: search, then read the node the header points to', async () => {
    // Returns an object (query() passes strings through raw, objects as JSON).
    const out = await runSearch<{ found: boolean, summary: string | null }>(`() => {
      const hit = searchSpecs("managed objects").find(h => h.kind === "endpoint" && h.spec === "core")
      return { found: !!hit, summary: hit ? coreSpec.paths["/inventory/managedObjects"].get.summary : null }
    }`)
    expect(out.found).toBe(true)
    expect(out.summary).toBe('Retrieve a collection of managed objects')
  })
})

// ─────────────────────────────────────────────────────────────────────────
// execute — high-level behaviour (envelope contract has been removed: a
// successful run returns the Toon-encoded function result; any thrown error
// surfaces as plain text, with BLOCKED_REQUEST_PREFIX preserved verbatim so
// callers can still differentiate policy denials from generic failures).
// ─────────────────────────────────────────────────────────────────────────

describe('execute', () => {
  it('returns the successful function result encoded in Toon format', async () => {
    const restore = stubExecuteCtx()
    try {
      mockAuth(TEST_TENANT)
      const result = await execute('async () => ({ ok: true, answer: 42 })')
      expect(stripCliTenantMarker(result)).toBe(encode({ ok: true, answer: 42 }))
    } finally {
      restore()
    }
  })

  it('returns blocked execution as plain text (BLOCKED prefix preserved)', async () => {
    const restore = stubExecuteCtx()
    try {
      mockAuth(TEST_TENANT)
      const result = await execute(
        `async () => { throw new Error(${JSON.stringify(`${BLOCKED_REQUEST_PREFIX}\n\nblocked`)}) }`,
      )
      expect(stripCliTenantMarker(result)).toBe(`${BLOCKED_REQUEST_PREFIX}\n\nblocked`)
    } finally {
      restore()
    }
  })

  it('returns failed execution as plain text', async () => {
    const restore = stubExecuteCtx()
    try {
      mockAuth(TEST_TENANT)
      const result = await execute('async () => { throw new Error("boom") }')
      expect(stripCliTenantMarker(result)).toBe('boom')
    } finally {
      restore()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Agent-facing hints — explicit coverage so the marker and footer cannot
// regress silently when other behavioural assertions strip them off.
// ─────────────────────────────────────────────────────────────────────────

describe('execute — CLI tenant marker', () => {
  it('prepends "Executed against tenant: <url>" on success in CLI mode', async () => {
    const restore = stubExecuteCtx({ env: 'cli' })
    try {
      mockAuth(TEST_TENANT)
      const result = await execute('async () => ({ ok: true })')
      expect(result.startsWith(`Executed against tenant: ${TEST_TENANT}\n\n`)).toBe(true)
    } finally {
      restore()
    }
  })

  it('prepends the same marker on blocked and failed outputs in CLI mode', async () => {
    const restore = stubExecuteCtx({ env: 'cli' })
    try {
      mockAuth(TEST_TENANT)
      const blocked = await execute(
        `async () => { throw new Error(${JSON.stringify(`${BLOCKED_REQUEST_PREFIX}\n\nblocked`)}) }`,
      )
      expect(blocked.startsWith(`Executed against tenant: ${TEST_TENANT}\n\n`)).toBe(true)
    } finally {
      restore()
    }
  })

  it('does NOT prepend the marker in server mode', async () => {
    const restore = stubExecuteCtx({ env: 'server' })
    try {
      mockAuth(TEST_TENANT)
      const result = await execute('async () => ({ ok: true })')
      expect(result.startsWith('Executed against tenant:')).toBe(false)
    } finally {
      restore()
    }
  })
})

describe('query — tenant footer', () => {
  function withAuth(tenantUrl: string | undefined, env: 'cli' | 'server' = 'cli'): () => void {
    const ctxSpy = vi.spyOn(c8yMcpServer, 'ctx', 'get').mockReturnValue({
      custom: {
        env,
        restrictions: [],
        allowRules: [],
        specs: { core: { paths: {} }, specs: {} },
        auth: tenantUrl ? { tenantUrl, authorizationHeader: 'Bearer test' } : undefined,
      },
    } as unknown as ReturnType<typeof c8yMcpServer['ctx']['valueOf']>)
    return () => ctxSpy.mockRestore()
  }

  it('appends "Query ran against tenant: <url>" when an auth context exists', async () => {
    const restore = withAuth('https://acme.cumulocity.com')
    try {
      const result = await query('() => ({ ok: true })')
      expect(result).toContain('\n\n---\nQuery ran against tenant: https://acme.cumulocity.com.')
    } finally {
      restore()
    }
  })

  it('appends a "no active tenant" notice when auth is undefined', async () => {
    const restore = withAuth(undefined)
    try {
      const result = await query('() => ({ ok: true })')
      expect(result).toContain('\n\n---\nQuery ran against bundled OpenAPI snapshots only')
      expect(result).toContain('no active tenant')
    } finally {
      restore()
    }
  })

  it('does NOT append a footer in server mode', async () => {
    const restore = withAuth('https://acme.cumulocity.com', 'server')
    try {
      const result = await query('() => ({ ok: true })')
      expect(result).not.toContain('Query ran against')
      expect(result).not.toContain('---')
      expect(result).toBe(JSON.stringify({ ok: true }))
    } finally {
      restore()
    }
  })
})
