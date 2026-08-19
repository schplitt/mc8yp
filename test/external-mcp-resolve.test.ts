import { describe, expect, it, vi } from 'vitest'
import { resolveExternalMcpCandidates } from '../src/utils/external-mcp-resolve'
import { deriveExternalMcpNamespace } from '../src/utils/external-mcp'
import type { ExternalMcpServer } from '../src/codemode/external-mcp-session'
import type { ExternalMcpServerConfig } from '../src/utils/external-mcp'

// A probe that answers for every server, so a test only has to care about the
// resolution logic. The real one handshakes over HTTP (covered by e2e-mcp).
function stubProbe(
  tools: string[] = ['search'],
  extra: Partial<ExternalMcpServer> = {},
): (config: ExternalMcpServerConfig) => Promise<ExternalMcpServer> {
  return async (config) => ({
    config,
    tools: tools.map((name) => ({ name, description: `does ${name}` })),
    ...extra,
  })
}

const TENANT = ['c8y', 'dtm', 'knowledge_base_ms']

describe('deriveExternalMcpNamespace', () => {
  it('derives an identifier from a display name the same way a contextPath is derived', () => {
    expect(deriveExternalMcpNamespace('MaStR registry')).toBe('MaStR_registry')
    expect(deriveExternalMcpNamespace('knowledge-base-ms')).toBe('knowledge_base_ms')
    expect(deriveExternalMcpNamespace('weather.api v2')).toBe('weather_api_v2')
  })

  it('leaves a name that is already an identifier untouched', () => {
    expect(deriveExternalMcpNamespace('github')).toBe('github')
    expect(deriveExternalMcpNamespace('_internal$tool')).toBe('_internal$tool')
  })

  it('keeps the result a legal global: no leading digit, no JS keyword', () => {
    expect(deriveExternalMcpNamespace('2fast')).toBe('_2fast')
    expect(deriveExternalMcpNamespace('class')).toBe('class_')
  })
})

