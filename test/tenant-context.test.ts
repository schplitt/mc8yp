/**
 * Tests for TFA renewal in src/cli/tenant-context.ts: the renewal may wait
 * on the user (elicitation), so a tenant switch that lands meanwhile must
 * win — the renewed tenant's auth must not be written back over it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { c8yMcpServer } from '../src/server-instance'
import { clearCliTenantContext, ensureCliTenantReady, getCliTenantContext, getPendingCliTenantUrl, restoreCliTenantContext, setCliTenantContext } from '../src/cli/tenant-context'
import type { UserC8yAuth } from '../src/utils/credentials'

const getFreshCliCredentials = vi.fn<(tenantUrl: string) => Promise<UserC8yAuth>>()

vi.mock('../src/cli/tfa-session', () => ({
  TFA_REFRESH_MARGIN_MS: 5 * 60_000,
  createCliClient: () => ({}),
  getFreshCliCredentials: (tenantUrl: string) => getFreshCliCredentials(tenantUrl),
}))

const startDiscovery = vi.fn(async () => ({ specs: [], installedContextPaths: new Set(), mcpServers: [] }))

vi.mock('../src/utils/capability-discovery', () => ({
  startDiscovery: () => startDiscovery(),
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
  startDiscovery.mockClear()
  clearCliTenantContext()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('restoreCliTenantContext (CLI startup)', () => {
  it('activates a tenant whose TFA session is still valid', async () => {
    globalThis._getCredentialsByTenantUrl = vi.fn(async () => creds(A, 'valid', Date.now() + 3600_000))
    getFreshCliCredentials.mockResolvedValueOnce(creds(A, 'valid', Date.now() + 3600_000))

    const ctx = await restoreCliTenantContext(A)
    expect(ctx?.authorizationHeader).toBe('Bearer valid')
    expect(getPendingCliTenantUrl()).toBeNull()
  })

  it('leaves a tenant with an expired TFA session pending, without prompting or discovery', async () => {
    globalThis._getCredentialsByTenantUrl = vi.fn(async () => creds(A, 'old', Date.now() - 1000))

    await expect(restoreCliTenantContext(A)).resolves.toBeNull()
    expect(getPendingCliTenantUrl()).toBe(A)
    expect(getCliTenantContext()).toBeNull()
    expect(getFreshCliCredentials).not.toHaveBeenCalled()
    expect(startDiscovery).not.toHaveBeenCalled()
  })
})

describe('ensureCliTenantReady', () => {
  it('activates a pending tenant on the first call: prompts, discovers, publishes auth and specs', async () => {
    globalThis._getCredentialsByTenantUrl = vi.fn(async () => creds(A, 'old', Date.now() - 1000))
    await restoreCliTenantContext(A)

    getFreshCliCredentials.mockResolvedValueOnce(creds(A, 'renewed', Date.now() + 3600_000))
    await ensureCliTenantReady()

    expect(getFreshCliCredentials).toHaveBeenCalledWith(A)
    expect(startDiscovery).toHaveBeenCalledOnce()
    expect(getPendingCliTenantUrl()).toBeNull()
    expect(getCliTenantContext()?.authorizationHeader).toBe('Bearer renewed')
    expect(custom.auth).toEqual({ tenantUrl: A, authorizationHeader: 'Bearer renewed' })
    expect(custom.specs).toBe(getCliTenantContext()?.specs)
  })

  it('keeps the tenant pending and throws when no code was entered, so the call does not run', async () => {
    globalThis._getCredentialsByTenantUrl = vi.fn(async () => creds(A, 'old', Date.now() - 1000))
    await restoreCliTenantContext(A)

    getFreshCliCredentials.mockRejectedValueOnce(new Error('No TFA code was entered.'))
    await expect(ensureCliTenantReady()).rejects.toThrow('No TFA code was entered.')
    expect(getPendingCliTenantUrl()).toBe(A)
    expect(custom.auth).toBeUndefined()
  })

  it('lets set-active-tenant win over a pending activation that is still waiting', async () => {
    globalThis._getCredentialsByTenantUrl = vi.fn(async () => creds(A, 'old', Date.now() - 1000))
    await restoreCliTenantContext(A)

    let finish!: (c: UserC8yAuth) => void
    getFreshCliCredentials.mockReturnValueOnce(new Promise((resolve) => {
      finish = resolve
    }))
    const activation = ensureCliTenantReady()

    getFreshCliCredentials.mockResolvedValueOnce(creds(B, 'b-token', Date.now() + 3600_000))
    await setCliTenantContext(B)

    finish(creds(A, 'a-renewed', Date.now() + 3600_000))
    await activation
    expect(getCliTenantContext()?.tenantUrl).toBe(B)
    expect(custom.auth).toBeUndefined()
  })

  it('updates the active tenant auth after a renewal', async () => {
    getFreshCliCredentials.mockResolvedValueOnce(creds(A, 'old', Date.now() + 60_000))
    await setCliTenantContext(A)

    getFreshCliCredentials.mockResolvedValueOnce(creds(A, 'renewed', Date.now() + 3600_000))
    await ensureCliTenantReady()

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
    const renewal = ensureCliTenantReady()

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
