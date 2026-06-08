import { HttpTransport } from '@tmcp/transport-http'
import consola from 'consola'
import { getQuery, H3, HTTPError, serve } from 'h3'
import { c8yMcpServer, setupMcpServer } from './server'
import process from 'node:process'
import { extractAuthFromHeaders } from './utils/auth'
import {
  ALLOW_HEADER,
  ALLOW_QUERY_KEYS,
  RESTRICTION_HEADER,
  RESTRICTION_QUERY_KEYS,
  collectServerAllowSources,
  collectServerRestrictionSources,
  parseAllowRule,
  parseRestrictionRule,
} from './utils/restrictions'
import { Buffer } from 'node:buffer'
import { refreshApiSpecs, startDiscovery } from './utils/api-discovery'
import { createC8yAuthHeaders } from './utils/client'
import { KNOWN_BUNDLED_SERVICES, createServiceUnavailableRestrictionRules } from './utils/openapi'
import { resolveSpecs } from './utils/spec-resolution'

// Eagerly start API spec discovery at server startup using Cumulocity bootstrap
// credentials if they are available in the environment. This warms the cache
// before the first user request arrives so tool descriptions show accurate types.
const C8Y_BASEURL = process.env.C8Y_BASEURL ?? ''
const C8Y_BOOTSTRAP_TENANT = process.env.C8Y_BOOTSTRAP_TENANT ?? ''
const C8Y_BOOTSTRAP_USER = process.env.C8Y_BOOTSTRAP_USER ?? ''
const C8Y_BOOTSTRAP_PASSWORD = process.env.C8Y_BOOTSTRAP_PASSWORD ?? ''

if (C8Y_BASEURL && C8Y_BOOTSTRAP_USER && C8Y_BOOTSTRAP_PASSWORD) {
  const principal = C8Y_BOOTSTRAP_TENANT
    ? `${C8Y_BOOTSTRAP_TENANT}/${C8Y_BOOTSTRAP_USER}`
    : C8Y_BOOTSTRAP_USER
  const bootstrapAuth = `Basic ${Buffer.from(`${principal}:${C8Y_BOOTSTRAP_PASSWORD}`).toString('base64')}`
  startDiscovery(C8Y_BASEURL, { Authorization: bootstrapAuth })
    .then((result) => {
      consola.info(`Startup discovery complete: ${result.specs.length} microservice API spec(s) found`)
    })
    .catch((err: unknown) => {
      consola.warn('Startup API spec discovery failed:', err instanceof Error ? err.message : String(err))
    })
}

setupMcpServer('server')

const transport = new HttpTransport(c8yMcpServer, {
  path: '/mcp',
  disableSse: true,
})

const app = new H3().all('/mcp', async (event) => {
  // Extract authentication from request headers
  const credentials = extractAuthFromHeaders(event.req)

  // Per-tenant discovery cache. The first request for a tenant blocks until
  // discovery completes; subsequent requests resolve immediately from the cached
  // promise. The 30-minute refresh timer replaces the promise so new callers
  // automatically await the refreshed result while old callers keep their result.
  const discoveryResult = await startDiscovery(credentials.tenantUrl, createC8yAuthHeaders(credentials))
  const { specs: discoveredSpecs, installedContextPaths } = discoveryResult

  // Auto-restrict execute access to known bundled services not installed on this tenant.
  const unavailableContextPaths = Object.values(KNOWN_BUNDLED_SERVICES)
    .filter((s) => !installedContextPaths.has(s.contextPath))
    .map((s) => s.contextPath)
  const autoRestrictions = createServiceUnavailableRestrictionRules(unavailableContextPaths)

  // Flat spec map + specsEnabled (per-service installation flags).
  // Server mode always runs with specRemoval=true: bundled services absent from
  // this tenant are injected as null in the sandbox.
  const { specs, specsEnabled } = resolveSpecs(discoveredSpecs, installedContextPaths, true)

  const query = getQuery(event)
  const restrictionSources = collectServerRestrictionSources(query, event.req.headers)
  const { parsedRules: restrictions, failedRules: failedRestrictions } = parseRestrictionRule(restrictionSources)

  if (failedRestrictions.length > 0) {
    throw new HTTPError({
      status: 400,
      statusText: 'Invalid restriction policy',
      message: `One or more restriction values from query params (${RESTRICTION_QUERY_KEYS.map((key) => `?${key}`).join(', ')}) or the ${RESTRICTION_HEADER} header could not be parsed.`,
      data: {
        failedRules: failedRestrictions,
      },
    })
  }

  const allowSources = collectServerAllowSources(query, event.req.headers)
  const { parsedRules: parsedAllowRules, failedRules: failedAllowRules } = parseAllowRule(allowSources)

  if (failedAllowRules.length > 0) {
    throw new HTTPError({
      status: 400,
      statusText: 'Invalid allow policy',
      message: `One or more allow values from query params (${ALLOW_QUERY_KEYS.map((key) => `?${key}`).join(', ')}) or the ${ALLOW_HEADER} header could not be parsed.`,
      data: {
        failedRules: failedAllowRules,
      },
    })
  }

  const effectiveRestrictions = autoRestrictions.length > 0 ? [...restrictions, ...autoRestrictions] : restrictions

  return transport.respond(event.req, {
    env: 'server' as const,
    auth: { tenantUrl: credentials.tenantUrl, authorizationHeader: credentials.authorizationHeader },
    restrictions: effectiveRestrictions,
    allowRules: parsedAllowRules,
    specs,
    specsEnabled,
  })
})

// Bust the cache for the requesting tenant and restart discovery immediately.
// Returns the freshly discovered spec metadata.
app.post('/refresh-apis', async (event) => {
  try {
    const credentials = extractAuthFromHeaders(event.req)
    const authHeaders = createC8yAuthHeaders(credentials)
    const result = await refreshApiSpecs(credentials.tenantUrl, authHeaders)
    return {
      message: 'API spec discovery completed',
      tenantUrl: credentials.tenantUrl,
      installedContextPaths: [...result.installedContextPaths],
      discovered: result.specs.map((s) => ({
        contextPath: s.contextPath,
        specLabel: s.specLabel,
        pathCount: Object.keys(
          (s.spec as { paths?: Record<string, unknown> }).paths ?? {},
        ).length,
      })),
    }
  } catch (err) {
    throw new HTTPError({
      status: 500,
      statusText: 'Discovery failed',
      message: err instanceof Error ? err.message : 'Failed to refresh API specs',
    })
  }
})

app.get('/health', () => 'OK')

app.get('/', () => 'C8Y MCP Server is running!')

const port = parseInt(process.env.PORT ?? process.env.SERVER_PORT ?? '3000', 10)

consola.info(`Starting C8Y MCP over HTTP Transport on port ${port}...`)

serve(app, { port })