describe('resolveExternalMcpCandidates', () => {
  it('resolves a display name to its namespace and reports the tools the agent would get', async () => {
    const [result] = await resolveExternalMcpCandidates(
      [{ name: 'MaStR registry', url: 'https://mastr.example/mcp', token: 'secret' }],
      { tenantNamespaces: TENANT, probe: stubProbe(['search_units', 'get_unit']) },
    )

    expect(result).toMatchObject({
      name: 'MaStR registry',
      namespace: 'MaStR_registry',
      status: 'ok',
    })
    expect(result!.reason).toBeUndefined()
    expect(result!.tools).toEqual([
      { name: 'search_units', description: 'does search_units' },
      { name: 'get_unit', description: 'does get_unit' },
    ])
  })

  it('passes the entry to the probe with the DERIVED name, which is what the header will carry', async () => {
    const probe = vi.fn(stubProbe())
    await resolveExternalMcpCandidates(
      [{ name: 'MaStR registry', url: 'https://mastr.example/mcp' }],
      { tenantNamespaces: TENANT, probe },
    )

    expect(probe).toHaveBeenCalledWith(expect.objectContaining({ name: 'MaStR_registry' }))
  })

  it('reports the server\'s own identity and instructions when it answers', async () => {
    const [result] = await resolveExternalMcpCandidates(
      [{ name: 'github', url: 'https://api.githubcopilot.com/mcp/' }],
      {
        tenantNamespaces: TENANT,
        probe: stubProbe(['search'], { serverName: 'github-mcp', serverVersion: '1.2.3', instructions: 'Use for repos.' }),
      },
    )

    expect(result!.server).toEqual({ name: 'github-mcp', version: '1.2.3', instructions: 'Use for repos.' })
  })

  // The whole point of the route: a tenant namespace wins, so at runtime this
  // server is skipped and the agent silently does not have it.
  it('flags a namespace held by a tenant namespace as taken, not as ok', async () => {
    const [result] = await resolveExternalMcpCandidates(
      [{ name: 'dtm', url: 'https://third-party.example/mcp' }],
      { tenantNamespaces: TENANT, probe: stubProbe() },
    )

    expect(result).toMatchObject({ namespace: 'dtm', status: 'namespace-taken', namespaceTakenBy: 'tenant' })
    expect(result!.reason).toContain('already used by this tenant')
  })

  it('still reports the tools of a taken namespace, so renaming is the only fix needed', async () => {
    const [result] = await resolveExternalMcpCandidates(
      [{ name: 'knowledge base ms', url: 'https://third-party.example/mcp' }],
      { tenantNamespaces: TENANT, probe: stubProbe(['ask']) },
    )

    expect(result).toMatchObject({ namespace: 'knowledge_base_ms', status: 'namespace-taken' })
    expect(result!.tools).toEqual([{ name: 'ask', description: 'does ask' }])
  })

  it('flags a reserved namespace as taken by the sandbox, without probing it', async () => {
    const probe = vi.fn(stubProbe())
    const [result] = await resolveExternalMcpCandidates(
      [{ name: 'codemode', url: 'https://third-party.example/mcp' }],
      { tenantNamespaces: TENANT, probe },
    )

    expect(result).toMatchObject({ namespace: 'codemode', status: 'namespace-taken', namespaceTakenBy: 'reserved' })
    expect(probe).not.toHaveBeenCalled()
  })

  it('preserves casing, so two differently-cased names stay distinct namespaces', async () => {
    const results = await resolveExternalMcpCandidates(
      [
        { name: 'Weather API', url: 'https://a.example/mcp' },
        { name: 'weather-api', url: 'https://b.example/mcp' },
      ],
      { tenantNamespaces: TENANT, probe: stubProbe() },
    )

    // Derivation sanitizes, it does not lowercase: the agent-visible global is
    // as close to what the operator typed as a JS identifier allows.
    expect(results[0]).toMatchObject({ namespace: 'Weather_API', status: 'ok' })
    expect(results[1]).toMatchObject({ namespace: 'weather_api', status: 'ok' })
  })

  it('flags the second of two entries deriving the same namespace', async () => {
    const results = await resolveExternalMcpCandidates(
      [
        { name: 'weather api', url: 'https://a.example/mcp' },
        { name: 'weather-api', url: 'https://b.example/mcp' },
      ],
      { tenantNamespaces: TENANT, probe: stubProbe() },
    )

    expect(results[0]).toMatchObject({ namespace: 'weather_api', status: 'ok' })
    expect(results[1]).toMatchObject({ namespace: 'weather_api', status: 'namespace-taken', namespaceTakenBy: 'request' })
    expect(results[1]!.reason).toContain('Duplicate namespace')
  })

  // Everything the header path rejects must be rejected here too — a check that
  // green-lights an entry the header 400s would be worse than no check.
  it('reports a malformed entry as invalid, with the header path\'s own reason', async () => {
    const results = await resolveExternalMcpCandidates(
      [
        { name: 'no url' },
        { name: 'bad scheme', url: 'ftp://files.example/mcp' },
        { name: 'not absolute', url: '/mcp' },
        { name: 'bad headers', url: 'https://a.example/mcp', headers: { 'x-key': 42 } },
        { url: 'https://a.example/mcp' },
        'nonsense',
      ],
      { tenantNamespaces: TENANT, probe: stubProbe() },
    )

    expect(results.map((r) => r.status)).toEqual(['invalid', 'invalid', 'invalid', 'invalid', 'invalid', 'invalid'])
    expect(results[0]!.reason).toContain('"url" is required')
    expect(results[1]!.reason).toContain('http or https')
    expect(results[2]!.reason).toContain('absolute URL')
    expect(results[3]!.reason).toContain('"headers.x-key" must be a string')
    expect(results[4]!.reason).toContain('"name" is required')
    expect(results[5]!.reason).toContain('JSON object')
  })

  it('does not report a namespace for an entry that has no usable name', async () => {
    const [result] = await resolveExternalMcpCandidates([{ url: 'https://a.example/mcp' }], {
      tenantNamespaces: TENANT,
      probe: stubProbe(),
    })

    // `_` (sanitizeToolName's placeholder for an empty string) would look like a
    // namespace worth storing.
    expect(result!.namespace).toBe('')
  })

  it('reports an unreachable server as unreachable, carrying the handshake reason', async () => {
    const [result] = await resolveExternalMcpCandidates(
      [{ name: 'offline', url: 'https://offline.example/mcp' }],
      {
        tenantNamespaces: TENANT,
        probe: async () => {
          throw new Error('HTTP 401 Unauthorized')
        },
      },
    )

    expect(result).toMatchObject({ namespace: 'offline', status: 'unreachable', reason: 'HTTP 401 Unauthorized' })
    expect(result!.tools).toBeUndefined()
  })

  it('keeps namespace-taken as the status when a taken server is also unreachable', async () => {
    const [result] = await resolveExternalMcpCandidates(
      [{ name: 'dtm', url: 'https://offline.example/mcp' }],
      {
        tenantNamespaces: TENANT,
        probe: async () => {
          throw new Error('connect ECONNREFUSED')
        },
      },
    )

    expect(result!.status).toBe('namespace-taken')
    expect(result!.reason).toContain('already used by this tenant')
    expect(result!.reason).toContain('did not answer: connect ECONNREFUSED')
  })

  // Reporting "free" when the tenant list could not be fetched is exactly the
  // silent-skip failure this route removes, so the null case must stay visible
  // to the caller (the route puts it in `warnings`).
  it('skips the tenant check when the namespace list is unavailable', async () => {
    const [result] = await resolveExternalMcpCandidates(
      [{ name: 'dtm', url: 'https://third-party.example/mcp' }],
      { tenantNamespaces: null, probe: stubProbe() },
    )

    expect(result).toMatchObject({ namespace: 'dtm', status: 'ok' })
  })

  it('returns an empty list for an empty batch without probing anything', async () => {
    const probe = vi.fn(stubProbe())
    expect(await resolveExternalMcpCandidates([], { tenantNamespaces: TENANT, probe })).toEqual([])
    expect(probe).not.toHaveBeenCalled()
  })
})
