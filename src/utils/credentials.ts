import { AsyncEntry, findCredentialsAsync } from '@napi-rs/keyring'
import pkgjson from '../../package.json' with { type: 'json' }

export interface TokenC8yAuth {
  /**
   * Bearer token (for Bearer auth)
   */
  token: string

  /**
   * The Cumulocity tenant URL
   * @example https://my-tenant.cumulocity.com
   */
  tenantUrl: string
}

export interface UserC8yAuth {
  /**
   * The Cumulocity username (for Basic auth)
   */
  user: string
  /**
   * The Cumulocity password (for Basic auth)
   */
  password: string
  /**
   * The Cumulocity tenant URL
   * @example https://my-tenant.cumulocity.com
   */
  tenantUrl: string
}

export type C8yAuth = TokenC8yAuth | UserC8yAuth

export async function getStoredC8yAuth(): Promise<UserC8yAuth[]> {
  const found = await findCredentialsAsync(pkgjson.name)
  // now the "account" should be the tenantUrl
  // and the "password" is the json stringified UserC8yAuth
  const creds: UserC8yAuth[] = []
  for (const entry of found) {
    try {
      const { password: jsonString } = entry
      const cred = JSON.parse(jsonString) as UserC8yAuth
      creds.push(cred)
    } catch {
      // ignore parse errors
    }
  }
  return creds
}

export async function getCredentialsByTenantUrl(tenantUrl: string): Promise<UserC8yAuth> {
  const cleanedUrl = cleanTenantUrl(tenantUrl)
  const found = await findCredentialsAsync(pkgjson.name, cleanedUrl)
  if (found.length === 0) {
    throw new Error(`No stored credentials found for tenant URL: ${cleanedUrl}`)
  }
  const entry = found[0]!
  const { password: jsonString } = entry
  try {
    const cred = JSON.parse(jsonString) as UserC8yAuth
    return cred
  } catch {
    throw new Error(`Stored credentials for tenant URL ${cleanedUrl} are corrupted`)
  }
}

export async function setStoredC8yAuth(creds: UserC8yAuth): Promise<void> {
  // first verify by removing and trailing or leading slashes and whitespaces in tenantUrl
  creds.tenantUrl = cleanTenantUrl(creds.tenantUrl)

  const jsonString = JSON.stringify(creds)

  const entry = new AsyncEntry(pkgjson.name, creds.tenantUrl)
  try {
    await entry.setPassword(jsonString)
  } catch (err) {
    throw new Error(`Failed to store credentials`, { cause: err })
  }
}

export function cleanTenantUrl(url: string): string {
  let cleaned = url.trim()

  // remove all parts after possible trailing slash
  const slashIndex = cleaned.indexOf('/', cleaned.indexOf('://') + 3)
  if (slashIndex !== -1) {
    cleaned = cleaned.slice(0, slashIndex)
  }
  if (cleaned.endsWith('/')) {
    cleaned = cleaned.slice(0, -1)
  }
  return cleaned
}

export async function deleteStoredC8yAuth(tenantUrl: string): Promise<boolean> {
  const cleanedUrl = cleanTenantUrl(tenantUrl)
  const found = await findCredentialsAsync(pkgjson.name)
  const exists = found.some((entry) => entry.account === cleanedUrl)

  if (!exists) {
    return false
  }

  const entry = new AsyncEntry(pkgjson.name, cleanedUrl)
  try {
    await entry.deletePassword()
    return true
  } catch {
    return false
  }
}
