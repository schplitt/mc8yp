/**
 * Tests for the set-active-tenant tool's persistence order: the selection
 * is written only after activation succeeded, so a declined TFA prompt or a
 * failed discovery cannot make the next CLI restart switch tenants.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { c8yMcpServer } from '../src/server-instance'
import { createSetActiveTenantTool } from '../src/tools/active-tenant'

const writeActiveTenant = vi.fn()
const setCliTenantContext = vi.fn()

vi.mock('../src/cli/active-tenant', () => ({
  writeActiveTenant: (url: string) => writeActiveTenant(url),
  clearActiveTenant: () => {},
}))

vi.mock('../src/cli/tenant-context', () => ({
  setCliTenantContext: (url: string) => setCliTenantContext(url),
  clearCliTenantContext: () => {},
}))

const TENANT = 'https://t.example.com'

beforeEach(() => {
  writeActiveTenant.mockReset()
  setCliTenantContext.mockReset()
  globalThis._getStoredC8yAuth = vi.fn(async () => [{ tenantUrl: TENANT, user: 'u', password: 'p', tenantId: 't' }])
  vi.spyOn(c8yMcpServer, 'ctx', 'get').mockReturnValue({ custom: { env: 'cli' } } as unknown as typeof c8yMcpServer.ctx)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('set-active-tenant', () => {
  it('does not persist the selection when activation fails', async () => {
    setCliTenantContext.mockRejectedValue(new Error('No TFA code was entered.'))

    const result = await createSetActiveTenantTool().execute({ tenantUrl: TENANT }) as { isError?: boolean }
    expect(result.isError).toBe(true)
    expect(writeActiveTenant).not.toHaveBeenCalled()
  })

  it('persists the selection after activation succeeded', async () => {
    setCliTenantContext.mockResolvedValue({ tenantUrl: TENANT, authorizationHeader: 'Bearer x', specs: { core: {}, specs: {} } })

    await createSetActiveTenantTool().execute({ tenantUrl: TENANT })
    expect(writeActiveTenant).toHaveBeenCalledWith(TENANT)
  })
})
