import { BasicAuth, BearerAuth, Client } from '@c8y/client'
import { isInputRequired } from 'tmcp'
import * as v from 'valibot'
import { c8yMcpServer } from '../server-instance'
import type { UserC8yAuth } from '../utils/credentials'

/**
 * Renew a TFA session this long before it expires, so a codemode run that
 * starts just before expiry cannot have its token die mid-run (wall time is
 * 120 s).
 */
export const TFA_REFRESH_MARGIN_MS = 5 * 60_000

// Concurrent tool calls for the same tenant share one renewal, so the user
// is asked for a code once, not once per call.
const inFlight = new Map<string, Promise<UserC8yAuth>>()

/**
 * Build a \@c8y/client for stored CLI credentials: Bearer with the TFA
 * session token when present, Basic otherwise.
 * @param creds - Stored credentials for one tenant
 */
export function createCliClient(creds: UserC8yAuth): Client {
  return new Client(
    creds.tfaSession
      ? new BearerAuth(creds.tfaSession.token)
      : new BasicAuth({ tenant: creds.tenantId, user: creds.user, password: creds.password }),
    creds.tenantUrl,
  )
}

/**
 * Read the stored credentials for a tenant and make sure a TFA session
 * among them is usable.
 *
 * The keyring is re-read on every call, so a token renewed from another
 * terminal (`mc8yp creds add`) is picked up without restarting. When the
 * session is about to expire and the connected MCP client supports
 * elicitation, the user is asked for a new TFA code and the token is
 * renewed with the stored password. Without elicitation (or outside a
 * request, e.g. at CLI startup) it throws a message explaining how to
 * renew from the shell.
 *
 * Callers that run inside a tool handler must rethrow `isInputRequired`
 * errors and set `replayable: true` — the elicitation happens before any
 * other work, so a replay from the top is safe.
 * @param tenantUrl - Cleaned tenant base URL
 */
export async function getFreshCliCredentials(tenantUrl: string): Promise<UserC8yAuth> {
  const creds = await globalThis._getCredentialsByTenantUrl(tenantUrl)
  if (!creds.tfaSession || creds.tfaSession.expiresAt - Date.now() > TFA_REFRESH_MARGIN_MS) {
    return creds
  }

  const pending = inFlight.get(tenantUrl)
  if (pending) {
    return pending
  }
  const renewal = renewTfaSession(creds).finally(() => inFlight.delete(tenantUrl))
  inFlight.set(tenantUrl, renewal)
  return renewal
}

async function renewTfaSession(creds: UserC8yAuth): Promise<UserC8yAuth> {
  const expiresAt = creds.tfaSession!.expiresAt
  const state = `The TFA session for ${creds.tenantUrl} (${creds.user}) ${expiresAt <= Date.now() ? 'expired' : 'expires'} at ${new Date(expiresAt).toISOString()}.`
  const shellHint = 'Run `mc8yp creds add` in a terminal to log in with a new TFA code, then retry.'

  if (!c8yMcpServer.ctx.sessionInfo?.clientCapabilities?.elicitation) {
    throw new Error(`${state} This MCP client cannot prompt for a new TFA code (no elicitation support). ${shellHint}`)
  }

  let code: string | undefined
  try {
    const answer = await c8yMcpServer.elicitation(
      `${state} Enter the current code from your authenticator app to continue.`,
      v.object({
        code: v.pipe(
          v.string(),
          v.regex(/^\s*\d{6,8}\s*$/, 'Enter the 6-digit code from your authenticator app.'),
          v.description('TFA code'),
        ),
      }),
    )
    code = answer.action === 'accept' ? answer.content?.code : undefined
  } catch (error) {
    if (isInputRequired(error)) {
      throw error
    }
    throw new Error(`${state} Prompting for a new TFA code failed (${error instanceof Error ? error.message : String(error)}). ${shellHint}`)
  }
  if (!code) {
    throw new Error(`${state} No TFA code was entered. ${shellHint}`)
  }

  // Credential helpers come in as CLI-installed globals, never as a static
  // import: the shared tools reach this module, and a static import would
  // pull @napi-rs/keyring into every server bundle.
  const session = await globalThis._requestTfaSession(creds, code)
  return globalThis._updateStoredTfaSession(creds, session)
}
