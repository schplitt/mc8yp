/**
 * Tests for keyring credential lookup in src/utils/credentials.ts.
 *
 * Regression coverage for issue #42: with two tenants stored,
 * getCredentialsByTenantUrl resolved to whichever entry the keyring listed
 * first instead of the requested tenant, so execute silently authenticated
 * against the wrong tenant while the banner reported the right one. Root
 * cause: findCredentialsAsync's second parameter filters by keyring target
 * (ignored on macOS, returns everything), not by account.
 */
import { Buffer } from 'node:buffer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createC8yAuthHeaders } from '../src/utils/client'
import { getCredentialsByTenantUrl, requestTfaSession, setStoredC8yAuth, TfaRequiredError } from '../src/utils/credentials'

interface FakeEntry { account: string, password: string }

let storedEntries: FakeEntry[] = []

// Mimic the macOS keychain behaviour that caused #42: the target argument
// is ignored and every entry for the service comes back, in storage order.
const findCredentialsAsync = vi.fn(async (_service: string, _target?: string | null) => storedEntries)

const setPassword = vi.fn(async (_value: string) => {})

vi.mock('@napi-rs/keyring', () => ({
  findCredentialsAsync: (...args: [string, (string | null)?]) => findCredentialsAsync(...args),
  AsyncEntry: class {
    setPassword(value: string) {
      return setPassword(value)
    }
  },
}))

function storeEntry(tenantUrl: string, user: string, tenantId: string): void {
  storedEntries.push({
    account: tenantUrl,
    password: JSON.stringify({ tenantUrl, user, password: `pw-${tenantId}`, tenantId }),
  })
}

describe('getCredentialsByTenantUrl', () => {
  beforeEach(() => {
    storedEntries = []
    findCredentialsAsync.mockClear()
  })

  it('returns the entry matching the requested tenant even when the keyring ignores the target filter (#42)', async () => {
    storeEntry('https://tenant-a.example.com', 'userA', 'tAAAAAAAAA')
    storeEntry('https://tenant-b.example.com', 'userB', 'tBBBBBBBBB')

    const credsB = await getCredentialsByTenantUrl('https://tenant-b.example.com')
    expect(credsB).toEqual({
      tenantUrl: 'https://tenant-b.example.com',
      user: 'userB',
      password: 'pw-tBBBBBBBBB',
      tenantId: 'tBBBBBBBBB',
    })

    const credsA = await getCredentialsByTenantUrl('https://tenant-a.example.com')
    expect(credsA.tenantId).toBe('tAAAAAAAAA')
    expect(credsA.user).toBe('userA')
  })

  it('matches accounts stored with a trailing slash against a cleaned URL', async () => {
    storeEntry('https://tenant-a.example.com', 'userA', 'tAAAAAAAAA')
    storeEntry('https://tenant-b.example.com/', 'userB', 'tBBBBBBBBB')

    const creds = await getCredentialsByTenantUrl('https://tenant-b.example.com/some/path')
    expect(creds.tenantId).toBe('tBBBBBBBBB')
    expect(creds.tenantUrl).toBe('https://tenant-b.example.com')
  })

  it('throws when no stored entry matches the requested tenant', async () => {
    storeEntry('https://tenant-a.example.com', 'userA', 'tAAAAAAAAA')

    await expect(getCredentialsByTenantUrl('https://tenant-c.example.com'))
      .rejects
      .toThrow('No stored credentials found for tenant URL: https://tenant-c.example.com')
  })
})

