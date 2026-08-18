import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  collectServerExternalMcpSources,
  createExternalMcpFetch,
  externalMcpHeaders,
  parseExternalMcpServers,
} from '../src/utils/external-mcp'
import {
  CLI_EXTERNAL_MCP_SESSION,
  disposeAllExternalMcpSessions,
  evictExternalMcpSession,
  getExternalMcpSessionCount,
  resolveExternalMcpServers,
} from '../src/codemode/external-mcp-session'
import { buildNamespaces, toSearchableMethods } from '../src/codemode/namespaces'
import { describeTarget } from '../src/codemode/describe'
import { getMethodIndex } from '../src/codemode/method-search'
import type { ExternalMcpServer } from '../src/codemode/external-mcp-session'
import type { McpNamespace } from '../src/codemode/namespaces'
import type { TenantCapabilities, Spec } from '../src/utils/capability-resolution'

// ─────────────────────────────────────────────────────────────────────────
// Config parsing
// ─────────────────────────────────────────────────────────────────────────

describe('parseExternalMcpServers', () => {
  it('parses a single JSON object entry', () => {
    const { servers, failedEntries } = parseExternalMcpServers([
      '{"name":"github","url":"https://api.githubcopilot.com/mcp/","token":"ghp_x"}',
    ])
    expect(failedEntries).toEqual([])
    expect(servers).toEqual([{ name: 'github', url: 'https://api.githubcopilot.com/mcp/', token: 'ghp_x' }])
  })

  it('parses an array entry and keeps optional fields', () => {
    const { servers } = parseExternalMcpServers([
      '[{"name":"a","url":"https://a.example/mcp","description":"A"},{"name":"b","url":"http://b.example/mcp","headers":{"x-api-key":"k"}}]',
    ])
    expect(servers).toEqual([
      { name: 'a', url: 'https://a.example/mcp', description: 'A' },
      { name: 'b', url: 'http://b.example/mcp', headers: { 'x-api-key': 'k' } },
    ])
  })

  it('rejects a missing or non-identifier name', () => {
    const { servers, failedEntries } = parseExternalMcpServers([
      '{"url":"https://a.example/mcp"}',
      '{"name":"my-server","url":"https://a.example/mcp"}',
      '{"name":"9lives","url":"https://a.example/mcp"}',
    ])
    expect(servers).toEqual([])
    expect(failedEntries).toHaveLength(3)
    expect(failedEntries[0]!.reason).toContain('"name" is required')
    expect(failedEntries[1]!.reason).toContain('valid JavaScript identifier')
  })

  it('rejects reserved namespaces so a header cannot impersonate the platform surface', () => {
    const { servers, failedEntries } = parseExternalMcpServers([
      '[{"name":"c8y","url":"https://evil.example/mcp"},{"name":"sandbox","url":"https://evil.example/mcp"},{"name":"codemode","url":"https://evil.example/mcp"}]',
    ])
    expect(servers).toEqual([])
    expect(failedEntries).toHaveLength(3)
    for (const failure of failedEntries)
      expect(failure.reason).toContain('reserved namespace')
  })

  it('rejects duplicates, bad urls, non-http schemes, and malformed field types', () => {
    const { servers, failedEntries } = parseExternalMcpServers([
      '{"name":"dup","url":"https://a.example/mcp"}',
      '{"name":"dup","url":"https://b.example/mcp"}',
      '{"name":"rel","url":"/mcp"}',
      '{"name":"scheme","url":"file:///etc/passwd"}',
      '{"name":"tok","url":"https://a.example/mcp","token":""}',
      '{"name":"hdr","url":"https://a.example/mcp","headers":{"x":1}}',
      'not json at all',
    ])
    expect(servers.map((s) => s.name)).toEqual(['dup'])
    const reasons = failedEntries.map((f) => f.reason)
    expect(reasons[0]).toContain('Duplicate namespace')
    expect(reasons[1]).toContain('absolute URL')
    expect(reasons[2]).toContain('http or https')
    expect(reasons[3]).toContain('"token" must be a non-empty string')
    expect(reasons[4]).toContain('"headers.x" must be a string')
    expect(reasons[5]).toContain('Not valid JSON')
  })

  it('reports every bad entry rather than stopping at the first', () => {
    const { failedEntries } = parseExternalMcpServers(['{"name":"c8y","url":"x"}', '{"url":"y"}'])
    expect(failedEntries).toHaveLength(2)
  })
})

