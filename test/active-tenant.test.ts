import { createHash } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { clearActiveTenant as ClearFn, readActiveTenantUrl as ReadFn, writeActiveTenant as WriteFn } from '../src/cli/active-tenant'

const TEST_CONFIG_DIR = join(tmpdir(), `mc8yp-test-${process.pid}`)
const TEST_MC8YP_DIR = join(TEST_CONFIG_DIR, '.config', 'mc8yp', 'active-tenants')
const LEGACY_CONFIG_FILE = join(TEST_CONFIG_DIR, '.config', 'mc8yp', 'active-tenant.json')
const CWD = '/projects/a'
const TEST_CONFIG_FILE = join(TEST_MC8YP_DIR, `${createHash('sha256').update(CWD).digest('hex').slice(0, 32)}.json`)

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
    writeActiveTenant('https://example.cumulocity.com', CWD)
    expect(readActiveTenantUrl(CWD)).toBe('https://example.cumulocity.com')
  })

  it('overwrites a previous value', () => {
    writeActiveTenant('https://first.cumulocity.com', CWD)
    writeActiveTenant('https://second.cumulocity.com', CWD)
    expect(readActiveTenantUrl(CWD)).toBe('https://second.cumulocity.com')
  })

  it('returns null when the config file does not exist', () => {
    expect(readActiveTenantUrl(CWD)).toBeNull()
  })

  it('returns null when the file contains invalid JSON', () => {
    mkdirSync(TEST_MC8YP_DIR, { recursive: true })
    writeFileSync(TEST_CONFIG_FILE, 'not-json', 'utf8')
    expect(readActiveTenantUrl(CWD)).toBeNull()
  })

  it('returns null when the file has valid JSON but wrong shape', () => {
    mkdirSync(TEST_MC8YP_DIR, { recursive: true })
    writeFileSync(TEST_CONFIG_FILE, JSON.stringify({ cwd: CWD, notTenantUrl: 'oops' }), 'utf8')
    expect(readActiveTenantUrl(CWD)).toBeNull()
  })

  it('returns null when the file holds an explicit { tenantUrl: null } marker', () => {
    mkdirSync(TEST_MC8YP_DIR, { recursive: true })
    writeFileSync(TEST_CONFIG_FILE, JSON.stringify({ cwd: CWD, tenantUrl: null }), 'utf8')
    expect(readActiveTenantUrl(CWD)).toBeNull()
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
    writeActiveTenant('https://example.cumulocity.com', CWD)
    clearActiveTenant(CWD)
    expect(readActiveTenantUrl(CWD)).toBeNull()
  })

  it('is idempotent when no active tenant was ever set', () => {
    clearActiveTenant(CWD)
    clearActiveTenant(CWD)
    expect(readActiveTenantUrl(CWD)).toBeNull()
  })

  it('creates the config directory if it does not exist yet', () => {
    rmSync(TEST_CONFIG_DIR, { recursive: true, force: true })
    clearActiveTenant(CWD)
    expect(readActiveTenantUrl(CWD)).toBeNull()
  })
})

describe('per-directory scoping', () => {
  afterEach(() => {
    rmSync(TEST_CONFIG_DIR, { recursive: true, force: true })
  })

  it('keeps separate tenants per working directory', () => {
    writeActiveTenant('https://a.cumulocity.com', '/projects/a')
    writeActiveTenant('https://b.cumulocity.com', '/projects/b')
    expect(readActiveTenantUrl('/projects/a')).toBe('https://a.cumulocity.com')
    expect(readActiveTenantUrl('/projects/b')).toBe('https://b.cumulocity.com')
  })

  it('clearing one directory leaves the others alone', () => {
    writeActiveTenant('https://a.cumulocity.com', '/projects/a')
    writeActiveTenant('https://b.cumulocity.com', '/projects/b')
    clearActiveTenant('/projects/a')
    expect(readActiveTenantUrl('/projects/a')).toBeNull()
    expect(readActiveTenantUrl('/projects/b')).toBe('https://b.cumulocity.com')
  })

  it('does not inherit another directory\'s tenant', () => {
    writeActiveTenant('https://a.cumulocity.com', '/projects/a')
    expect(readActiveTenantUrl('/projects/new')).toBeNull()
  })

  it('falls back to the legacy global file for a directory with no selection', () => {
    mkdirSync(TEST_MC8YP_DIR, { recursive: true })
    writeFileSync(LEGACY_CONFIG_FILE, JSON.stringify({ tenantUrl: 'https://legacy.cumulocity.com' }), 'utf8')
    expect(readActiveTenantUrl('/projects/new')).toBe('https://legacy.cumulocity.com')
  })

  it('a directory\'s own selection wins over the legacy file', () => {
    mkdirSync(TEST_MC8YP_DIR, { recursive: true })
    writeFileSync(LEGACY_CONFIG_FILE, JSON.stringify({ tenantUrl: 'https://legacy.cumulocity.com' }), 'utf8')
    writeActiveTenant('https://a.cumulocity.com', '/projects/a')
    expect(readActiveTenantUrl('/projects/a')).toBe('https://a.cumulocity.com')
  })

  it('clearing a directory stops the legacy fallback without touching the legacy file', () => {
    mkdirSync(TEST_MC8YP_DIR, { recursive: true })
    writeFileSync(LEGACY_CONFIG_FILE, JSON.stringify({ tenantUrl: 'https://legacy.cumulocity.com' }), 'utf8')
    clearActiveTenant('/projects/a')
    expect(readActiveTenantUrl('/projects/a')).toBeNull()
    expect(readActiveTenantUrl('/projects/b')).toBe('https://legacy.cumulocity.com')
  })

  it('ignores a file whose stored cwd does not match', () => {
    mkdirSync(TEST_MC8YP_DIR, { recursive: true })
    writeFileSync(TEST_CONFIG_FILE, JSON.stringify({ cwd: '/elsewhere', tenantUrl: 'https://x.cumulocity.com' }), 'utf8')
    expect(readActiveTenantUrl(CWD)).toBeNull()
  })
})
