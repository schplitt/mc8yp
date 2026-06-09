import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { clearActiveTenant as ClearFn, readActiveTenantUrl as ReadFn, writeActiveTenant as WriteFn } from '../src/cli/active-tenant'

const TEST_CONFIG_DIR = join(tmpdir(), `mc8yp-test-${process.pid}`)
const TEST_MC8YP_DIR = join(TEST_CONFIG_DIR, '.config', 'mc8yp')
const TEST_CONFIG_FILE = join(TEST_MC8YP_DIR, 'active-tenant.json')

vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:os')>()
  return { ...original, homedir: () => TEST_CONFIG_DIR }
})

let writeActiveTenant: typeof WriteFn
let readActiveTenantUrl: typeof ReadFn
let clearActiveTenant: typeof ClearFn

beforeAll(async () => {
  // Import after mock is registered so the module picks up the stubbed homedir.
  const mod = await import('../src/cli/active-tenant')
  writeActiveTenant = mod.writeActiveTenant
  readActiveTenantUrl = mod.readActiveTenantUrl
  clearActiveTenant = mod.clearActiveTenant
})

describe('writeActiveTenant / readActiveTenantUrl', () => {
  beforeEach(() => {
    mkdirSync(TEST_CONFIG_DIR, { recursive: true })
  })

  afterEach(() => {
    rmSync(TEST_CONFIG_DIR, { recursive: true, force: true })
  })

  it('round-trips a tenant URL', () => {
    writeActiveTenant('https://example.cumulocity.com')
    expect(readActiveTenantUrl()).toBe('https://example.cumulocity.com')
  })

  it('overwrites a previous value', () => {
    writeActiveTenant('https://first.cumulocity.com')
    writeActiveTenant('https://second.cumulocity.com')
    expect(readActiveTenantUrl()).toBe('https://second.cumulocity.com')
  })

  it('returns null when the config file does not exist', () => {
    expect(readActiveTenantUrl()).toBeNull()
  })

  it('returns null when the file contains invalid JSON', () => {
    mkdirSync(TEST_MC8YP_DIR, { recursive: true })
    writeFileSync(TEST_CONFIG_FILE, 'not-json', 'utf8')
    expect(readActiveTenantUrl()).toBeNull()
  })

  it('returns null when the file has valid JSON but wrong shape', () => {
    mkdirSync(TEST_MC8YP_DIR, { recursive: true })
    writeFileSync(TEST_CONFIG_FILE, JSON.stringify({ notTenantUrl: 'oops' }), 'utf8')
    expect(readActiveTenantUrl()).toBeNull()
  })

  it('returns null when the file holds an explicit { tenantUrl: null } marker', () => {
    mkdirSync(TEST_MC8YP_DIR, { recursive: true })
    writeFileSync(TEST_CONFIG_FILE, JSON.stringify({ tenantUrl: null }), 'utf8')
    expect(readActiveTenantUrl()).toBeNull()
  })
})

describe('clearActiveTenant', () => {
  beforeEach(() => {
    mkdirSync(TEST_CONFIG_DIR, { recursive: true })
  })

  afterEach(() => {
    rmSync(TEST_CONFIG_DIR, { recursive: true, force: true })
  })

  it('writes the explicit null marker so readActiveTenantUrl returns null', () => {
    writeActiveTenant('https://example.cumulocity.com')
    clearActiveTenant()
    expect(readActiveTenantUrl()).toBeNull()
  })

  it('is idempotent when no active tenant was ever set', () => {
    clearActiveTenant()
    clearActiveTenant()
    expect(readActiveTenantUrl()).toBeNull()
  })

  it('creates the config directory if it does not exist yet', () => {
    rmSync(TEST_CONFIG_DIR, { recursive: true, force: true })
    clearActiveTenant()
    expect(readActiveTenantUrl()).toBeNull()
  })
})