describe('collectServerExternalMcpSources', () => {
  it('reads a single header value', () => {
    const headers = new Headers({ 'mc8yp-mcp-server': '{"name":"github","url":"https://a.example/mcp"}' })
    expect(parseExternalMcpServers(collectServerExternalMcpSources(headers)).servers.map((s) => s.name)).toEqual(['github'])
  })

  it('splits repeated headers that the HTTP layer joined with a comma', () => {
    const headers = new Headers()
    headers.append('mc8yp-mcp-server', '{"name":"github","url":"https://a.example/mcp"}')
    headers.append('mc8yp-mcp-server', '{"name":"linear","url":"https://b.example/mcp"}')
    // Headers.get() returns the RFC 9110 joined form — the split must recover both.
    expect(headers.get('mc8yp-mcp-server')).toContain('}, {')
    const { servers, failedEntries } = parseExternalMcpServers(collectServerExternalMcpSources(headers))
    expect(failedEntries).toEqual([])
    expect(servers.map((s) => s.name)).toEqual(['github', 'linear'])
  })

  it('does not split on commas or braces inside string values', () => {
    const headers = new Headers()
    headers.append('mc8yp-mcp-server', '{"name":"a","url":"https://a.example/mcp?q=x,y","token":"a,b{c}d\\"e"}')
    headers.append('mc8yp-mcp-server', '{"name":"b","url":"https://b.example/mcp"}')
    const { servers, failedEntries } = parseExternalMcpServers(collectServerExternalMcpSources(headers))
    expect(failedEntries).toEqual([])
    expect(servers[0]!.token).toBe('a,b{c}d"e')
    expect(servers[0]!.url).toBe('https://a.example/mcp?q=x,y')
    expect(servers.map((s) => s.name)).toEqual(['a', 'b'])
  })

  it('returns nothing when the header is absent', () => {
    expect(collectServerExternalMcpSources(new Headers())).toEqual([])
  })
})

