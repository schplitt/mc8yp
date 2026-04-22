/**
 * Shared client authentication utility.
 * Centralizes the logic for getting an authenticated C8y client.
 */

import { Buffer } from 'node:buffer'
import { Client } from '@c8y/client'
import type { AuthContext, C8yAuth } from './credentials'
import { useAuth } from '../ctx/auth'
import * as v from 'valibot'

const tenantUrlSchema = v.object({
  tenantUrl: v.string(),
})

export async function resolveC8yAuth(input: unknown): Promise<C8yAuth | AuthContext>
export async function resolveC8yAuth(): Promise<C8yAuth | AuthContext>
export async function resolveC8yAuth(input?: unknown): Promise<C8yAuth | AuthContext> {
  const executionEnvironment = globalThis.executionEnvironment

  if (executionEnvironment === 'server') {
    const auth = useAuth()

    if (!auth) {
      throw new Error('No authentication context available')
    }

    return auth
  }

  const parsed = v.safeParse(tenantUrlSchema, input)
  if (!parsed.success) {
    throw new Error('tenantUrl is required in CLI mode')
  }

  return globalThis._getCredentialsByTenantUrl(parsed.output.tenantUrl)
}

export function createC8yAuthHeaders(auth: C8yAuth | AuthContext): Record<string, string> {
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
 * @param input - Optional input containing tenantUrl (required only in CLI mode)
 * @returns Authenticated Cumulocity client instance
 */
export async function getAuthenticatedClient(input: unknown): Promise<Client>
export async function getAuthenticatedClient(): Promise<Client>
export async function getAuthenticatedClient(input?: unknown): Promise<Client> {
  const auth = await resolveC8yAuth(input)

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
