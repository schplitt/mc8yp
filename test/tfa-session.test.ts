/**
 * Tests for TFA session renewal in src/cli/tfa-session.ts: fresh sessions
 * pass through, expiring ones are renewed via MCP elicitation, and clients
 * without elicitation get an actionable error instead of a dead token.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { c8yMcpServer } from '../src/server-instance'
import { getFreshCliCredentials } from '../src/cli/tfa-session'
import type { UserC8yAuth } from '../src/utils/credentials'

const requestTfaSession = vi.fn()
const updateStoredTfaSession = vi.fn(async (creds: UserC8yAuth, tfaSession: UserC8yAuth['tfaSession']) => ({ ...creds, tfaSession }))

const TENANT = 'https://t.example.com'

function storedCreds(expiresAt?: number): UserC8yAuth {
  return {
    tenantUrl: TENANT,
    user: 'u',
    password: 'p',
    tenantId: 't42',
    ...(expiresAt === undefined ? {} : { tfaSession: { token: 'old', expiresAt } }),
  }
}

function stubClient(elicitation: boolean): void {
  vi.spyOn(c8yMcpServer, 'ctx', 'get').mockReturnValue({
    sessionInfo: { clientCapabilities: elicitation ? { elicitation: {} } : {} },
  } as unknown as typeof c8yMcpServer.ctx)
}

beforeEach(() => {
  requestTfaSession.mockReset()
  updateStoredTfaSession.mockClear()
  globalThis._requestTfaSession = requestTfaSession
  globalThis._updateStoredTfaSession = updateStoredTfaSession as typeof globalThis._updateStoredTfaSession
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('getFreshCliCredentials', () => {
  it('returns Basic-auth credentials untouched', async () => {
    globalThis._getCredentialsByTenantUrl = vi.fn(async () => storedCreds())
    await expect(getFreshCliCredentials(TENANT)).resolves.toEqual(storedCreds())
  })

  it('returns a TFA session that is still fresh without prompting', async () => {
    const fresh = storedCreds(Date.now() + 60 * 60_000)
    globalThis._getCredentialsByTenantUrl = vi.fn(async () => fresh)
    const elicit = vi.spyOn(c8yMcpServer, 'elicitation')

    await expect(getFreshCliCredentials(TENANT)).resolves.toBe(fresh)
    expect(elicit).not.toHaveBeenCalled()
  })

  it('explains how to renew from the shell when the client cannot elicit', async () => {
    globalThis._getCredentialsByTenantUrl = vi.fn(async () => storedCreds(Date.now() - 1000))
    stubClient(false)

    await expect(getFreshCliCredentials(TENANT)).rejects.toThrow(/expired at .*no elicitation support.*mc8yp creds add/)
  })

  it('asks for a new TFA code and stores the renewed session', async () => {
    globalThis._getCredentialsByTenantUrl = vi.fn(async () => storedCreds(Date.now() + 60_000))
    stubClient(true)
    const elicit = vi.spyOn(c8yMcpServer, 'elicitation').mockResolvedValue({ action: 'accept', content: { code: '123456' } } as never)
    const renewed = { token: 'new', expiresAt: Date.now() + 14 * 24 * 3600_000 }
    requestTfaSession.mockResolvedValue(renewed)

    const creds = await getFreshCliCredentials(TENANT)
    expect(elicit).toHaveBeenCalledOnce()
    const message = elicit.mock.calls[0]![0]
    expect(message).toContain(`acting as u on ${TENANT}`)
    expect(message).toContain('renews the assistant\'s access')
    expect(message).toContain('Decline if you did not expect this prompt')
    expect(requestTfaSession).toHaveBeenCalledWith(expect.objectContaining({ user: 'u', password: 'p', tenantId: 't42' }), '123456')
    expect(creds.tfaSession).toEqual(renewed)
  })

  it('prompts once for concurrent renewals of the same tenant', async () => {
    globalThis._getCredentialsByTenantUrl = vi.fn(async () => storedCreds(Date.now() - 1000))
    stubClient(true)
    const elicit = vi.spyOn(c8yMcpServer, 'elicitation').mockResolvedValue({ action: 'accept', content: { code: '123456' } } as never)
    requestTfaSession.mockResolvedValue({ token: 'new', expiresAt: Date.now() + 3600_000 })

    const [a, b] = await Promise.all([getFreshCliCredentials(TENANT), getFreshCliCredentials(TENANT)])
    expect(elicit).toHaveBeenCalledOnce()
    expect(a.tfaSession?.token).toBe('new')
    expect(b.tfaSession?.token).toBe('new')
  })

  it('fails with a clear message when the user declines the prompt', async () => {
    globalThis._getCredentialsByTenantUrl = vi.fn(async () => storedCreds(Date.now() - 1000))
    stubClient(true)
    vi.spyOn(c8yMcpServer, 'elicitation').mockResolvedValue({ action: 'decline' } as never)

    await expect(getFreshCliCredentials(TENANT)).rejects.toThrow('No TFA code was entered')
    expect(requestTfaSession).not.toHaveBeenCalled()
  })
})
