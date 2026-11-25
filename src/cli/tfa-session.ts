import { randomUUID } from 'node:crypto'
import { BasicAuth, BearerAuth, Client } from '@c8y/client'
import { assertBodySize, H3, html, HTTPError, HTTPResponse, raw, serve } from 'h3'
import { isInputRequired } from 'tmcp'
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
 * How long the local page for a TFA renewal stays open.
 */
export const URL_RENEWAL_TIMEOUT_MS = 5 * 60_000

/**
 * How often a caller waiting on an open page checks whether the keyring was
 * renewed elsewhere (e.g. `mc8yp creds add`).
 */
export const KEYRING_POLL_MS = 5_000

interface UrlRenewal {
  url: string
  /**
   * One-time path segment of `url`; doubles as the elicitation key.
   */
  token: string
  closesAt: number
  /**
   * Settles with the renewed credentials once the user submitted a valid
   * code on the page, or rejects on timeout / cancel.
   */
  result: Promise<UserC8yAuth>
  cancel: (reason: string) => void
  /**
   * True while a submitted code is being checked or saved.
   */
  isBusy: () => boolean
  /**
   * Set once a client accepted the link for this page, so later calls on a
   * still-valid session do not show it again.
   */
  shown?: boolean
}

// Open renewal pages per tenant. Outlives a single renewTfaSession call on
// purpose: a per-request (MRTR) client gets the URL, then retries the tool
// call from the top, and that retry must find the same page instead of
// starting a second server. Holds the start promise, so a second caller
// never starts a second server while the first is still binding.
const urlRenewals = new Map<string, Promise<UrlRenewal>>()

// Tenants whose user declined the renewal while the session was still
// valid, with that session's expiresAt. Until then calls go ahead with the
// old token without asking again; a different expiresAt (renewed, or a
// `creds add`) means no decline.
const declined = new Map<string, number>()

/**
 * Cancel every open renewal page, forget declines, and wait until each
 * renewal has settled.
 * The servers close in the background (a request still in flight gets its
 * response first). Test hook.
 * @internal
 */