function fakeJwt(expSeconds: number): string {
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${part({ alg: 'RS256' })}.${part({ exp: expSeconds })}.sig`
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, statusText: status === 401 ? 'Unauthorized' : 'OK', headers: { 'Content-Type': 'application/json' } })
}

describe('TFA credentials', () => {
  const fetchMock = vi.fn<typeof fetch>()

  beforeEach(() => {
    storedEntries = []
    setPassword.mockClear()
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps the Basic-auth path unchanged for users without TFA', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { name: 't42' }))

    await setStoredC8yAuth({ tenantUrl: 'https://t.example.com/', user: 'u', password: 'p' })

    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toBe('https://t.example.com/tenant/currentTenant')
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`)
    const stored = JSON.parse(setPassword.mock.calls[0]![0])
    expect(stored).toEqual({ tenantUrl: 'https://t.example.com', user: 'u', password: 'p', tenantId: 't42' })

    storedEntries.push({ account: 'https://t.example.com', password: setPassword.mock.calls[0]![0] })
    const creds = await getCredentialsByTenantUrl('https://t.example.com')
    expect(creds).not.toHaveProperty('tfaSession')
    expect(createC8yAuthHeaders(creds)).toEqual({ Authorization: `Basic ${Buffer.from('t42/u:p').toString('base64')}` })
  })

  it('throws TfaRequiredError when the platform demands a TFA code on Basic login', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { message: 'Invalid credentials! : TFA TOTP code required.', error: 'security/Unauthorized' }))

    const err = await setStoredC8yAuth({ tenantUrl: 'https://t.example.com/', user: 'u', password: 'p' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TfaRequiredError)
    expect((err as Error).message).toContain('TFA TOTP code required')
    expect(setPassword).not.toHaveBeenCalled()
  })

  it('reports other login failures as plain errors with the platform message', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { message: 'Invalid credentials!' }))

    const err = await setStoredC8yAuth({ tenantUrl: 'https://t.example.com', user: 'u', password: 'p' }).catch((e: unknown) => e)
    expect(err).not.toBeInstanceOf(TfaRequiredError)
    expect((err as Error).message).toBe('Login failed: 401 Unauthorized — Invalid credentials!')
  })

  it('exchanges password + TFA code for a token and reads its expiry from the JWT', async () => {
    const exp = Math.floor(Date.now() / 1000) + 14 * 24 * 3600
    const token = fakeJwt(exp)
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { access_token: token }))

    const session = await requestTfaSession({ tenantUrl: 'https://t.example.com', user: 'u', password: 'p', tenantId: 't42' }, ' 123456 ')
    expect(session).toEqual({ token, expiresAt: exp * 1000 })

    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toBe('https://t.example.com/tenant/oauth/token?tenant_id=t42')
    expect(init?.method).toBe('POST')
    expect(Object.fromEntries(init?.body as URLSearchParams)).toEqual({
      grant_type: 'PASSWORD',
      username: 'u',
      password: 'p',
      tfa_code: '123456',
    })
  })

  it('refuses to follow redirects with the password in the body', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { access_token: fakeJwt(2_000_000_000) }))
    await requestTfaSession({ tenantUrl: 'https://t.example.com', user: 'u', password: 'p' }, '123456')
    expect(fetchMock.mock.calls[0]![1]?.redirect).toBe('error')

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { name: 't42' }))
    await setStoredC8yAuth({ tenantUrl: 'https://t.example.com', user: 'u', password: 'p' })
    expect(fetchMock.mock.calls[1]![1]?.redirect).toBe('error')
  })

  it('rejects a token that is already expired', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { access_token: fakeJwt(Math.floor(Date.now() / 1000) - 60) }))
    await expect(requestTfaSession({ tenantUrl: 'https://t.example.com', user: 'u', password: 'p' }, '123456'))
      .rejects
      .toThrow('already expired')
  })

  it('clamps an absurd expiry so it stays a valid date', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { access_token: fakeJwt(1e300) }))
    const session = await requestTfaSession({ tenantUrl: 'https://t.example.com', user: 'u', password: 'p' }, '123456')
    expect(session.expiresAt).toBeLessThanOrEqual(Date.now() + 366 * 24 * 3600_000)
    expect(() => new Date(session.expiresAt).toISOString()).not.toThrow()
  })

  it('stores the TFA session and resolves the tenant ID with the bearer token', async () => {
    const tfaSession = { token: fakeJwt(2_000_000_000), expiresAt: 2_000_000_000_000 }
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { name: 't42' }))

    await setStoredC8yAuth({ tenantUrl: 'https://t.example.com', user: 'u', password: 'p', tfaSession })

    const [, init] = fetchMock.mock.calls[0]!
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${tfaSession.token}`)
    expect(JSON.parse(setPassword.mock.calls[0]![0])).toEqual({
      tenantUrl: 'https://t.example.com',
      user: 'u',
      password: 'p',
      tenantId: 't42',
      tfaSession,
    })

    storedEntries.push({ account: 'https://t.example.com', password: setPassword.mock.calls[0]![0] })
    const creds = await getCredentialsByTenantUrl('https://t.example.com')
    expect(creds.tfaSession).toEqual(tfaSession)
    expect(createC8yAuthHeaders(creds)).toEqual({ Authorization: `Bearer ${tfaSession.token}` })
  })
})
