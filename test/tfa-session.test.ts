/**
 * Tests for TFA session renewal in src/cli/tfa-session.ts: fresh sessions
 * pass through; expiring ones are renewed through a local page whose URL is
 * sent via URL-mode elicitation, so the code never passes through the MCP
 * client. Clients without URL mode get an error carrying the page URL.
 */
import { connect } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as v from 'valibot'
import { c8yMcpServer } from '../src/server-instance'
import { cancelUrlRenewals, getFreshCliCredentials, KEYRING_POLL_MS, URL_RENEWAL_TIMEOUT_MS } from '../src/cli/tfa-session'
import type { UserC8yAuth } from '../src/utils/credentials'

const serveFailure = vi.hoisted(() => ({ error: undefined as Error | undefined }))
vi.mock('h3', async (importOriginal) => {
  const h3 = await importOriginal<typeof import('h3')>()
  return {
    ...h3,
    serve: (...args: Parameters<typeof h3.serve>) => {
      if (serveFailure.error) {
        throw serveFailure.error
      }
      return h3.serve(...args)
    },
  }
})

// tmcp's input-required signal is a private class; also accept a tagged
// error so the rethrow can be driven without a full per-request run (the
// tmcp integration tests below use the real signal).
vi.mock('tmcp', async (importOriginal) => {
  const tmcp = await importOriginal<typeof import('tmcp')>()
  return {
    ...tmcp,
    isInputRequired: (error: unknown) => tmcp.isInputRequired(error) || (error instanceof Error && error.name === 'TestInputRequired'),
  }
})

const requestTfaSession = vi.fn()
const updateStoredTfaSession = vi.fn(async (creds: UserC8yAuth, tfaSession: UserC8yAuth['tfaSession']) => ({ ...creds, tfaSession }))

const TENANT = 'https://t.example.com'
const RENEWED = { token: 'new', expiresAt: Date.now() + 3600_000 }

function storedCreds(expiresAt?: number): UserC8yAuth {
  return {
    tenantUrl: TENANT,
    user: 'u',
    password: 'p',
    tenantId: 't42',
    ...(expiresAt === undefined ? {} : { tfaSession: { token: 'old', expiresAt } }),
  }
}

function stubClient(elicitation: 'none' | 'form' | 'url'): void {
  const capabilities = { none: {}, form: { elicitation: { form: {} } }, url: { elicitation: { form: {}, url: {} } } }[elicitation]
  vi.spyOn(c8yMcpServer, 'ctx', 'get').mockReturnValue({
    sessionInfo: { clientCapabilities: capabilities },
  } as unknown as typeof c8yMcpServer.ctx)
}

function postCode(url: string, code: string): Promise<Response> {
  return fetch(url, { method: 'POST', body: new URLSearchParams({ code }) })
}

async function isClosed(url: string): Promise<boolean> {
  return fetch(url).then(() => false, () => true)
}

function urlFromError(error: unknown): string {
  const match = /open (http:\/\/127\.0\.0\.1:\d+\/[0-9a-f-]{36}) within \d+ minutes/.exec(String(error))
  expect(match).not.toBeNull()
  return match![1]!
}

/**
 * Start a renewal with a client that accepts the URL prompt; resolves with
 * the pending result and the page URL.
 */
async function startAccepted(): Promise<{ pending: Promise<UserC8yAuth>, url: string, elicit: ReturnType<typeof vi.spyOn> }> {
  stubClient('url')
  const elicit = vi.spyOn(c8yMcpServer, 'elicitation').mockResolvedValue({ action: 'accept' } as never)
  const pending = getFreshCliCredentials(TENANT)
  pending.catch(() => {})
  await vi.waitFor(() => expect(elicit).toHaveBeenCalled())
  return { pending, url: elicit.mock.calls[0]![1] as unknown as string, elicit }
}

beforeEach(() => {
  serveFailure.error = undefined
  requestTfaSession.mockReset()
  updateStoredTfaSession.mockClear()
  globalThis._requestTfaSession = requestTfaSession
  globalThis._updateStoredTfaSession = updateStoredTfaSession as typeof globalThis._updateStoredTfaSession
  globalThis._getCredentialsByTenantUrl = vi.fn(async () => storedCreds(Date.now() - 1000))
})

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await cancelUrlRenewals()
})

