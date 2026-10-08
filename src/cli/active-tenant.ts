import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

const CONFIG_DIR = join(homedir(), '.config', 'mc8yp', 'active-tenants')
// Pre-per-directory global selection. Read-only fallback, never written.
const LEGACY_CONFIG_FILE = join(homedir(), '.config', 'mc8yp', 'active-tenant.json')

/**
 * The active tenant is scoped to the working directory the CLI was started
 * in (MCP clients spawn the stdio server in the project directory), so
 * several agents in different projects never switch each other's tenant.
 * One file per directory: concurrent processes never read-modify-write a
 * shared file. A directory with no file falls back to the legacy global file
 * (read-only) so existing setups keep their tenant after upgrading.
 * @param cwd
 */
function configFile(cwd: string): string {
  return join(CONFIG_DIR, `${createHash('sha256').update(cwd).digest('hex').slice(0, 32)}.json`)
}

function write(cwd: string, tenantUrl: string | null): void {
  mkdirSync(CONFIG_DIR, { recursive: true })
  const file = configFile(cwd)
  // Write-then-rename so a concurrent reader never sees a half-written file.
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify({ cwd, tenantUrl }), 'utf8')
  renameSync(tmp, file)
}

/**
 * Persist the active tenant URL for a working directory.
 * Creates the config directory if it does not exist.
 * @param tenantUrl
 * @param cwd
 */
export function writeActiveTenant(tenantUrl: string, cwd = process.cwd()): void {
  write(cwd, tenantUrl)
}

/**
 * Read the active tenant URL for a working directory.
 * Falls back to the legacy global file when this directory has no file.
 * Returns null when the file is malformed, has the wrong shape,
 * belongs to a different directory (hash collision), or holds an explicit
 * `{ tenantUrl: null }` marker written by clearActiveTenant.
 * @param cwd
 */
export function readActiveTenantUrl(cwd = process.cwd()): string | null {
  let content: string
  try {
    content = readFileSync(configFile(cwd), 'utf8')
  } catch {
    // This directory never selected (or cleared) a tenant: fall back to the
    // pre-per-directory global file so existing setups keep working. It is
    // never written anymore, so it acts as a frozen default, and a directory
    // that clears its tenant gets a null marker that stops this fallback.
    return readLegacyActiveTenantUrl()
  }
  try {
    const raw = JSON.parse(content) as unknown
    if (raw && typeof raw === 'object' && 'tenantUrl' in raw) {
      const { cwd: storedCwd, tenantUrl } = raw as Record<string, unknown>
      if (storedCwd === cwd && typeof tenantUrl === 'string')
        return tenantUrl
      // tenantUrl is present but null — explicit "cleared" marker. Read as null.
    }
    return null
  } catch {
    return null
  }
}

function readLegacyActiveTenantUrl(): string | null {
  try {
    const raw = JSON.parse(readFileSync(LEGACY_CONFIG_FILE, 'utf8')) as unknown
    if (raw && typeof raw === 'object' && 'tenantUrl' in raw) {
      const value = (raw as Record<string, unknown>).tenantUrl
      if (typeof value === 'string')
        return value
    }
    return null
  } catch {
    return null
  }
}

/**
 * Persist an explicit "no active tenant" marker (`{ tenantUrl: null }`) for a
 * working directory. Used by drift recovery and the explicit reset path.
 * Keeping the file (instead of unlinking) makes the state easy to inspect.
 * @param cwd
 */
export function clearActiveTenant(cwd = process.cwd()): void {
  write(cwd, null)
}
