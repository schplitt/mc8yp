/**
 * End-to-end MCP wrapping tests. Topology per test:
 *
 *   test MCP client ══MCP/HTTP══▶ mc8yp (HttpTransport + c8yMcpServer over
 *    (McpHttpClient,               srvx, custom context injected the same way
 *     emulating the AI host)       src/index.ts does)
 *                                        │ codemode tool → sandbox
 *                                        ▼
 *                          mock downstream MCP server (tmcp + srvx)
 *
 * The downstream mock is a real tmcp server; the upstream connection uses
 * mc8yp's own minimal MCP client — the feature client is exercised from both
 * sides of the middleman.
 */
import { serve } from 'srvx'
import { HttpTransport } from '@tmcp/transport-http'
import { McpServer } from 'tmcp'
import { ValibotJsonSchemaAdapter } from '@tmcp/adapter-valibot'
import * as v from 'valibot'
import { afterAll, describe, expect, it } from 'vitest'
import { disposeSandbox } from '../src/codemode/execute'
import { c8yMcpServer, setupMcpServer } from '../src/server'
import { McpHttpClient } from '../src/utils/mcp-client'
import type { DiscoveredMcpServer } from '../src/utils/capability-discovery'
import type { C8yMcpCustomContext } from '../src/types/mcp-context'
import type { Spec } from '../src/utils/capability-resolution'

const closers: Array<() => Promise<unknown> | unknown> = []

afterAll(async () => {
  for (const close of closers.reverse()) await close()
  await disposeSandbox()
})

// ─────────────────────────────────────────────────────────────────────────
// Mock downstream MCP server (tmcp + srvx)
// ─────────────────────────────────────────────────────────────────────────

interface MockDownstream {
  url: string
  lastAuthorization: string | null | undefined
}