describe('getFreshCliCredentials', () => {
  it('returns Basic-auth credentials untouched', async () => {
    globalThis._getCredentialsByTenantUrl = vi.fn(async () => storedCreds())
    await expect(getFreshCliCredentials(TENANT)).resolves.toEqual(storedCreds())
  })

  it('returns a TFA session that is still fresh without prompting', async () => {
    const fresh = storedCreds(Date.now() + 60 * 60_000)
    globalThis._getCredentialsByTenantUrl = vi.fn(async () => fresh)
    const elicit = vi.spyOn(c8yMcpServer, 'elicitation')

    await expect(getFreshCliCredentials(TENANT)).resolves.toBe(fresh)
    expect(elicit).not.toHaveBeenCalled()
  })

  it('serves a local page and renews with the code posted there', async () => {
    requestTfaSession.mockRejectedValueOnce(new Error('Invalid TFA code')).mockResolvedValue(RENEWED)
    const { pending, url, elicit } = await startAccepted()

    const [message, , options] = elicit.mock.calls[0]! as unknown as [string, string, { key: string }]
    expect(message).toContain(`acting as u on ${TENANT}`)
    expect(message).toContain('Decline if you did not expect this prompt')
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f-]{36}$/)
    expect(url.endsWith(`/${options.key}`)).toBe(true)

    const form = await fetch(url)
    expect(form.headers.get('cache-control')).toBe('no-store')
    expect(form.headers.get('content-security-policy')).toBe('frame-ancestors \'none\'')
    const formHtml = await form.text()
    expect(formHtml).toContain('name="code"')
    expect(formHtml).not.toContain('role="alert"')
    expect((await fetch(new URL('/other', url))).status).toBe(404)
    const badFormat = await postCode(url, 'abc')
    expect(badFormat.status).toBe(400)
    expect(await badFormat.text()).toContain('Enter the 6 to 8 digit code')
    const wrong = await postCode(url, '111111')
    expect(wrong.status).toBe(400)
    expect(await wrong.text()).toContain('Invalid TFA code')
    expect(await (await postCode(url, '222222')).text()).toContain('Done.')

    const creds = await pending
    expect(creds.tfaSession).toEqual(RENEWED)
    expect(requestTfaSession).toHaveBeenLastCalledWith(expect.objectContaining({ user: 'u', password: 'p', tenantId: 't42' }), '222222')
    await vi.waitFor(async () => expect(await isClosed(url)).toBe(true))
  })

  it('prompts once for concurrent renewals of the same tenant', async () => {
    stubClient('url')
    const elicit = vi.spyOn(c8yMcpServer, 'elicitation').mockResolvedValue({ action: 'accept' } as never)
    requestTfaSession.mockResolvedValue(RENEWED)

    const both = Promise.all([getFreshCliCredentials(TENANT), getFreshCliCredentials(TENANT)])
    await vi.waitFor(() => expect(elicit).toHaveBeenCalled())
    await postCode(elicit.mock.calls[0]![1] as unknown as string, '123456')
    const [a, b] = await both
    expect(elicit).toHaveBeenCalledOnce()
    expect(a.tfaSession?.token).toBe('new')
    expect(b.tfaSession?.token).toBe('new')
  })

  it('closes the page when the user declines', async () => {
    stubClient('url')
    const elicit = vi.spyOn(c8yMcpServer, 'elicitation').mockResolvedValue({ action: 'decline' } as never)

    await expect(getFreshCliCredentials(TENANT)).rejects.toThrow(/No TFA code was entered\..*mc8yp creds add/)
    expect(await isClosed(elicit.mock.calls[0]![1] as unknown as string)).toBe(true)
    expect(requestTfaSession).not.toHaveBeenCalled()
  })

  it('goes ahead with a still-valid session when the user declines', async () => {
    const expiring = storedCreds(Date.now() + 60_000)
    globalThis._getCredentialsByTenantUrl = vi.fn(async () => expiring)
    stubClient('url')
    const elicit = vi.spyOn(c8yMcpServer, 'elicitation').mockResolvedValue({ action: 'decline' } as never)

    await expect(getFreshCliCredentials(TENANT)).resolves.toEqual(expiring)
    expect(await isClosed(elicit.mock.calls[0]![1] as unknown as string)).toBe(true)
  })

  it('does not ask again after a decline until the session expired', async () => {
    let stored = storedCreds(Date.now() + 60_000)
    globalThis._getCredentialsByTenantUrl = vi.fn(async () => stored)
    stubClient('url')
    const elicit = vi.spyOn(c8yMcpServer, 'elicitation').mockResolvedValue({ action: 'decline' } as never)
    await expect(getFreshCliCredentials(TENANT)).resolves.toBe(stored)
    expect(elicit).toHaveBeenCalledOnce()

    // Same session: no prompt, and no page (the keyring is read only once,
    // by the expiry check; opening a page would re-read it first).
    vi.mocked(globalThis._getCredentialsByTenantUrl).mockClear()
    await expect(getFreshCliCredentials(TENANT)).resolves.toBe(stored)
    expect(elicit).toHaveBeenCalledOnce()
    expect(globalThis._getCredentialsByTenantUrl).toHaveBeenCalledOnce()

    // Expired: asked again, and a decline now fails.
    stored = { ...stored, tfaSession: { token: 'old', expiresAt: Date.now() - 1000 } }
    await expect(getFreshCliCredentials(TENANT)).rejects.toThrow('No TFA code was entered')
    expect(elicit).toHaveBeenCalledTimes(2)
  })

  it('forgets a decline once the session changed', async () => {
    let stored = storedCreds(Date.now() + 60_000)
    globalThis._getCredentialsByTenantUrl = vi.fn(async () => stored)
    stubClient('url')
    const elicit = vi.spyOn(c8yMcpServer, 'elicitation').mockResolvedValue({ action: 'decline' } as never)
    await getFreshCliCredentials(TENANT)

    // A `creds add` stored a different (still expiring) session.
    stored = storedCreds(Date.now() + 90_000)
    await getFreshCliCredentials(TENANT)
    expect(elicit).toHaveBeenCalledTimes(2)
  })

  it('forgets a decline after a renewal', async () => {
    const declinedSession = storedCreds(Date.now() + 60_000)
    let stored = declinedSession
    globalThis._getCredentialsByTenantUrl = vi.fn(async () => stored)
    stubClient('url')
    const elicit = vi.spyOn(c8yMcpServer, 'elicitation').mockResolvedValueOnce({ action: 'decline' } as never)
    await getFreshCliCredentials(TENANT)

    // Renewed through a page the user opened from an expired-session error.
    stored = storedCreds(Date.now() - 1000)
    elicit.mockResolvedValue({ action: 'accept' } as never)
    requestTfaSession.mockResolvedValue(RENEWED)
    const pending = getFreshCliCredentials(TENANT)
    await vi.waitFor(() => expect(elicit).toHaveBeenCalledTimes(2))
    await postCode(elicit.mock.calls[1]![1] as unknown as string, '123456')
    await pending

    // Back on the declined session (e.g. restored keyring entry): asked again.
    stored = declinedSession
    elicit.mockResolvedValue({ action: 'decline' } as never)
    await getFreshCliCredentials(TENANT)
    expect(elicit).toHaveBeenCalledTimes(3)
  })

  it('treats a cancelled prompt like a decline', async () => {
    const expiring = storedCreds(Date.now() + 60_000)
    globalThis._getCredentialsByTenantUrl = vi.fn(async () => expiring)
    stubClient('url')
    const elicit = vi.spyOn(c8yMcpServer, 'elicitation').mockResolvedValue({ action: 'cancel' } as never)

    await expect(getFreshCliCredentials(TENANT)).resolves.toEqual(expiring)
    await expect(getFreshCliCredentials(TENANT)).resolves.toEqual(expiring)
    expect(elicit).toHaveBeenCalledOnce()
    expect(await isClosed(elicit.mock.calls[0]![1] as unknown as string)).toBe(true)
  })

  it('does not hold a still-valid session on an accepted link', async () => {
    const expiring = storedCreds(Date.now() + 60_000)
    globalThis._getCredentialsByTenantUrl = vi.fn(async () => expiring)
    stubClient('url')
    const elicit = vi.spyOn(c8yMcpServer, 'elicitation').mockResolvedValue({ action: 'accept' } as never)
    requestTfaSession.mockResolvedValue(RENEWED)

    await expect(getFreshCliCredentials(TENANT)).resolves.toEqual(expiring)
    const url = elicit.mock.calls[0]![1] as unknown as string
    // Next call: same page, not shown again.
    await expect(getFreshCliCredentials(TENANT)).resolves.toEqual(expiring)
    expect(elicit).toHaveBeenCalledOnce()
    // The page still works.
    expect(await (await postCode(url, '123456')).text()).toContain('Done.')
    expect(updateStoredTfaSession).toHaveBeenCalledOnce()
  })

  it('returns a still-valid session on the retry of a per-request client', async () => {
    const expiring = storedCreds(Date.now() + 60_000)
    globalThis._getCredentialsByTenantUrl = vi.fn(async () => expiring)
    stubClient('url')
    const signal = Object.assign(new Error('input required'), { name: 'TestInputRequired' })
    const elicit = vi.spyOn(c8yMcpServer, 'elicitation')
      .mockRejectedValueOnce(signal)
      .mockResolvedValue({ action: 'accept' } as never)

    await expect(getFreshCliCredentials(TENANT)).rejects.toBe(signal)
    await expect(getFreshCliCredentials(TENANT)).resolves.toEqual(expiring)
    expect(elicit.mock.calls[1]![1]).toBe(elicit.mock.calls[0]![1])
    expect((await fetch(elicit.mock.calls[0]![1] as unknown as string)).status).toBe(200)
  })

  it('closes the unseen page when the elicitation fails on a still-valid session', async () => {
    const expiring = storedCreds(Date.now() + 60_000)
    globalThis._getCredentialsByTenantUrl = vi.fn(async () => expiring)
    stubClient('url')
    const elicit = vi.spyOn(c8yMcpServer, 'elicitation').mockRejectedValue(new Error('boom'))

    await expect(getFreshCliCredentials(TENANT)).resolves.toEqual(expiring)
    await vi.waitFor(async () => expect(await isClosed(elicit.mock.calls[0]![1] as unknown as string)).toBe(true))
  })

  it.each([
    ['the page cannot start', () => {
      serveFailure.error = new Error('EADDRNOTAVAIL')
    }],
    ['the keyring re-read fails', () => {
      const expiring = storedCreds(Date.now() + 60_000)
      globalThis._getCredentialsByTenantUrl = vi.fn()
        .mockResolvedValueOnce(expiring)
        .mockRejectedValue(new Error('keyring busy'))
    }],
  ])('goes ahead with a still-valid session when %s', async (_, arrange) => {
    const expiring = storedCreds(Date.now() + 60_000)
    globalThis._getCredentialsByTenantUrl = vi.fn(async () => expiring)
    stubClient('url')
    arrange()
    const elicit = vi.spyOn(c8yMcpServer, 'elicitation')

    await expect(getFreshCliCredentials(TENANT)).resolves.toEqual(expiring)
    expect(elicit).not.toHaveBeenCalled()
  })

  it('does not cancel the page while its own POST is running', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    let finishCheck!: (session: typeof RENEWED) => void
    requestTfaSession.mockImplementation(() => new Promise((resolve) => {
      finishCheck = resolve
    }))
    const { pending, url } = await startAccepted()

    const post = postCode(url, '123456')
    await vi.waitFor(() => expect(requestTfaSession).toHaveBeenCalled())
    // The keyring already looks renewed (as it would during the page's own
    // write); the poll must leave the busy page alone.
    globalThis._getCredentialsByTenantUrl = vi.fn(async () => storedCreds(Date.now() + 3600_000))
    await vi.advanceTimersByTimeAsync(KEYRING_POLL_MS)
    finishCheck(RENEWED)

    expect(await (await post).text()).toContain('Done.')
    await expect(pending).resolves.toHaveProperty('tfaSession.token', 'new')
  })

  it('stops waiting when the keyring was renewed elsewhere', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const { pending, url } = await startAccepted()
    const renewedElsewhere = storedCreds(Date.now() + 3600_000)
    globalThis._getCredentialsByTenantUrl = vi.fn(async () => renewedElsewhere)

    await vi.advanceTimersByTimeAsync(KEYRING_POLL_MS)
    await expect(pending).resolves.toEqual(renewedElsewhere)
    vi.useRealTimers()
    await vi.waitFor(async () => expect(await isClosed(url)).toBe(true))
  })

  it('says "less than a minute" when the page is about to close', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const openedAt = Date.now()
    stubClient('none')
    const first = await getFreshCliCredentials(TENANT).catch((error: unknown) => String(error))
    expect(first).toContain('within 5 minutes')
    vi.setSystemTime(openedAt + URL_RENEWAL_TIMEOUT_MS - 30_000)
    const second = await getFreshCliCredentials(TENANT).catch((error: unknown) => String(error))
    expect(second).toContain('within less than a minute')
    vi.setSystemTime(openedAt + URL_RENEWAL_TIMEOUT_MS - 60_000)
    const third = await getFreshCliCredentials(TENANT).catch((error: unknown) => String(error))
    expect(third).toMatch(/within 1 minute,/)
  })

  it('closes the page after the timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { pending, url } = await startAccepted()
    vi.advanceTimersByTime(URL_RENEWAL_TIMEOUT_MS)
    await expect(pending).rejects.toThrow(`within ${URL_RENEWAL_TIMEOUT_MS / 60_000} minutes`)
    vi.useRealTimers()
    expect(await isClosed(url)).toBe(true)
  })

  it('opens a new page with a new elicitation key once the old one closed', async () => {
    stubClient('url')
    const elicit = vi.spyOn(c8yMcpServer, 'elicitation').mockResolvedValue({ action: 'decline' } as never)
    await expect(getFreshCliCredentials(TENANT)).rejects.toThrow()
    await expect(getFreshCliCredentials(TENANT)).rejects.toThrow()

    const [first, second] = elicit.mock.calls.map((call) => call as unknown as [string, string, { key: string }])
    expect(second![1]).not.toBe(first![1])
    expect(second![2].key).not.toBe(first![2].key)
  })
})

