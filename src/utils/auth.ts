import { Buffer } from 'node:buffer'
import type { C8yAuth } from './credentials'
import { parseURL } from 'ufo'

/**
 * Extract authentication credentials from HTTP request headers.
 * Supports both Basic and Bearer authentication.
 * @param request - The incoming HTTP request
 * @returns Extracted credentials or throws error if invalid/missing
 */
export function extractAuthFromHeaders(request: Request): C8yAuth {
  const authorization = request.headers.get('authorization')

  if (!authorization) {
    throw new Error('Missing Authorization header')
  }

  // Get the tenant URL from the request URL (extract protocol + host)
  const requestURL = parseURL(request.url)
  if (!requestURL.protocol || !requestURL.host) {
    throw new Error('Invalid request URL')
  }
  const tenantUrl = `${requestURL.protocol}//${requestURL.host}`

  if (authorization.startsWith('Basic ')) {
    try {
      const encoded = authorization.slice(6) // Remove 'Basic ' prefix
      const decoded = Buffer.from(encoded, 'base64').toString('utf-8')
      const colonIndex = decoded.indexOf(':')

      if (colonIndex === -1) {
        throw new Error('Invalid Basic auth format')
      }

      const username = decoded.slice(0, colonIndex)
      const password = decoded.slice(colonIndex + 1)

      // Extract tenant from username if in format "tenant/username"
      const slashIndex = username.indexOf('/')
      let user = username

      if (slashIndex !== -1) {
        user = username.slice(slashIndex + 1)
      }

      return {
        user,
        password,
        tenantUrl,
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
      }
    } catch (error) {
      throw new Error('Invalid Bearer token', { cause: error })
    }
  }

  throw new Error('Unsupported authentication method. Use Basic or Bearer.')
}
