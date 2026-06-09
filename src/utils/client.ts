/**
 * Shared client authentication utility.
 * Centralizes the logic for getting an authenticated C8y client.
 */

import { Buffer } from 'node:buffer'
import { Client } from '@c8y/client'
import type { C8yAuth } from './credentials'
import { c8yMcpServer } from '../server-instance'
import type { RequestAuth } from '../types/mcp-context'

export type { RequestAuth }

/**
 * Map a \@c8y/client error (which is thrown as `{ res, data }` for HTTP
 * statuses >= 400) to a short human-readable string.
 * @param err - Error thrown by an \@c8y/client service call
 */
export function c8yErrorSummary(err: unknown): string {
  if (err && typeof err === 'object' && 'res' in err) {
    const r = (err as { res?: { status?: number, statusText?: string } }).res
    if (r && typeof r.status === 'number')
      return `${r.status} ${r.statusText ?? ''}`.trim()
  }
  return err instanceof Error ? err.message : String(err)
}

export async function resolveC8yAuth(): Promise<C8yAuth | RequestAuth> {
  const custom = c8yMcpServer.ctx.custom
  const auth = custom?.auth
  if (!auth) {
    throw new Error(
      custom?.env === 'cli'
        ? 'No active tenant set. Call the set-active-tenant tool with your Cumulocity tenant URL first.'
        : 'No tenant context available. This is a server configuration issue — the MCP connection is missing required auth context.',
    )
  }
  return auth
}

export function createC8yAuthHeaders(auth: C8yAuth | RequestAuth): Record<string, string> {
  if ('authorizationHeader' in auth) {
    return {
      Authorization: auth.authorizationHeader,
    }
  }

  if ('token' in auth && auth.token) {
    return {
      Authorization: `Bearer ${auth.token}`,
    }
  }

  if ('user' in auth && 'password' in auth && 'tenantId' in auth && auth.user && auth.password && auth.tenantId) {
    const credentials = Buffer.from(`${auth.tenantId}/${auth.user}:${auth.password}`).toString('base64')
    return {
      Authorization: `Basic ${credentials}`,
    }
  }

  throw new Error('Invalid authentication credentials')
}

/**
 * Get an authenticated Cumulocity client.
 * In CLI mode, tenantUrl is required and credentials are fetched from keystore.
 * In server mode, credentials are extracted from the auth context.
 * @returns Authenticated Cumulocity client instance
 */
export async function getAuthenticatedClient(): Promise<Client> {
  const auth = await resolveC8yAuth() as C8yAuth

  if ('token' in auth && auth.token) {
    const client = await Client.authenticate({
      token: auth.token,
    }, auth.tenantUrl)
    return client
  }

  if ('user' in auth && 'password' in auth && 'tenantId' in auth && auth.user && auth.password && auth.tenantId) {
    return Client.authenticate({
      tenant: auth.tenantId,
      user: auth.user,
      password: auth.password,
    }, auth.tenantUrl)
  }

  throw new Error('Invalid authentication credentials')
}