async function startMockDownstream(): Promise<MockDownstream> {
  const mock = new McpServer(
    { name: 'asset-mcp', version: '1.0.0', description: 'Mock asset MCP server' },
    { adapter: new ValibotJsonSchemaAdapter(), capabilities: { tools: { listChanged: false } } },
  )
  mock.tool({
    name: 'get_assets',
    description: 'List assets with server-side hierarchy filtering.',
    schema: v.object({ query: v.optional(v.string()) }),
  }, ({ query }) => ({
    content: [{ type: 'text', text: JSON.stringify({ assets: [{ id: '1', name: 'Borkum' }], query: query ?? null }) }],
  }))
  mock.tool({
    name: 'needs_user_input',
    description: 'Attempts an elicitation — must fail cleanly through mc8yp.',
  }, async () => {
    // mc8yp advertises no elicitation capability, so tmcp rejects this
    // before it ever reaches the wire.
    await mock.elicitation('Please provide input', v.object({ value: v.string() }))
    return { content: [{ type: 'text', text: 'unreachable' }] }
  })

  const transport = new HttpTransport(mock, { path: '/mcp', disableSse: true })
  const state: { lastAuthorization: string | null | undefined } = { lastAuthorization: undefined }
  const server = serve({
    port: 0,
    fetch: async (req: Request) => {
      state.lastAuthorization = req.headers.get('authorization')
      return await transport.respond(req) ?? new Response('not found', { status: 404 })
    },
  })
  await server.ready()
  closers.push(() => server.close())
  return {
    get url() {
      return server.url!.replace(/\/$/, '')
    },
    get lastAuthorization() {
      return state.lastAuthorization
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────
// mc8yp mounted over srvx with injected per-request context — the same
// seam src/index.ts uses, minus Cumulocity discovery.
// ─────────────────────────────────────────────────────────────────────────

async function startMc8yp(context: () => C8yMcpCustomContext): Promise<string> {
  setupMcpServer('server')
  const transport = new HttpTransport(c8yMcpServer, { path: '/mcp', disableSse: true })
  const server = serve({
    port: 0,
    fetch: async (req: Request) => await transport.respond(req, context()) ?? new Response('not found', { status: 404 }),
  })
  await server.ready()
  closers.push(() => server.close())
  return server.url!.replace(/\/$/, '')
}

function agentClient(mc8ypUrl: string): McpHttpClient {
  return new McpHttpClient({
    url: `${mc8ypUrl}/mcp`,
    fetch: (path, init) => fetch(path, init),
  })
}

function contextFor(downstream: MockDownstream, tools: DiscoveredMcpServer['tools'], overrides: Partial<C8yMcpCustomContext> = {}): C8yMcpCustomContext {
  const mcpServer: DiscoveredMcpServer = {
    contextPath: 'asset-svc',
    appLabel: 'Asset Service',
    mcpName: 'asset-mcp',
    description: 'Asset management via MCP.',
    url: '/mcp',
    sendAuthentication: true,
    tools,
  }
  const assetSpec = {
    info: { title: 'Asset REST API' },
    paths: { '/service/asset-svc/assets': { get: { operationId: 'getAssets', summary: 'Retrieve assets (REST fallback)' } } },
  } as unknown as Spec
  return {
    env: 'server',
    restrictions: [],
    allowRules: [],
    // tenantUrl points at the mock so the tenant-relative MCP url resolves
    // to the downstream server.
    auth: { tenantUrl: downstream.url, authorizationHeader: 'Bearer e2e-user' },
    specs: {
      core: { paths: {} } as unknown as Spec,
      specs: { 'asset-svc': assetSpec },
      mcpServers: { 'asset-svc': mcpServer },
    },
    ...overrides,
  }
}

async function runCodemode(client: McpHttpClient, code: string): Promise<string> {
  const result = await client.callTool('codemode', { code })
  return typeof result === 'string' ? result : JSON.stringify(result)
}

// ─────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────

describe('e2e: MCP servers wrapped as codemode namespaces', () => {
  it('runs the full middleman flow: discovery, describe, tool call, escape hatch, auth forwarding', async () => {
    const downstream = await startMockDownstream()

    // Fetch the downstream tool list with the same client discovery uses.
    const discoveryClient = new McpHttpClient({ url: `${downstream.url}/mcp`, fetch: (path, init) => fetch(path, init) })
    const tools = await discoveryClient.listTools()
    await discoveryClient.close()
    expect(tools.map((t) => t.name)).toEqual(['get_assets', 'needs_user_input'])

    let context = contextFor(downstream, tools)
    const mc8ypUrl = await startMc8yp(() => context)
    const client = agentClient(mc8ypUrl)

    // The AI host sees mc8yp's single codemode tool.
    const mc8ypTools = await client.listTools()
    expect(mc8ypTools.map((t) => t.name)).toContain('codemode')

    // Overview lists the MCP namespace.
    const overview = await runCodemode(client, 'async () => (await codemode.describe()).content')
    expect(overview).toContain('asset_svc — asset-mcp (2 methods)')

    // Search finds the MCP tool, describe renders its types.
    const discovery = await runCodemode(client, `async () => {
      const { results } = await codemode.search('assets hierarchy')
      const hit = results.find((r) => r.target === 'asset_svc.get_assets')
      const method = await codemode.describe('asset_svc.get_assets')
      return {
        found: !!hit,
        // The backing protocol must be invisible: no kind, no synthetic verb.
        leaks: hit ? Object.keys(hit).filter((k) => k === 'kind').length + (hit.httpMethod === 'MCP' ? 1 : 0) : -1,
        hasTypes: method.content.includes('GetAssetsInput'),
      }
    }`)
    expect(discovery).toContain('found: true')
    expect(discovery).toContain('leaks: 0')
    expect(discovery).toContain('hasTypes: true')

    // Typed method call end to end; no escape hatch exists on any namespace.
    const calls = await runCodemode(client, `async () => {
      const typed = await asset_svc.get_assets({ query: 'inHierarchyOf(root)' })
      return {
        typedName: typed.assets[0].name,
        typedQuery: typed.query,
        noMcpHatch: typeof asset_svc.callTool,
        noRestHatch: typeof c8y.request,
      }
    }`)
    expect(calls).toContain('typedName: Borkum')
    expect(calls).toContain('typedQuery: inHierarchyOf(root)')
    expect(calls).toContain('noMcpHatch: undefined')
    expect(calls).toContain('noRestHatch: undefined')

    // The end user's Authorization header reached the downstream server.
    expect(downstream.lastAuthorization).toBe('Bearer e2e-user')

    // Elicitation is declined by design: mc8yp advertises no capability, so
    // the downstream tmcp server rejects the tool's elicitation attempt.
    const declined = await runCodemode(client, `async () => {
      try {
        await asset_svc.needs_user_input({})
        return 'unexpected success'
      } catch (error) {
        return 'failed: ' + error.message
      }
    }`)
    expect(declined).toContain('failed:')
    expect(declined).toMatch(/elicitation/i)

    // noMcp opt-out: same connection config, spec fallback takes over.
    context = contextFor(downstream, tools, { noMcp: { all: true, contextPaths: new Set() } })
    const fallback = await runCodemode(client, 'async () => (await codemode.describe()).content')
    expect(fallback).toContain('asset_svc — Asset REST API (1 methods)')
    expect(fallback).not.toContain('asset-mcp')

    await client.close()
  }, 60_000)
})