export async function cancelUrlRenewals(): Promise<void> {
  await Promise.all([...urlRenewals.values()].map(async (started) => {
    const renewal = await started.catch(() => undefined)
    renewal?.cancel('Cancelled.')
    await renewal?.result.catch(() => {})
  }))
  declined.clear()
}

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
 * session is about to expire, mc8yp opens a local page where the user
 * enters a new TFA code (the token is renewed with the stored password) and
 * sends its URL via URL-mode elicitation. The code never passes through the
 * MCP client. While the old session is still valid, a call never fails on
 * the renewal (decline, timeout, or a client that cannot show the link): it
 * goes ahead with the old token. Once the session has expired, a client
 * without URL-mode elicitation gets an error that carries the page URL, so
 * the user can still renew from the agent's reply.
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
  const expiredOrExpires = expiresAt <= Date.now() ? 'expired' : 'expires'
  const state = `The TFA session for ${creds.tenantUrl} (${creds.user}) ${expiredOrExpires} at ${new Date(expiresAt).toISOString()}.`
  const shellHint = 'You can also run `mc8yp creds add` in a terminal to log in with a new TFA code, then retry.'
  const tenantUrl = creds.tenantUrl
  const canShowLink = Boolean(c8yMcpServer.ctx.sessionInfo?.clientCapabilities?.elicitation?.url)
  // A still-valid session is used as is when asking makes no sense: the user
  // declined for this session, or the client cannot show the link (the page
  // is only opened once its URL has to go into an error).
  if (expiresAt > Date.now() && (!canShowLink || declined.get(tenantUrl) === expiresAt)) {
    return creds
  }

  let started = urlRenewals.get(tenantUrl)
  if (!started) {
    // A renewal that just finished (page submitted, entry gone) must not
    // open a second page: the keyring already holds the new session.
    // inFlight lets only one caller per tenant get here at a time.
    let latest: UserC8yAuth
    try {
      latest = await globalThis._getCredentialsByTenantUrl(tenantUrl)
    } catch (error) {
      if (expiresAt > Date.now()) {
        return creds
      }
      throw error
    }
    if (!latest.tfaSession || latest.tfaSession.expiresAt - Date.now() > TFA_REFRESH_MARGIN_MS) {
      return latest
    }
    const own = startUrlRenewal(latest)
    started = own
    urlRenewals.set(tenantUrl, own)
    own.then((renewal) => renewal.result).catch(() => {}).finally(() => {
      if (urlRenewals.get(tenantUrl) === own) {
        urlRenewals.delete(tenantUrl)
      }
    })
  }
  let renewal: UrlRenewal
  try {
    renewal = await started
  } catch (error) {
    if (expiresAt > Date.now()) {
      return creds
    }
    throw new Error(`${state} Opening the local TFA page failed (${error instanceof Error ? error.message : String(error)}). ${shellHint}`)
  }

  const msLeft = renewal.closesAt - Date.now()
  const minutesLeft = Math.ceil(msLeft / 60_000)
  const timeLeft = msLeft < 60_000 ? 'less than a minute' : `${minutesLeft} minute${minutesLeft === 1 ? '' : 's'}`
  // A session that is only close to expiry still works, so every way the
  // renewal can fail (decline, timeout, client error) lets the call go
  // ahead with it; the error waits until the session has actually run out.
  // When the link was not shown the page stays open: the URL in the error
  // is how the user renews then.
  const openPage = `open ${renewal.url} within ${timeLeft}, enter the code there, and run the tool again.`
  const fallback = (reason: string) => {
    if (expiresAt > Date.now()) {
      return creds
    }
    throw new Error(`${state} ${reason} ${shellHint}`)
  }
  // The link was already accepted for this page: on a still-valid session
  // the next call goes ahead instead of showing it again.
  if (renewal.shown && expiresAt > Date.now()) {
    return creds
  }
  if (!canShowLink) {
    return fallback(`Renewing needs an MCP client with the 2026-07-28 protocol and URL elicitation (for example recent Claude Code versions). Or ${openPage}`)
  }

  let answer
  try {
    answer = await c8yMcpServer.elicitation(
      // Say what the code authorizes: the human should be able to tell an
      // expected renewal from a prompt they did not cause.
      `mc8yp — the Cumulocity MCP server your AI assistant is using — needs a new TFA code to keep acting as ${creds.user} on ${creds.tenantUrl}. `
      + `The current session ${expiredOrExpires} at ${new Date(expiresAt).toLocaleString()}. `
      + 'Open the link and enter the code from your authenticator app there; it renews the assistant\'s access to this tenant for the full token lifetime set by your tenant. '
      + `The page is served by mc8yp on this machine and closes in ${timeLeft}. Decline if you did not expect this prompt.`,
      renewal.url,
      // Keyed by the page: a retry answering an older, closed page is not
      // replayed against this one, so the client is asked again with the
      // current URL.
      { key: renewal.token },
    )
  } catch (error) {
    // Per-request client: the page stays open for the retry.
    if (isInputRequired(error)) {
      throw error
    }
    // The link was never shown: on a still-valid session nobody can use
    // the page, so close it. After expiry it stays open for the error's URL.
    if (expiresAt > Date.now()) {
      renewal.cancel('The client could not show the renewal link.')
      return creds
    }
    return fallback(`The client could not show the renewal link (${error instanceof Error ? error.message : String(error)}). To renew, ${openPage}`)
  }
  if (answer.action !== 'accept') {
    if (expiresAt > Date.now()) {
      declined.set(tenantUrl, expiresAt)
    }
    renewal.cancel('No TFA code was entered.')
  } else if (expiresAt > Date.now()) {
    // Accepted on a still-valid session: no need to hold the call. The page
    // stays open; a later call finds the renewed session in the keyring.
    renewal.shown = true
    return creds
  }

  // Only an expired session waits on the page. While waiting, notice a session renewed elsewhere (`creds add`): stop
  // waiting and close the page; the catch below returns the new session.
  const poll = setInterval(() => {
    globalThis._getCredentialsByTenantUrl(tenantUrl).then((latest) => {
      // Not while the page's own POST runs: its write would look like a
      // renewal from elsewhere and the page would report a give-up.
      if (!renewal.isBusy() && (!latest.tfaSession || latest.tfaSession.expiresAt - Date.now() > TFA_REFRESH_MARGIN_MS)) {
        renewal.cancel('The TFA session was renewed elsewhere.')
      }
    }, () => {})
  }, KEYRING_POLL_MS)
  poll.unref()
  try {
    return await renewal.result
  } catch (error) {
    // The keyring may hold something newer than this call's snapshot (a
    // `creds add` meanwhile, or changed credentials): use it when usable.
    let latest: UserC8yAuth | undefined
    try {
      latest = await globalThis._getCredentialsByTenantUrl(tenantUrl)
    } catch (readError) {
      if (readError instanceof Error && readError.message.startsWith('No stored credentials found')) {
        throw readError
      }
    }
    if (latest && (!latest.tfaSession || latest.tfaSession.expiresAt > Date.now())) {
      return latest
    }
    return fallback(error instanceof Error ? error.message : String(error))
  } finally {
    clearInterval(poll)
  }
}