describe('getFreshCliCredentials fallbacks', () => {
  it.each(['none', 'form'] as const)('returns the page URL when the client has elicitation %s', async (capability) => {
    stubClient(capability)
    const elicit = vi.spyOn(c8yMcpServer, 'elicitation')
    requestTfaSession.mockResolvedValue(RENEWED)

    const error = await getFreshCliCredentials(TENANT).catch((error: unknown) => error)
    expect(String(error)).toMatch(/expired at .*2026-07-28 protocol and URL elicitation.*Or open http.* within 5 minutes, enter the code there, and run the tool again\..*mc8yp creds add/)
    expect(elicit).not.toHaveBeenCalled()

    // The page outlives the failed call; the user renews there.
    const url = urlFromError(error)
    expect(await (await postCode(url, '123456')).text()).toContain('Done.')
    expect(updateStoredTfaSession).toHaveBeenCalledWith(expect.objectContaining({ user: 'u' }), RENEWED)
  })

  it('keeps using a session that is close to expiry and shows the page once it ran out', async () => {
    stubClient('none')
    const expiring = storedCreds(Date.now() + 60_000)
    globalThis._getCredentialsByTenantUrl = vi.fn(async () => expiring)
    await expect(getFreshCliCredentials(TENANT)).resolves.toEqual(expiring)
    // No page yet: opening one would re-read the keyring first.
    expect(globalThis._getCredentialsByTenantUrl).toHaveBeenCalledOnce()

    globalThis._getCredentialsByTenantUrl = vi.fn(async () => storedCreds(Date.now() - 1000))
    requestTfaSession.mockResolvedValue(RENEWED)
    const url = urlFromError(await getFreshCliCredentials(TENANT).catch((error: unknown) => error))
    expect(await (await postCode(url, '123456')).text()).toContain('Done.')
  })

  it('does not open a page when the keyring already holds a fresh session', async () => {
    stubClient('url')
    const elicit = vi.spyOn(c8yMcpServer, 'elicitation')
    const fresh = storedCreds(Date.now() + 3600_000)
    globalThis._getCredentialsByTenantUrl = vi.fn()
      .mockResolvedValueOnce(storedCreds(Date.now() - 1000))
      .mockResolvedValue(fresh)

    await expect(getFreshCliCredentials(TENANT)).resolves.toBe(fresh)
    expect(elicit).not.toHaveBeenCalled()
  })

  it('returns the page URL when the elicitation fails', async () => {
    stubClient('url')
    vi.spyOn(c8yMcpServer, 'elicitation').mockRejectedValue(new Error('Client doesn\'t support url mode elicitation'))

    const error = await getFreshCliCredentials(TENANT).catch((error: unknown) => error)
    expect(String(error)).toMatch(/The client could not show the renewal link \(Client doesn't support url mode elicitation\)\. To renew, open http/)
    expect((await fetch(urlFromError(error))).status).toBe(200)
  })

  it('rethrows the input-required signal and keeps the page for the retry', async () => {
    stubClient('url')
    const signal = Object.assign(new Error('input required'), { name: 'TestInputRequired' })
    const elicit = vi.spyOn(c8yMcpServer, 'elicitation')
      .mockRejectedValueOnce(signal)
      .mockResolvedValue({ action: 'accept' } as never)
    requestTfaSession.mockResolvedValue(RENEWED)

    await expect(getFreshCliCredentials(TENANT)).rejects.toBe(signal)
    const [, url, options] = elicit.mock.calls[0]! as unknown as [string, string, { key: string }]
    expect((await fetch(url)).status).toBe(200)

    const retry = getFreshCliCredentials(TENANT)
    await vi.waitFor(() => expect(elicit).toHaveBeenCalledTimes(2))
    expect(elicit.mock.calls[1]![1]).toBe(url)
    expect((elicit.mock.calls[1]![2] as { key: string }).key).toBe(options.key)
    await postCode(url, '123456')
    await expect(retry).resolves.toHaveProperty('tfaSession.token', 'new')
  })

  it('wraps a failure to open the page with the session state', async () => {
    stubClient('url')
    serveFailure.error = new Error('EADDRNOTAVAIL')

    await expect(getFreshCliCredentials(TENANT)).rejects.toThrow(/expired at .*Opening the local TFA page failed \(EADDRNOTAVAIL\)\..*mc8yp creds add/)
  })
})

describe('TFA page POST handling', () => {
  it('rejects a body that is not a form', async () => {
    const { url } = await startAccepted()
    const response = await fetch(url, { method: 'POST', body: '{"code":1}', headers: { 'content-type': 'application/json' } })
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('Send the code with the form')
  })

  it.each([
    ['changed', 'changed while the TFA page was open', async () => ({ ...storedCreds(Date.now() - 1000), password: 'other' })],
    ['removed', 'No stored credentials found', async () => {
      throw new Error(`No stored credentials found for tenant URL: ${TENANT}`)
    }],
  ])('refuses to write when the stored credentials were %s', async (_, failure, reread) => {
    const { pending, url } = await startAccepted()
    globalThis._getCredentialsByTenantUrl = vi.fn(reread)

    const response = await postCode(url, '123456')
    expect(response.status).toBe(409)
    expect(await response.text()).toContain('Run the tool again')
    await expect(pending).rejects.toThrow(failure)
    expect(requestTfaSession).not.toHaveBeenCalled()
    expect(updateStoredTfaSession).not.toHaveBeenCalled()
  })

  it('returns a usable new login after the credentials changed', async () => {
    const { pending, url } = await startAccepted()
    const newLogin = { ...storedCreds(Date.now() + 3600_000), password: 'other' }
    globalThis._getCredentialsByTenantUrl = vi.fn(async () => newLogin)

    expect((await postCode(url, '123456')).status).toBe(409)
    await expect(pending).resolves.toEqual(newLogin)
  })

  it('rejects a body over 1 KiB', async () => {
    const { url } = await startAccepted()
    const response = await postCode(url, `123456${'0'.repeat(2000)}`)
    expect(response.status).toBe(413)
    expect(await response.text()).toContain('too large')
  })

  it('shows a finished notice instead of the form after the renewal settled', async () => {
    // The server stops accepting connections once the renewal settles, so
    // the only way to reach it then is a request sent after the settle on a
    // connection whose earlier request is still in flight.
    let finishCheck!: (session: typeof RENEWED) => void
    requestTfaSession.mockImplementation(() => new Promise((resolve) => {
      finishCheck = resolve
    }))
    const { url } = await startAccepted()
    const { port, pathname } = new URL(url)
    const socket = connect(Number(port), '127.0.0.1')
    let text = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      text += chunk
    })
    const body = 'code=123456'
    socket.write(`POST ${pathname} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: ${body.length}\r\n\r\n${body}`)
    await vi.waitFor(() => expect(requestTfaSession).toHaveBeenCalled())
    await cancelUrlRenewals()
    socket.write(`GET ${pathname} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`)
    finishCheck(RENEWED)
    await new Promise((resolve) => {
      socket.once('close', resolve)
    })
    const getResponse = text.slice(text.lastIndexOf('HTTP/1.1'))
    expect(getResponse).toContain('This renewal is already finished (or was cancelled)')
    expect(getResponse).not.toContain('<form')
  })

  it('refuses to write when the credentials change while the code is checked', async () => {
    const { pending, url } = await startAccepted()
    requestTfaSession.mockImplementation(async () => {
      globalThis._getCredentialsByTenantUrl = vi.fn(async () => ({ ...storedCreds(Date.now() - 1000), password: 'other' }))
      return RENEWED
    })

    const response = await postCode(url, '123456')
    expect(response.status).toBe(409)
    await expect(pending).rejects.toThrow('changed while the TFA page was open')
    expect(updateStoredTfaSession).not.toHaveBeenCalled()
  })

  it('writes nothing when the renewal is cancelled during the second keyring read', async () => {
    const { pending, url } = await startAccepted()
    requestTfaSession.mockImplementation(async () => {
      const stored = globalThis._getCredentialsByTenantUrl
      globalThis._getCredentialsByTenantUrl = vi.fn(async (tenantUrl: string) => {
        await cancelUrlRenewals()
        return stored(tenantUrl)
      })
      return RENEWED
    })

    const response = await postCode(url, '123456')
    expect(response.status).toBe(409)
    expect(await response.text()).toContain('cancelled or timed out')
    await expect(pending).rejects.toThrow('Cancelled.')
    expect(updateStoredTfaSession).not.toHaveBeenCalled()
  })

  it('keeps the page open when reading the keyring fails', async () => {
    requestTfaSession.mockResolvedValue(RENEWED)
    const { pending, url } = await startAccepted()
    const working = globalThis._getCredentialsByTenantUrl
    globalThis._getCredentialsByTenantUrl = vi.fn().mockRejectedValueOnce(new Error('keyring busy')).mockImplementation(working)

    const failed = await postCode(url, '123456')
    expect(failed.status).toBe(500)
    expect(await failed.text()).toContain('Reading the stored credentials failed (keyring busy)')
    expect(requestTfaSession).not.toHaveBeenCalled()

    expect(await (await postCode(url, '234567')).text()).toContain('Done.')
    await expect(pending).resolves.toHaveProperty('tfaSession.token', 'new')
  })

  it('says the session was saved when the renewal was cancelled during the write', async () => {
    requestTfaSession.mockResolvedValue(RENEWED)
    const { pending, url } = await startAccepted()
    updateStoredTfaSession.mockImplementationOnce(async (creds, tfaSession) => {
      await cancelUrlRenewals()
      return { ...creds, tfaSession }
    })

    const response = await postCode(url, '123456')
    expect(response.status).toBe(409)
    const text = await response.text()
    expect(text).toContain('accepted and the new session is saved, but the tool call already gave up')
    expect(text).not.toContain('Done.')
    await expect(pending).rejects.toThrow('Cancelled.')
  })

  it('answers 409 while a code is checked and writes nothing after a cancel', async () => {
    let finishCheck!: (session: typeof RENEWED) => void
    requestTfaSession.mockImplementation(() => new Promise((resolve) => {
      finishCheck = resolve
    }))
    const { pending, url } = await startAccepted()

    const first = postCode(url, '123456')
    await vi.waitFor(() => expect(requestTfaSession).toHaveBeenCalled())
    const second = await postCode(url, '654321')
    expect(second.status).toBe(409)
    expect(await second.text()).toContain('already being checked')

    await cancelUrlRenewals()
    await expect(pending).rejects.toThrow('Cancelled.')
    finishCheck(RENEWED)
    const late = await first
    expect(late.status).toBe(409)
    expect(await late.text()).toContain('cancelled or timed out')
    expect(updateStoredTfaSession).not.toHaveBeenCalled()
    expect(requestTfaSession).toHaveBeenCalledOnce()
  })

  it('tells an accepted code apart from a failed keyring write', async () => {
    requestTfaSession.mockResolvedValue(RENEWED)
    updateStoredTfaSession.mockRejectedValueOnce(new Error('keyring locked'))
    const { pending, url } = await startAccepted()

    const failed = await postCode(url, '123456')
    expect(failed.status).toBe(500)
    expect(await failed.text()).toContain('The code was accepted, but saving the new session failed (keyring locked)')

    expect(await (await postCode(url, '234567')).text()).toContain('Done.')
    await expect(pending).resolves.toHaveProperty('tfaSession.token', 'new')
  })
})

