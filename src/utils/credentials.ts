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

  // The optional second findCredentialsAsync parameter filters by keyring
  // *target*, not by account. Entries are written with the default target
  // (two-arg AsyncEntry), so a target-filtered query is never a per-account
  // lookup — on macOS the filter is ignored and every entry for the service
  // comes back, on libsecret/WSL2 it can return empty. List everything for
  // the service and match by cleaned account, like deleteStoredC8yAuth does.
  const all = await findCredentialsAsync(pkgjson.name)
  const entry = all.find((e) => cleanTenantUrl(e.account) === cleanedUrl)

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

  // Existence check via list-all (resilient to libsecret backends that
  // obscure the `target` attribute, e.g. WSL2 / Ubuntu 24 with a locked
  // default collection). Normalize the stored account before comparing
  // so a historical trailing-slash entry still matches.
  const found = await findCredentialsAsync(pkgjson.name)
  const exists = found.some((entry) => cleanTenantUrl(entry.account) === cleanedUrl)

  if (!exists) {
    return false
  }

  // Attempt the targeted delete. On healthy backends this is the
  // matching half of the targeted lookup. On broken backends the
  // target attribute is obscured, so deletePassword can throw or
  // silently no-op — verify by re-listing and surface a clear error
  // instead of swallowing into `false`, which used to make the CLI
  // report a generic 'Failed to remove' that the user could not act on.
  const entry = new AsyncEntry(pkgjson.name, cleanedUrl)
  let deleteError: unknown
  try {
    await entry.deletePassword()
  } catch (err) {
    deleteError = err
  }

  const stillThere = (await findCredentialsAsync(pkgjson.name))
    .some((e) => cleanTenantUrl(e.account) === cleanedUrl)
  if (!stillThere) {
    return true
  }

  throw new Error(
    `Keyring refused to delete the credentials for ${cleanedUrl}. The entry is present when listing but cannot be removed by target — this is typically a libsecret / WSL2 locked-collection issue. Unlock the login keyring (e.g. \`gnome-keyring-daemon --unlock --components=secrets\`) and try again, or remove the entry manually with \`secret-tool clear service ${pkgjson.name} account ${cleanedUrl}\`.`,
    deleteError instanceof Error ? { cause: deleteError } : undefined,
  )
}
