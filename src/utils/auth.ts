import { Buffer } from 'node:buffer'
import type { AuthContext } from './credentials'
import process from 'node:process'

/**
 * Extract authentication credentials from HTTP request headers.
 * Supports both Basic and Bearer authentication.
 * @param request - The incoming HTTP request
 * @returns Extracted credentials or throws error if invalid/missing
 */
export function extractAuthFromHeaders(request: Request): AuthContext {
  const authorization = request.headers.get('authorization')

  if (!authorization) {
    throw new Error('Missing Authorization header')
  }

  // Get the tenant URL from the request URL (extract protocol + host)
  const tenantUrl = process.env.C8Y_BASEURL!

  if (authorization.startsWith('Basic ')) {
    try {
      const encoded = authorization.slice(6) // Remove 'Basic ' prefix
      const decoded = Buffer.from(encoded, 'base64').toString('utf-8')
      const colonIndex = decoded.indexOf(':')

      if (colonIndex === -1) {
        throw new Error('Invalid Basic auth format')
      }

      const principal = decoded.slice(0, colonIndex)
      const password = decoded.slice(colonIndex + 1)
      const slashIndex = principal.indexOf('/')

      if (slashIndex === -1) {
        throw new Error('Basic auth must include tenantId/user')
      }

      const tenantId = principal.slice(0, slashIndex)
      const username = principal.slice(slashIndex + 1)

      return {
        user: username,
        password,
        tenantId,
        tenantUrl,
        authorizationHeader: authorization,
      }
    } catch (error) {
      throw new Error('Invalid Basic authentication credentials', { cause: error })
    }
  } else if (authorization.startsWith('Bearer ')) {
    try {
      const token = authorization.slice(7) // Remove 'Bearer ' prefix

      if (!token) {
        throw new Error('Empty Bearer token')
      }

      return {
        token,
        tenantUrl,
        authorizationHeader: authorization,
      }
    } catch (error) {
      throw new Error('Invalid Bearer token', { cause: error })
    }
  }

  throw new Error('Unsupported authentication method. Use Basic or Bearer.')
}