describe('TFA renewal through tmcp (2026-07-28 per-request protocol)', () => {
  const PROBE_TOOL = 'tfa-probe'
  c8yMcpServer.tool(
    { name: PROBE_TOOL, description: 'Renews the TFA session of the test tenant.', schema: v.object({}), replayable: true },
    async () => {
      const creds = await getFreshCliCredentials(TENANT)
      return { content: [{ type: 'text', text: creds.tfaSession?.token ?? '' }] }
    },
  )

  it('returns a URL input request, then completes the retry after the page POST', async () => {
    requestTfaSession.mockResolvedValue(RENEWED)
    const meta = {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': { elicitation: { url: {} } },
      'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1.0.0' },
    }

    const first = await c8yMcpServer.receive({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: PROBE_TOOL, arguments: {}, _meta: meta },
    }) as { result: { resultType: string, inputRequests: Record<string, { method: string, params: { mode: string, url: string } }>, requestState?: string } }
    expect(first.result.resultType).toBe('input_required')
    const [[key, request]] = Object.entries(first.result.inputRequests)
    expect(request!.method).toBe('elicitation/create')
    expect(request!.params.mode).toBe('url')
    expect(request!.params.url.endsWith(`/${key}`)).toBe(true)

    expect(await (await postCode(request!.params.url, '123456')).text()).toContain('Done.')
    // The keyring now holds the renewed session; the retry reads it.
    globalThis._getCredentialsByTenantUrl = vi.fn(async () => ({ ...storedCreds(), tfaSession: RENEWED }))

    const retry = await c8yMcpServer.receive({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: PROBE_TOOL,
        arguments: {},
        _meta: meta,
        inputResponses: { [key!]: { action: 'accept' } },
        ...(first.result.requestState ? { requestState: first.result.requestState } : {}),
      },
    }) as { result: { content: Array<{ text: string }>, isError?: boolean } }
    expect(retry.result.isError).toBeFalsy()
    expect(retry.result.content[0]!.text).toBe('new')
  })

  it('completes the retry when the page is submitted after the client answered', async () => {
    requestTfaSession.mockResolvedValue(RENEWED)
    const meta = {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': { elicitation: { url: {} } },
      'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1.0.0' },
    }
    const first = await c8yMcpServer.receive({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: PROBE_TOOL, arguments: {}, _meta: meta },
    }) as { result: { inputRequests: Record<string, { params: { url: string } }> } }
    const [[key, request]] = Object.entries(first.result.inputRequests)

    // Calls through: the spy only shows when the retry consumed its stored
    // answer and moved on to wait for the page.
    const elicit = vi.spyOn(c8yMcpServer, 'elicitation')
    const retry = c8yMcpServer.receive({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: PROBE_TOOL, arguments: {}, _meta: meta, inputResponses: { [key!]: { action: 'accept' } } },
    }) as Promise<{ result: { content: Array<{ text: string }> } }>
    await vi.waitFor(() => expect(elicit.mock.settledResults[0]).toEqual({ type: 'fulfilled', value: { action: 'accept' } }))
    await postCode(request!.params.url, '123456')
    expect((await retry).result.content[0]!.text).toBe('new')
  })
})