/**
 * Serve a one-page form on 127.0.0.1 (random port, one-time random path)
 * where the user enters the TFA code. A submitted code is used right away,
 * so a wrong one shows the form again; the first success settles `result`.
 * The server closes when `result` settles, at the latest after
 * `URL_RENEWAL_TIMEOUT_MS`.
 * @param creds - Stored credentials whose TFA session is renewed
 */
async function startUrlRenewal(creds: UserC8yAuth): Promise<UrlRenewal> {
  const minutes = URL_RENEWAL_TIMEOUT_MS / 60_000
  let settled = false
  let busy = false
  let settle!: { resolve: (creds: UserC8yAuth) => void, reject: (error: Error) => void }
  const result = new Promise<UserC8yAuth>((resolve, reject) => {
    settle = {
      resolve: (value) => {
        settled = true
        resolve(value)
      },
      reject: (error) => {
        settled = true
        reject(error)
      },
    }
  })

  const page = (state: { error?: string, notice?: string }) => html`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>mc8yp TFA code</title>
<style>body{font-family:system-ui,sans-serif;max-width:28rem;margin:3rem auto;padding:0 1rem;line-height:1.5}input,button{font-size:1.25rem;padding:.4rem .6rem}</style></head>
<body><h1>New TFA code</h1><p>For <strong>${creds.user}</strong> on <strong>${creds.tenantUrl}</strong>, requested by mc8yp for your AI assistant. This page closes ${minutes} minutes after it opened.</p>
${state.error ? raw('<p role="alert"><strong>') : ''}${state.error}${state.error ? raw('</strong></p>') : ''}
${state.notice ? raw('<p>') : ''}${state.notice}${state.notice ? raw('</p>') : raw('<form method="post"><label>Code from your authenticator app<br><input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="\\d{6,8}" required autofocus></label> <button type="submit">Renew</button></form>')}
</body></html>`

  const token = randomUUID()
  const app = new H3()
  app.use((event) => {
    event.res.headers.set('cache-control', 'no-store')
    event.res.headers.set('content-security-policy', 'frame-ancestors \'none\'')
  })
  app.get(`/${token}`, () => page(settled ? { notice: 'This renewal is already finished (or was cancelled). You can close this page.' } : {}))
  app.post(`/${token}`, async (event) => {
    const fail = (status: number, error: string) => {
      event.res.status = status
      return page({ error })
    }
    // One code at a time, and nothing after the renewal finished.
    if (settled) {
      return fail(409, 'This renewal has already finished. You can close this tab.')
    }
    if (busy) {
      return fail(409, 'A code is already being checked. Wait for its result.')
    }
    busy = true
    try {
      let code: string
      try {
        if (!event.req.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')) {
          throw new Error('not a form')
        }
        // The body-size guard hands back a request without its content
        // type, so formData() would fail on it; the form is urlencoded.
        assertBodySize(event, 1024)
        code = (new URLSearchParams(await event.req.text()).get('code') ?? '').trim()
      } catch (error) {
        return error instanceof HTTPError && error.status === 413
          ? fail(413, 'The request was too large. Send the code with the form on this page.')
          : fail(400, 'Send the code with the form on this page.')
      }
      if (!/^\d{6,8}$/.test(code)) {
        return fail(400, 'Enter the 6 to 8 digit code from your authenticator app.')
      }

      // Credential helpers come in as CLI-installed globals, never as a
      // static import: the shared tools reach this module, and a static
      // import would pull @napi-rs/keyring into every server bundle.
      // The keyring is re-read before the code is sent and again right
      // before the write, and the renewal is refused when the entry is gone
      // or its user/password changed (a `creds remove` / `creds add` for
      // another login meanwhile). Only user and password are compared: a
      // `creds add` for the same login is overwritten by this renewal. A
      // read that fails for another reason leaves the page open for a retry.
      const recheck = async (): Promise<UserC8yAuth | HTTPResponse> => {
        let current
        try {
          current = await globalThis._getCredentialsByTenantUrl(creds.tenantUrl)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (!message.startsWith('No stored credentials found')) {
            return fail(500, `Reading the stored credentials failed (${message}). Try again.`)
          }
        }
        if (!current || current.user !== creds.user || current.password !== creds.password) {
          settle.reject(new Error(`The stored credentials for ${creds.tenantUrl} changed while the TFA page was open.`))
          return fail(409, 'The stored credentials changed while this page was open. Run the tool again.')
        }
        return current
      }
      const before = await recheck()
      if (before instanceof HTTPResponse) {
        return before
      }

      let session
      try {
        session = await globalThis._requestTfaSession(before, code)
      } catch (error) {
        return fail(400, `The code could not be verified (${error instanceof Error ? error.message : String(error)}). Try again.`)
      }
      const current = await recheck()
      if (current instanceof HTTPResponse) {
        return current
      }
      // Cancelled or timed out while the code was checked: write nothing.
      // No await between this check and the write below.
      if (settled) {
        return fail(409, 'This renewal was cancelled or timed out. Run the tool again.')
      }
      let renewed
      try {
        renewed = await globalThis._updateStoredTfaSession(current, session)
      } catch (error) {
        return fail(500, `The code was accepted, but saving the new session failed (${error instanceof Error ? error.message : String(error)}). Try again with a new code.`)
      }
      // Cancelled or timed out during the write: the session is saved, but
      // the waiting tool call has already failed.
      if (settled) {
        return fail(409, 'The code was accepted and the new session is saved, but the tool call already gave up. Run the tool again.')
      }
      declined.delete(creds.tenantUrl)
      settle.resolve(renewed)
      // Close the connection with the response so server.close() below can
      // finish instead of waiting on the browser's keep-alive socket.
      event.res.headers.set('connection', 'close')
      return page({ notice: 'Done. The TFA session is renewed; you can close this tab.' })
    } finally {
      busy = false
    }
  })

  let server: ReturnType<typeof serve> | undefined
  try {
    server = serve(app, { hostname: '127.0.0.1', port: 0, silent: true, gracefulShutdown: false })
    await server.ready()
  } catch (error) {
    await server?.close(true).catch(() => {})
    throw error
  }
  const listening = server
  const timer = setTimeout(() => settle.reject(new Error(`No TFA code was entered within ${minutes} minutes.`)), URL_RENEWAL_TIMEOUT_MS)
  // Nobody may be awaiting `result` (a per-request client that never
  // retries), so the cleanup chain also swallows the rejection.
  result.finally(() => {
    clearTimeout(timer)
    // Not closeAll: the request that settled `result` still has to get its
    // response. Idle keep-alive sockets are closed right away.
    listening.close().catch(() => {})
  }).catch(() => {})

  return {
    url: `${listening.url}${token}`,
    token,
    closesAt: Date.now() + URL_RENEWAL_TIMEOUT_MS,
    result,
    cancel: (reason) => settle.reject(new Error(reason)),
    isBusy: () => busy,
  }
}
