import { Client } from '@c8y/client'
import { AsyncEntry, findCredentialsAsync } from '@napi-rs/keyring'
import pkgjson from '../../package.json' with { type: 'json' }

interface BaseC8yAuth {
  /**
   * The Cumulocity tenant URL
   * @example https://my-tenant.cumulocity.com
   */
  tenantUrl: string
}

export interface TokenC8yAuth extends BaseC8yAuth {
  /**
   * Bearer token (for Bearer auth)
   */
  token: string
}

export interface UserC8yAuth extends BaseC8yAuth {
  /**
   * The Cumulocity username (for Basic auth)
   */
  user: string
  /**
   * The Cumulocity password (for Basic auth)
   */
  password: string

  /**
   * The Cumulocity tenant ID used in Basic auth: tenantId/user
   */
  tenantId: string
}

export type C8yAuth = TokenC8yAuth | UserC8yAuth

interface StoredUserC8yAuth extends BaseC8yAuth {
  user: string
  password: string
  tenantId?: string
}

type NewStoredUserC8yAuth = Omit<UserC8yAuth, 'tenantId'> & { tenantId?: string }

async function resolveTenantId(creds: Omit<UserC8yAuth, 'tenantId'>): Promise<string> {
  const client = await Client.authenticate({
    user: creds.user,
    password: creds.password,
  }, creds.tenantUrl)
  const tenant = await client.tenant.current()
  return tenant.data.name
}

async function writeStoredC8yAuth(creds: UserC8yAuth): Promise<void> {
  const jsonString = JSON.stringify(creds)
  const entry = new AsyncEntry(pkgjson.name, creds.tenantUrl)

  try {
    await entry.setPassword(jsonString)
  } catch (err) {
    throw new Error('Failed to store credentials', { cause: err })
  }
}

function parseStoredUserC8yAuth(jsonString: string, tenantUrl: string): UserC8yAuth {
  const cred = JSON.parse(jsonString) as StoredUserC8yAuth

  if (!cred.tenantId) {
    throw new Error(
      `Stored credentials for tenant URL ${tenantUrl} are outdated. Remove and add them again with tenantId.`,
    )
  }

  return {
    tenantUrl,
    user: cred.user,
    password: cred.password,
    tenantId: cred.tenantId,
  }
}

export async function getStoredC8yAuth(): Promise<UserC8yAuth[]> {
  const found = await findCredentialsAsync(pkgjson.name)
  // now the "account" should be the tenantUrl
  // and the "password" is the json stringified UserC8yAuth
  const creds: UserC8yAuth[] = []
  for (const entry of found) {
    const { account, password: jsonString } = entry
    creds.push(parseStoredUserC8yAuth(jsonString, cleanTenantUrl(account)))
  }
  return creds
}

export async function getCredentialsByTenantUrl(tenantUrl: string): Promise<UserC8yAuth> {
  const cleanedUrl = cleanTenantUrl(tenantUrl)

  // Primary path: target-filtered keyring query. Fast on healthy keyrings.
  let entry = (await findCredentialsAsync(pkgjson.name, cleanedUrl))[0]

  // Fallback: some keyring backends (notably libsecret on WSL2 / Ubuntu 24
  // with a locked default collection) obscure the `target` attribute, so
  // target-filtered lookups return empty even though the entry exists and
  // is fully readable via an unfiltered listing. Mirror the resilience
  // pattern already used by deleteStoredC8yAuth: list everything for the
  // service and match by cleaned account. Identical semantics on healthy
  // backends, but recovers the stored credentials on broken ones.
  if (!entry) {
    const all = await findCredentialsAsync(pkgjson.name)
    entry = all.find((e) => cleanTenantUrl(e.account) === cleanedUrl)
  }

  if (!entry) {
    throw new Error(`No stored credentials found for tenant URL: ${cleanedUrl}`)
  }
  return parseStoredUserC8yAuth(entry.password, cleanedUrl)
}

export async function setStoredC8yAuth(creds: NewStoredUserC8yAuth): Promise<void> {
  // first verify by removing and trailing or leading slashes and whitespaces in tenantUrl
  const cleanedTenantUrl = cleanTenantUrl(creds.tenantUrl)
  const normalized: UserC8yAuth = {
    ...creds,
    tenantUrl: cleanedTenantUrl,
    tenantId: creds.tenantId ?? await resolveTenantId({
      tenantUrl: cleanedTenantUrl,
      user: creds.user,
      password: creds.password,
    }),
  }

  await writeStoredC8yAuth(normalized)
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
