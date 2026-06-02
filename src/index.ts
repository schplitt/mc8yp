import { HttpTransport } from '@tmcp/transport-http'
import consola from 'consola'
import { getQuery, H3, HTTPError, serve } from 'h3'
import { c8yMcpServer, setupMcpServer } from './server'
import { getAuthContext } from './ctx/auth'
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

globalThis.executionEnvironment = 'server'

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
    .then((specs) => {
      consola.info(`Startup discovery complete: ${specs.length} microservice API spec(s) found`)
    })
    .catch((err: unknown) => {
      consola.warn('Startup API spec discovery failed:', err instanceof Error ? err.message : String(err))
    })
}

setupMcpServer()

const transport = new HttpTransport(c8yMcpServer, {
  path: '/mcp',
  disableSse: true,
})

const app = new H3().all('/mcp', async (event) => {
  // Extract authentication from request headers
  const credentials = extractAuthFromHeaders(event.req)

  // Start discovery for this tenant (idempotent) and await it.
  // The promise resolves immediately on subsequent requests once the cache is warm.
  const discoveredSpecs = await startDiscovery(credentials.tenantUrl, createC8yAuthHeaders(credentials))
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

  // Set auth context for the request
  const authContext = getAuthContext()
  return authContext.call(credentials, () => transport.respond(event.req, { restrictions, allowRules: parsedAllowRules, discoveredSpecs }))
})

// Bust the cache for the requesting tenant and restart discovery immediately.
// Returns the freshly discovered spec metadata.
app.post('/refresh-apis', async (event) => {
  try {
    const credentials = extractAuthFromHeaders(event.req)
    const authHeaders = createC8yAuthHeaders(credentials)
    const specs = await refreshApiSpecs(credentials.tenantUrl, authHeaders)
    return {
      message: 'API spec discovery completed',
      tenantUrl: credentials.tenantUrl,
      discovered: specs.map((s) => ({
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