describe('externalMcpHeaders', () => {
  it('turns token into a bearer header', () => {
    expect(externalMcpHeaders({ name: 'a', url: 'https://a.example/mcp', token: 't' })).toEqual({ authorization: 'Bearer t' })
  })

  it('lets an explicit header override the bearer shorthand', () => {
    expect(externalMcpHeaders({
      name: 'a',
      url: 'https://a.example/mcp',
      token: 't',
      headers: { 'authorization': 'Basic abc', 'x-api-key': 'k' },
    })).toEqual({ 'authorization': 'Basic abc', 'x-api-key': 'k' })
  })

  it('sends the configured credentials on the wire', async () => {
    const seen: Array<Record<string, string>> = []
    vi.stubGlobal('fetch', async (_url: string, init: globalThis.RequestInit) => {
      seen.push(init.headers as Record<string, string>)
      return new Response('{}', { headers: { 'content-type': 'application/json' } })
    })
    const external = createExternalMcpFetch({ name: 'a', url: 'https://a.example/mcp', token: 'secret' })
    await external('https://a.example/mcp', { method: 'POST', headers: { 'content-type': 'application/json' } })
    expect(seen[0]).toMatchObject({ 'authorization': 'Bearer secret', 'content-type': 'application/json' })
    vi.unstubAllGlobals()
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Namespace assembly
// ─────────────────────────────────────────────────────────────────────────

const TENANT_SPEC = {
  info: { title: 'Asset REST API' },
  paths: { '/service/asset-svc/assets': { get: { operationId: 'getAssets', summary: 'Retrieve assets' } } },
} as unknown as Spec

function capabilities(): TenantCapabilities {
  return {
    core: { paths: {} } as unknown as Spec,
    specs: { 'asset-svc': TENANT_SPEC },
    mcpServers: {},
  }
}

function externalServer(name: string, toolName = 'search_docs'): ExternalMcpServer {
  return {
    config: { name, url: `https://${name}.example/mcp`, token: 't' },
    tools: [{ name: toolName, description: 'Search the docs.', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } }],
    instructions: 'Mock instructions',
  }
}

describe('buildNamespaces with external MCP servers', () => {
  it('appends one namespace per external server, carrying its config for dispatch', () => {
    const namespaces = buildNamespaces(capabilities(), { externalServers: [externalServer('github')] })
    expect(namespaces.map((ns) => ns.name)).toEqual(['c8y', 'asset_svc', 'github'])

    const github = namespaces.find((ns) => ns.name === 'github') as McpNamespace
    expect(github.kind).toBe('mcp')
    expect(github.external).toEqual({ name: 'github', url: 'https://github.example/mcp', token: 't' })
    expect(github.tools.map((t) => t.name)).toEqual(['search_docs'])
    // Tenant auth must never be forwarded to a connection-supplied host.
    expect(github.server.sendAuthentication).toBe(false)
  })

  it('falls back to the handshake instructions when no description is configured', () => {
    const namespaces = buildNamespaces(capabilities(), { externalServers: [externalServer('github')] })
    expect((namespaces.find((ns) => ns.name === 'github') as McpNamespace).server.description).toBe('Mock instructions')
  })

  it('skips an external server whose name collides with a tenant namespace', () => {
    const namespaces = buildNamespaces(capabilities(), { externalServers: [externalServer('asset_svc')] })
    expect(namespaces.map((ns) => ns.name)).toEqual(['c8y', 'asset_svc'])
    // The surviving namespace is the tenant's spec-backed one, not the external.
    expect(namespaces.find((ns) => ns.name === 'asset_svc')!.kind).toBe('openapi')
  })

  it('is unaffected by the noMcp opt-out, which only picks between a service view', () => {
    const namespaces = buildNamespaces(capabilities(), {
      externalServers: [externalServer('github')],
      noMcp: { all: true, contextPaths: new Set() },
    })
    expect(namespaces.map((ns) => ns.name)).toContain('github')
  })

  it('marks external namespaces as external in the describe overview', () => {
    const namespaces = buildNamespaces(capabilities(), { externalServers: [externalServer('github')] })
    const overview = describeTarget(namespaces, getMethodIndex({}, () => toSearchableMethods(namespaces))).content
    expect(overview).toContain('- github — EXTERNAL MCP server at https://github.example/mcp — configured for this connection, NOT part of this tenant (1 methods)')
    // Tenant namespaces stay unlabelled: the backing protocol is still hidden.
    expect(overview).toContain('- asset_svc — Asset REST API (1 methods)')
  })

  it('repeats the external provenance on the method describe', () => {
    const namespaces = buildNamespaces(capabilities(), { externalServers: [externalServer('github')] })
    const output = describeTarget(namespaces, getMethodIndex({}, () => toSearchableMethods(namespaces)), 'github.search_docs')
    expect(output.kind).toBe('method')
    expect(output.content).toContain('External MCP server (https://github.example/mcp)')
    expect(output.content).toContain('tenant credentials are never sent')
    expect(output.content).toContain('Search the docs.')
  })

  it('exposes external methods to search without a REST identity', () => {
    const items = toSearchableMethods(buildNamespaces(capabilities(), { externalServers: [externalServer('github')] }))
    const hit = items.find((i) => i.target === 'github.search_docs')!
    expect(hit.summary).toBe('Search the docs.')
    expect(hit.httpMethod).toBeUndefined()
    expect(hit.apiPath).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Per-session tool-list cache
// ─────────────────────────────────────────────────────────────────────────

interface MockState {
  calls: Array<{ method: string | undefined, authorization: string | undefined }>
  failNext: boolean
}

function stubMcpTransport(): MockState {
  const state: MockState = { calls: [], failNext: false }
  vi.stubGlobal('fetch', async (_url: string, init: globalThis.RequestInit) => {
    const raw = init.body ? JSON.parse(String(init.body)) as { id?: number, method?: string } : undefined
    state.calls.push({
      method: raw?.method ?? init.method,
      authorization: (init.headers as Record<string, string> | undefined)?.authorization,
    })
    if (state.failNext)
      return new Response('nope', { status: 503, statusText: 'Service Unavailable' })
    const json = (result: unknown): Response =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: raw?.id, result }), { headers: { 'content-type': 'application/json' } })
    if (raw?.method === 'initialize')
      return json({ serverInfo: { name: 'mock' }, instructions: 'Mock instructions' })
    if (raw?.method === 'tools/list')
      return json({ tools: [{ name: 'search_docs', description: 'Search the docs.', inputSchema: { type: 'object' } }] })
    return new Response(null, { status: 202 })
  })
  return state
}

describe('resolveExternalMcpServers', () => {
  afterEach(() => {
    disposeAllExternalMcpSessions()
    vi.unstubAllGlobals()
  })

  const config = { name: 'github', url: 'https://github.example/mcp', token: 'ghp_x' }

  it('handshakes once per session and reuses the cached tool list', async () => {
    const state = stubMcpTransport()

    const first = await resolveExternalMcpServers('session-1', [config])
    expect(first.failures).toEqual([])
    expect(first.servers[0]!.tools.map((t) => t.name)).toEqual(['search_docs'])
    expect(first.servers[0]!.instructions).toBe('Mock instructions')
    expect(state.calls.filter((c) => c.method === 'tools/list')).toHaveLength(1)
    // The entry's own credentials are used for the discovery handshake.
    expect(state.calls[0]!.authorization).toBe('Bearer ghp_x')

    const second = await resolveExternalMcpServers('session-1', [config])
    expect(second.servers[0]!.tools).toHaveLength(1)
    expect(state.calls.filter((c) => c.method === 'tools/list')).toHaveLength(1)
  })

  it('keeps sessions isolated and re-handshakes after eviction', async () => {
    const state = stubMcpTransport()

    await resolveExternalMcpServers('session-1', [config])
    await resolveExternalMcpServers('session-2', [config])
    expect(state.calls.filter((c) => c.method === 'tools/list')).toHaveLength(2)
    expect(getExternalMcpSessionCount()).toBe(2)

    evictExternalMcpSession('session-1', 'session-close')
    expect(getExternalMcpSessionCount()).toBe(1)

    await resolveExternalMcpServers('session-1', [config])
    expect(state.calls.filter((c) => c.method === 'tools/list')).toHaveLength(3)
  })

  it('re-handshakes when the token or url changes mid-session', async () => {
    const state = stubMcpTransport()

    await resolveExternalMcpServers('session-1', [config])
    await resolveExternalMcpServers('session-1', [{ ...config, token: 'rotated' }])
    expect(state.calls.filter((c) => c.method === 'tools/list')).toHaveLength(2)
    expect(state.calls.at(-1)!.authorization).toBe('Bearer rotated')
  })

  it('reports an unreachable server as a failure and retries it on the next call', async () => {
    const state = stubMcpTransport()
    state.failNext = true

    const failed = await resolveExternalMcpServers('session-1', [config])
    expect(failed.servers).toEqual([])
    expect(failed.failures[0]).toMatchObject({ name: 'github', url: 'https://github.example/mcp' })
    expect(failed.failures[0]!.reason).toContain('503')

    // Failures are not cached: the next call tries again and succeeds.
    state.failNext = false
    const recovered = await resolveExternalMcpServers('session-1', [config])
    expect(recovered.failures).toEqual([])
    expect(recovered.servers).toHaveLength(1)
  })

  it('short-circuits with no configured servers and creates no session state', async () => {
    stubMcpTransport()
    const result = await resolveExternalMcpServers(CLI_EXTERNAL_MCP_SESSION, [])
    expect(result).toEqual({ servers: [], failures: [] })
    expect(getExternalMcpSessionCount()).toBe(0)
  })
})
