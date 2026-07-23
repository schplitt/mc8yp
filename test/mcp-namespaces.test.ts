import { describe, expect, it } from 'vitest'
import { describeTarget } from '../src/codemode/describe'
import { getMethodIndex } from '../src/codemode/method-search'
import { buildNamespaces, toSearchableMethods } from '../src/codemode/namespaces'
import { parseNoMcp } from '../src/utils/restrictions'
import type { DiscoveredMcpServer } from '../src/utils/capability-discovery'
import type { TenantCapabilities, Spec } from '../src/utils/capability-resolution'

const CORE_SPEC = { paths: {} } as unknown as Spec

const ASSET_SPEC = {
  info: { title: 'Asset REST API' },
  paths: {
    '/service/asset-svc/assets': { get: { operationId: 'getAssets', summary: 'Retrieve assets' } },
  },
} as unknown as Spec

const ASSET_MCP: DiscoveredMcpServer = {
  contextPath: 'asset-svc',
  appLabel: 'Asset Service',
  mcpName: 'asset-mcp',
  description: 'Asset management via MCP: hierarchy queries and bulk operations.',
  url: '/service/asset-svc/mcp',
  sendAuthentication: true,
  tools: [
    {
      name: 'get_assets',
      description: 'List assets with server-side hierarchy filtering.',
      inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Asset query expression.' } } },
      outputSchema: { type: 'object', properties: { assets: { type: 'array', items: { type: 'object' } } } },
    },
    { name: 'get-assets', description: 'sanitizes to get_assets — duplicate, skipped' },
  ],
}

function resolved(): TenantCapabilities {
  return { core: CORE_SPEC, specs: { 'asset-svc': ASSET_SPEC }, mcpServers: { 'asset-svc': ASSET_MCP } }
}

describe('parseNoMcp', () => {
  it('parses blanket opt-outs from empty, star, and boolean values', () => {
    expect(parseNoMcp([''])).toEqual({ all: true, contextPaths: new Set() })
    expect(parseNoMcp(['*'])).toEqual({ all: true, contextPaths: new Set() })
    expect(parseNoMcp([true])).toEqual({ all: true, contextPaths: new Set() })
    expect(parseNoMcp(['true'])).toEqual({ all: true, contextPaths: new Set() })
  })

  it('parses comma-separated contextPath lists across sources', () => {
    expect(parseNoMcp(['a, b', 'c'])).toEqual({ all: false, contextPaths: new Set(['a', 'b', 'c']) })
  })

  it('returns the no-op config for no sources', () => {
    expect(parseNoMcp([])).toEqual({ all: false, contextPaths: new Set() })
  })
})

describe('buildNamespaces with MCP servers', () => {
  it('prefers the MCP server over the OpenAPI spec', () => {
    const namespaces = buildNamespaces(resolved())
    const assetNs = namespaces.find((ns) => ns.name === 'asset_svc')!
    expect(assetNs.kind).toBe('mcp')
  })

  it('sanitizes tool names and skips duplicates', () => {
    const namespaces = buildNamespaces(resolved())
    const assetNs = namespaces.find((ns) => ns.name === 'asset_svc')!
    if (assetNs.kind !== 'mcp')
      throw new Error('expected mcp namespace')
    // get-assets sanitizes to the already-used get_assets and is skipped.
    expect(assetNs.tools.map((t) => t.name)).toEqual(['get_assets'])
    expect(assetNs.tools[0]!.toolName).toBe('get_assets')
  })

  it('falls back to the OpenAPI spec when the service is opted out', () => {
    const namespaces = buildNamespaces(resolved(), [], [], { all: false, contextPaths: new Set(['asset-svc']) })
    const assetNs = namespaces.find((ns) => ns.name === 'asset_svc')!
    expect(assetNs.kind).toBe('openapi')
    if (assetNs.kind === 'openapi')
      expect(assetNs.operations.map((o) => o.name)).toEqual(['getAssets'])
  })

  it('blanket opt-out disables every MCP namespace', () => {
    const namespaces = buildNamespaces(resolved(), [], [], { all: true, contextPaths: new Set() })
    expect(namespaces.every((ns) => ns.kind === 'openapi')).toBe(true)
  })

  it('drops the service entirely when opted out with no spec fallback', () => {
    const noSpec: TenantCapabilities = { core: CORE_SPEC, specs: {}, mcpServers: { 'asset-svc': ASSET_MCP } }
    const namespaces = buildNamespaces(noSpec, [], [], { all: true, contextPaths: new Set() })
    expect(namespaces.map((ns) => ns.name)).toEqual(['c8y'])
  })

  it('exposes no backing-protocol markers on searchable methods', () => {
    const items = toSearchableMethods(buildNamespaces(resolved()))
    const tool = items.find((i) => i.target === 'asset_svc.get_assets')!
    expect(tool.summary).toContain('server-side hierarchy filtering')
    // The agent must not be able to tell an MCP-backed method apart —
    // no kind field, no synthetic verb, no raw tool path.
    expect('kind' in tool).toBe(false)
    expect(tool.httpMethod).toBeUndefined()
    expect(tool.apiPath).toBeUndefined()
  })
})

describe('describeTarget for MCP namespaces', () => {
  const namespaces = buildNamespaces(resolved())
  const methodIndex = getMethodIndex({}, () => toSearchableMethods(namespaces))

  it('lists the MCP namespace in the overview with its description', () => {
    const output = describeTarget(namespaces, methodIndex)
    expect(output.content).toContain('asset_svc — asset-mcp (1 methods): Asset management via MCP')
  })

  it('renders lean types for an MCP tool target without protocol markers', () => {
    const output = describeTarget(namespaces, methodIndex, 'asset_svc.get_assets')
    expect(output.kind).toBe('method')
    expect(output.content).toContain('asset_svc.get_assets')
    expect(output.content).not.toMatch(/MCP/)
    expect(output.content).toContain('asset_svc.get_assets(input: GetAssetsInput): Promise<GetAssetsOutput>')
    expect(output.content).toContain('/** Asset query expression. */')
    expect(output.content).toContain('assets?:')
  })
})
