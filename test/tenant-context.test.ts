/**
 * Tests for TFA renewal in src/cli/tenant-context.ts: the renewal may wait
 * on the user (elicitation), so a tenant switch that lands meanwhile must
 * win — the renewed tenant's auth must not be written back over it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { c8yMcpServer } from '../src/server-instance'
import { getCliTenantContext, renewCliTenantAuthIfExpiring, setCliTenantContext } from '../src/cli/tenant-context'
import type { UserC8yAuth } from '../src/utils/credentials'

const getFreshCliCredentials = vi.fn<(tenantUrl: string) => Promise<UserC8yAuth>>()

vi.mock('../src/cli/tfa-session', () => ({
  TFA_REFRESH_MARGIN_MS: 5 * 60_000,
  createCliClient: () => ({}),
  getFreshCliCredentials: (tenantUrl: string) => getFreshCliCredentials(tenantUrl),
}))

vi.mock('../src/utils/capability-discovery', () => ({
  startDiscovery: async () => ({ specs: [], installedContextPaths: new Set(), mcpServers: [] }),
}))

const A = 'https://a.example.com'
const B = 'https://b.example.com'

function creds(tenantUrl: string, token: string, expiresAt: number): UserC8yAuth {
  return { tenantUrl, user: 'u', password: 'p', tenantId: tenantUrl === A ? 'tA' : 'tB', tfaSession: { token, expiresAt } }
}

let custom: Record<string, unknown>

beforeEach(() => {
  custom = { env: 'cli' }
  vi.spyOn(c8yMcpServer, 'ctx', 'get').mockReturnValue({ custom } as unknown as typeof c8yMcpServer.ctx)
  getFreshCliCredentials.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('renewCliTenantAuthIfExpiring', () => {
  it('updates the active tenant auth after a renewal', async () => {
    getFreshCliCredentials.mockResolvedValueOnce(creds(A, 'old', Date.now() + 60_000))
    await setCliTenantContext(A)

    getFreshCliCredentials.mockResolvedValueOnce(creds(A, 'renewed', Date.now() + 3600_000))
    await renewCliTenantAuthIfExpiring()

    expect(getCliTenantContext()?.authorizationHeader).toBe('Bearer renewed')
    expect(custom.auth).toEqual({ tenantUrl: A, authorizationHeader: 'Bearer renewed' })
  })

  it('does not write the old tenant back when the tenant switched during the prompt', async () => {
    getFreshCliCredentials.mockResolvedValueOnce(creds(A, 'a-old', Date.now() + 60_000))
    await setCliTenantContext(A)

    // Renewal for A blocks (user is answering the prompt) ...
    let finishRenewal!: (c: UserC8yAuth) => void
    getFreshCliCredentials.mockReturnValueOnce(new Promise((resolve) => {
      finishRenewal = resolve
    }))
    const renewal = renewCliTenantAuthIfExpiring()

    // ... meanwhile set-active-tenant switches to B.
    getFreshCliCredentials.mockResolvedValueOnce(creds(B, 'b-token', Date.now() + 3600_000))
    const ctxB = await setCliTenantContext(B)
    custom.auth = { tenantUrl: B, authorizationHeader: ctxB.authorizationHeader }

    finishRenewal(creds(A, 'a-renewed', Date.now() + 3600_000))
    await renewal

    expect(getCliTenantContext()?.tenantUrl).toBe(B)
    expect(custom.auth).toEqual({ tenantUrl: B, authorizationHeader: 'Bearer b-token' })
  })
})
