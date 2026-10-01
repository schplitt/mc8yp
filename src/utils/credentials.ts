import { Buffer } from 'node:buffer'
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

/**
 * OAI-Secure access token obtained with a TFA code. Users with two-factor
 * authentication cannot use Basic auth (every request would need a fresh
 * TOTP code), so live calls use this token instead while it is valid.
 */
export interface TfaSession {
  token: string
  /**
   * Token expiry as epoch milliseconds, read from the JWT `exp` claim.
   */
  expiresAt: number
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

  /**
   * Present for users with TFA enabled. The password is kept alongside so a
   * new token can be requested with just a fresh TFA code.
   */
  tfaSession?: TfaSession
}

export type C8yAuth = TokenC8yAuth | UserC8yAuth

interface StoredUserC8yAuth extends BaseC8yAuth {
  user: string
  password: string
  tenantId?: string
  tfaSession?: TfaSession
}

type NewStoredUserC8yAuth = Omit<UserC8yAuth, 'tenantId'> & { tenantId?: string }

/**
 * Thrown when the platform rejects a login because a TFA code is required.
 * `creds add` catches it to prompt for the code.
 */
export class TfaRequiredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TfaRequiredError'
  }
}

/**
 * Turn a failed platform response into an Error carrying the platform's own
 * message (e.g. "Invalid credentials! : TFA TOTP code required.").
 * @param res - Non-2xx response from the tenant
 * @param action - What was attempted, for the message prefix
 */
async function platformError(res: Response, action: string): Promise<Error> {
  const body = await res.json().catch(() => undefined) as { message?: string } | undefined
  const message = `${action} failed: ${res.status} ${res.statusText}${body?.message ? ` — ${body.message}` : ''}`
  return res.status === 401 && /\bTFA\b/i.test(body?.message ?? '')
    ? new TfaRequiredError(message)
    : new Error(message)
}

async function resolveTenantId(tenantUrl: string, authorizationHeader: string): Promise<string> {
  const res = await fetch(`${tenantUrl}/tenant/currentTenant`, {
    headers: { Authorization: authorizationHeader, Accept: 'application/json' },
  })
  if (!res.ok) {
    throw await platformError(res, 'Login')
  }
  const tenant = await res.json() as { name: string }
  return tenant.name
}

/**
 * Exchange user, password and a current TFA code for an OAI-Secure access
 * token via `POST /tenant/oauth/token`.
 * @param creds - Tenant URL, user, password, and the tenant ID when already known
 * @param tfaCode - Current TFA code (TOTP)
 */
export async function requestTfaSession(
  creds: Omit<UserC8yAuth, 'tenantId' | 'tfaSession'> & { tenantId?: string },
  tfaCode: string,
): Promise<TfaSession> {
  const url = new URL('/tenant/oauth/token', creds.tenantUrl)
  if (creds.tenantId) {
    url.searchParams.set('tenant_id', creds.tenantId)
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body: new URLSearchParams({
      grant_type: 'PASSWORD',
      username: creds.user,
      password: creds.password,
      tfa_code: tfaCode.trim(),
    }),
  })
  if (!res.ok) {
    throw await platformError(res, 'TFA login')
  }
  const { access_token: token } = await res.json() as { access_token?: string }
  if (!token) {
    throw new Error('TFA login failed: the platform response contained no access token.')
  }

  let exp: unknown
  try {
    exp = (JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { exp?: unknown }).exp
  } catch {}
  if (typeof exp !== 'number') {
    throw new Error('TFA login failed: could not read the expiry (exp claim) of the access token.')
  }
  return { token, expiresAt: exp * 1000 }
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
    ...(cred.tfaSession ? { tfaSession: cred.tfaSession } : {}),
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
    tenantId: creds.tenantId ?? await resolveTenantId(
      cleanedTenantUrl,
      creds.tfaSession
        ? `Bearer ${creds.tfaSession.token}`
        : `Basic ${Buffer.from(`${creds.user}:${creds.password}`).toString('base64')}`,
    ),
  }

  await writeStoredC8yAuth(normalized)
}

/**
 * Replace the stored TFA session for an existing credential entry.
 * @param creds - The stored credentials the new session belongs to
 * @param tfaSession - Freshly obtained session token
 */
export async function updateStoredTfaSession(creds: UserC8yAuth, tfaSession: TfaSession): Promise<UserC8yAuth> {
  const updated: UserC8yAuth = { ...creds, tfaSession }
  await writeStoredC8yAuth(updated)
  return updated
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
