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
 * Returns null when the file is missing, malformed, has the wrong shape,
 * or holds an explicit `{ tenantUrl: null }` marker written by clearActiveTenant.
 */
export function readActiveTenantUrl(): string | null {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as unknown
    if (raw && typeof raw === 'object' && 'tenantUrl' in raw) {
      const value = (raw as Record<string, unknown>).tenantUrl
      if (typeof value === 'string')
        return value
      // tenantUrl is present but null — explicit "cleared" marker. Read as null.
    }
    return null
  } catch {
    return null
  }
}

/**
 * Persist an explicit "no active tenant" marker (`{ tenantUrl: null }`).
 * Used by drift recovery and the explicit reset path. Keeping the file
 * (instead of unlinking) makes the state easy to inspect and avoids any
 * confusion between "no active tenant ever set" and "active tenant
 * intentionally cleared".
 */
export function clearActiveTenant(): void {
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(CONFIG_FILE, JSON.stringify({ tenantUrl: null }), 'utf8')
}
