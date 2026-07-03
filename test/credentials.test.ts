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
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getCredentialsByTenantUrl } from '../src/utils/credentials'

interface FakeEntry { account: string, password: string }

let storedEntries: FakeEntry[] = []

// Mimic the macOS keychain behaviour that caused #42: the target argument
// is ignored and every entry for the service comes back, in storage order.
const findCredentialsAsync = vi.fn(async (_service: string, _target?: string | null) => storedEntries)

vi.mock('@napi-rs/keyring', () => ({
  findCredentialsAsync: (...args: [string, (string | null)?]) => findCredentialsAsync(...args),
  AsyncEntry: class {},
}))

// credentials.ts imports @c8y/client for tenant-id resolution on store;
// stub it so the module loads without a real HTTP stack.
vi.mock('@c8y/client', () => ({ Client: class {} }))

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
