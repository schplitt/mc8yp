/**
 * Shared client authentication utility.
 * Centralizes the logic for getting an authenticated C8y client.
 */

import { Client } from '@c8y/client'
import { useAuth } from '../ctx/auth'
import * as v from 'valibot'

const tenantUrlSchema = v.object({
  tenantUrl: v.string(),
})

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
  const executionEnvironment = globalThis.executionEnvironment

  if (executionEnvironment === 'server') {
    // In server mode, get credentials from auth context
    const auth = useAuth()

    if (!auth) {
      throw new Error('No authentication context available')
    }

    // Create client based on auth type
    if ('token' in auth && auth.token) {
      // Bearer token authentication
      const client = await Client.authenticate({
        token: auth.token,
      }, auth.tenantUrl)
      return client
    } else if ('user' in auth && 'password' in auth && auth.user && auth.password) {
      // Basic authentication
      return Client.authenticate({
        user: auth.user,
        password: auth.password,
      }, auth.tenantUrl)
    } else {
      throw new Error('Invalid authentication credentials in context')
    }
  }

  // CLI mode - validate input and get credentials from keystore
  const parsed = v.safeParse(tenantUrlSchema, input)
  if (!parsed.success) {
    throw new Error('tenantUrl is required in CLI mode')
  }

  const { tenantUrl } = parsed.output
  const credentials = await globalThis._getCredentialsByTenantUrl(tenantUrl)

  if ('user' in credentials && 'password' in credentials && credentials.user && credentials.password) {
    return Client.authenticate({
      user: credentials.user,
      password: credentials.password,
    }, credentials.tenantUrl)
  }

  throw new Error('Invalid credentials: user and password are required in CLI mode')
}
