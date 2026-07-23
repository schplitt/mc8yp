/**
 * Tests for the CLI-only `status` tool in src/tools/status.ts.
 *
 * The tool is the entry point an LLM uses to see what tenant is active,
 * which credentials are stored, and what specs are visible to `query`
 * right now. Passing `refresh: true` forces a fresh discovery against the
 * active tenant; no-tenant is a noop.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { c8yMcpServer } from '../src/server-instance'
import { createStatusTool } from '../src/tools/status'
import { bustCapabilityCache } from '../src/utils/capability-discovery'

// Stub @c8y/client so the refresh path can build a client without a real
// HTTP stack. discovery itself is stubbed below.
vi.mock('@c8y/client', () => {
  class FakeBasicAuth {}
  class FakeClient {}
  return { BasicAuth: FakeBasicAuth, Client: FakeClient }
})

// refreshCapabilities walks the platform's application list and downloads spec
// files — replace with a deterministic fake so refresh tests stay
// hermetic.
let mockRefreshResult: { specs: Array<{ contextPath: string, appLabel: string, specLabel: string, servicePrefix: string, spec: unknown }>, mcpServers: never[], installedContextPaths: Set<string> }
  = { specs: [], mcpServers: [], installedContextPaths: new Set() }
let refreshShouldThrow = false

vi.mock('../src/utils/capability-discovery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/capability-discovery')>()
  return {
    ...actual,
    refreshCapabilities: vi.fn(async () => {
      if (refreshShouldThrow)
        throw new Error('discovery exploded')
      return mockRefreshResult
    }),
  }
})

// CLI tenant-context normally goes through keyring + BasicAuth + discovery.
// For tests we expose a tiny in-memory singleton and control it directly so
// each case can flip between "no tenant" and "tenant X active" cheaply.
let mockCliTenant: { tenantUrl: string, authorizationHeader: string, specs: { core: { paths: Record<string, unknown> }, specs: Record<string, unknown> } } | null = null
vi.mock('../src/cli/tenant-context', () => ({
  getCliTenantContext: () => mockCliTenant,
  clearCliTenantContext: () => {
    mockCliTenant = null
  },
  setCliTenantContext: vi.fn(),
}))

// tmcp's ctx is backed by AsyncLocalStorage; direct mutation outside a
// `ctx_storage.run()` is a no-op. Tests stub the getter so we can inject a
// synthetic custom context per case. The status tool also mutates
// `c8yMcpServer.ctx.custom.specs` on a successful refresh, so the stub
// returns a single shared object the tests can read back.
let ctxSpyRestore: (() => void) | null = null
let sharedCustom: Record<string, unknown> | undefined

function setCustomContext(overrides: Record<string, unknown>) {
  sharedCustom = {
    env: 'cli',
    restrictions: [],
    allowRules: [],
    ...overrides,
  }
  ctxSpyRestore?.()
  const spy = vi.spyOn(c8yMcpServer, 'ctx', 'get').mockReturnValue({
    get custom() {
      return sharedCustom
    },
    set custom(value: Record<string, unknown> | undefined) {
      sharedCustom = value
    },
  } as unknown as ReturnType<typeof c8yMcpServer['ctx']['valueOf']>)
  ctxSpyRestore = () => spy.mockRestore()
}

function clearCustomContext() {
  ctxSpyRestore?.()
  ctxSpyRestore = null
  sharedCustom = undefined
}

function setActiveCliTenant(tenantUrl: string): void {
  mockCliTenant = {
    tenantUrl,
    authorizationHeader: 'Basic xxx',
    specs: { core: { paths: {} }, specs: {} },
  }
}

async function callStatus(input: { refresh?: boolean } = {}): Promise<string> {
  const t = createStatusTool()
  const result = await t.execute(input)
  const content = (result as { content?: Array<{ type: string, text?: string }> }).content
  if (!content || content.length === 0)
    throw new Error('status tool returned no content')
  return content.map((c) => c.text ?? '').join('\n')
}

beforeEach(() => {
  bustCapabilityCache()
  mockCliTenant = null
  mockRefreshResult = { specs: [], mcpServers: [], installedContextPaths: new Set() }
  refreshShouldThrow = false
  globalThis._getStoredC8yAuth = vi.fn(async () => [])
  globalThis._getCredentialsByTenantUrl = vi.fn(async () => {
    throw new Error('no creds')
  })
})

afterEach(() => {
  clearCustomContext()
  vi.clearAllMocks()
})

describe('status tool', () => {
  it('shows the no-tenant state and the bundled-only fallback message', async () => {
    setCustomContext({ specs: { core: { paths: {} }, specs: {} } })
    const out = await callStatus({ refresh: false })
    expect(out).toContain('Active tenant: (none)')
    expect(out).toContain('Stored credentials: (none)')
    expect(out).not.toContain('Visible API namespaces')
  })

  it('is a noop when refresh:true is requested without an active tenant', async () => {
    setCustomContext({ specs: { core: { paths: {} }, specs: {} } })
    const out = await callStatus({ refresh: true })
    expect(out).toContain('no tenant is active')
    expect(out).toContain('nothing to refresh')
  })

  it('lists stored credentials and prompts for set-active-tenant when no tenant is active', async () => {
    globalThis._getStoredC8yAuth = vi.fn(async () => [
      { tenantUrl: 'https://a.cumulocity.com', tenantId: 'a1', user: 'u', password: 'p' },
      { tenantUrl: 'https://b.cumulocity.com', tenantId: 'b1', user: 'u', password: 'p' },
    ])
    setCustomContext({ specs: { core: { paths: {} }, specs: {} } })
    const out = await callStatus({ refresh: false })
    expect(out).toContain('https://a.cumulocity.com (tenantId: a1)')
    expect(out).toContain('https://b.cumulocity.com (tenantId: b1)')
    expect(out).toContain('call set-active-tenant')
  })

  it('does not list API namespaces — discovery belongs to the codemode tool', async () => {
    globalThis._getStoredC8yAuth = vi.fn(async () => [
      { tenantUrl: 'https://t1.cumulocity.com', tenantId: 't1', user: 'u', password: 'p' },
    ])
    setCustomContext({
      auth: { tenantUrl: 'https://t1.cumulocity.com', authorizationHeader: 'Basic xxx' },
      specs: { core: { paths: {} }, specs: { dtm: { paths: {} } } },
    })
    setActiveCliTenant('https://t1.cumulocity.com')

    const out = await callStatus({ refresh: false })
    expect(out).toContain('Active tenant: https://t1.cumulocity.com')
    expect(out).not.toContain('Visible API namespaces')
    expect(out).not.toContain('dtm')
  })

  it('runs a fresh discovery when refresh:true is requested with an active tenant', async () => {
    globalThis._getStoredC8yAuth = vi.fn(async () => [
      { tenantUrl: 'https://t1.cumulocity.com', tenantId: 't1', user: 'u', password: 'p' },
    ])
    globalThis._getCredentialsByTenantUrl = vi.fn(async () => ({
      tenantUrl: 'https://t1.cumulocity.com',
      tenantId: 't1',
      user: 'u',
      password: 'p',
    }))
    mockRefreshResult = {
      specs: [
        { contextPath: 'newsvc', appLabel: 'New Service', specLabel: 'New Service', servicePrefix: '/service/newsvc', spec: { paths: { '/service/newsvc/x': {} } } },
      ],
      mcpServers: [],
      installedContextPaths: new Set(['newsvc']),
    }
    setCustomContext({
      auth: { tenantUrl: 'https://t1.cumulocity.com', authorizationHeader: 'Basic xxx' },
      specs: { core: { paths: {} }, specs: {} },
    })
    setActiveCliTenant('https://t1.cumulocity.com')

    const out = await callStatus({ refresh: true })
    expect(out).toContain('Refreshed API discovery for https://t1.cumulocity.com')
    expect(out).toContain('1 spec(s) downloaded')
    expect(out).not.toContain('Visible API namespaces')
  })

  it('surfaces refresh failures without crashing the status output', async () => {
    globalThis._getStoredC8yAuth = vi.fn(async () => [
      { tenantUrl: 'https://t1.cumulocity.com', tenantId: 't1', user: 'u', password: 'p' },
    ])
    globalThis._getCredentialsByTenantUrl = vi.fn(async () => ({
      tenantUrl: 'https://t1.cumulocity.com',
      tenantId: 't1',
      user: 'u',
      password: 'p',
    }))
    refreshShouldThrow = true
    setCustomContext({
      auth: { tenantUrl: 'https://t1.cumulocity.com', authorizationHeader: 'Basic xxx' },
      specs: { core: { paths: {} }, specs: {} },
    })
    setActiveCliTenant('https://t1.cumulocity.com')

    const out = await callStatus({ refresh: true })
    expect(out).toContain('Refresh failed')
    expect(out).toContain('discovery exploded')
    // Even though refresh failed, the rest of the status should still render.
    expect(out).toContain('Active tenant: https://t1.cumulocity.com')
  })
})
