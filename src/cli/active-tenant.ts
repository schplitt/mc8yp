import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CONFIG_DIR = join(homedir(), '.config', 'mc8yp')
const CONFIG_FILE = join(CONFIG_DIR, 'active-tenant.json')

/**
 * Persist the active tenant URL to disk.
 * Creates the config directory if it does not exist.
 * @param tenantUrl
 */
export function writeActiveTenant(tenantUrl: string): void {
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(CONFIG_FILE, JSON.stringify({ tenantUrl }), 'utf8')
}

/**
 * Read the active tenant URL from disk.
 * Returns null on any error — missing file, bad JSON, wrong shape.
 */
export function readActiveTenantUrl(): string | null {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as unknown
    if (raw && typeof raw === 'object' && 'tenantUrl' in raw && typeof (raw as Record<string, unknown>).tenantUrl === 'string') {
      return (raw as { tenantUrl: string }).tenantUrl
    }
    return null
  } catch {
    return null
  }
}
