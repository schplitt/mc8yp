import { HttpTransport } from '@tmcp/transport-http'
import consola from 'consola'
import { getQuery, H3, HTTPError, serve } from 'h3'
import openApiSpec from '../openapi.json' with { type: 'json' }
import { c8yMcpServer, setupMcpServer } from './server'
import { createSandboxEvictingInfoSessionManager } from './codemode/sandbox/session-eviction'
import process from 'node:process'
import {
  ALLOW_HEADER,
  ALLOW_QUERY_KEYS,
  RESTRICTION_HEADER,
  RESTRICTION_QUERY_KEYS,
  collectServerAllowSources,
  collectServerNoMcpSources,
  collectServerRestrictionSources,
  parseAllowRule,
  parseNoMcp,
  parseRestrictionRule,
} from './utils/restrictions'
import { BasicAuth, Client, MicroserviceClientRequestAuth } from '@c8y/client'
import { getCachedDiscovery, refreshCapabilities } from './utils/capability-discovery'
import { resolveCapabilities } from './utils/capability-resolution'
import { getServiceUserCredentials, startSubscriptionsRefresh } from './utils/subscriptions'

// Microservice mode requires bootstrap credentials. The subscriptions cache
// fetches per-tenant service-user creds via the bootstrap user, and proactive
// discovery rides on every successful refresh. Hard-fail at startup so
// misconfigured deployments do not silently degrade.
startSubscriptionsRefresh() // throws synchronously if C8Y_BOOTSTRAP_* / C8Y_BASEURL are missing

setupMcpServer('server')

const transport = new HttpTransport(c8yMcpServer, {
  path: '/mcp',
  disableSse: true,
  // Evict a session's sandbox the moment the client closes cleanly (DELETE);
  // the 15-min idle TTL backstops sessions that never send one. `streams`
  // defaults to the transport's InMemoryStreamSessionManager.
  sessionManager: { info: createSandboxEvictingInfoSessionManager() },
})

const C8Y_BASEURL = process.env.C8Y_BASEURL!

const app = new H3().all('/mcp', async (event) => {
  // Probe fast path: the Cumulocity platform makes MCP requests without a
  // usable auth context (tool discovery, health-style introspection). Hand
  // the MCP server a minimal context so it can still list tools/prompts.
  // Any tool actually invoked in this state errors cleanly at call time.
  const authorizationHeader = event.req.headers.get('authorization') ?? undefined
  const cookieHeader = event.req.headers.get('cookie') ?? undefined
  if (!authorizationHeader && !cookieHeader) {
    return transport.respond(event.req, { env: 'server' as const })
  }

  // Authed request. Resolve the tenant via /tenant/currentTenant using the
  // user's own auth — works for Basic, Bearer, and OAI cookie alike because
  // MicroserviceClientRequestAuth handles all three. Best-effort: on any
  // failure we degrade to bundled-only specs instead of failing the request.
  const userClient = new Client(
    new MicroserviceClientRequestAuth({ authorization: authorizationHeader, cookie: cookieHeader }),
    C8Y_BASEURL,
  )
  let tenantId: string | undefined
  try {
    tenantId = (await userClient.tenant.current()).data?.name
  } catch {
    // Tenant resolution failed (rare). Specs stay undefined → bundled-only.
  }

  // Pre-warmed discovery cache lookup. On rejection the discovery cache has
  // already self-cleaned, so the client can retry and a fresh attempt runs
  // on the next subscriptions refresh.
  let specs: ReturnType<typeof resolveCapabilities> | undefined
  if (tenantId) {
    const cached = getCachedDiscovery(tenantId)
    if (cached) {
      const result = await cached
      specs = resolveCapabilities(result.specs, result.installedContextPaths, result.mcpServers)
    }
  }

  const query = getQuery(event)
  const restrictionSources = collectServerRestrictionSources(query, event.req.headers)
  const { parsedRules: restrictions, failedRules: failedRestrictions } = parseRestrictionRule(restrictionSources)

  if (failedRestrictions.length > 0) {
    throw new HTTPError({
      status: 400,
      statusText: 'Invalid restriction policy',
      message: `One or more restriction values from query params (${RESTRICTION_QUERY_KEYS.map((key) => `?${key}`).join(', ')}) or the ${RESTRICTION_HEADER} header could not be parsed.`,
      data: { failedRules: failedRestrictions },
    })
  }

  const allowSources = collectServerAllowSources(query, event.req.headers)
  const { parsedRules: parsedAllowRules, failedRules: failedAllowRules } = parseAllowRule(allowSources)

  if (failedAllowRules.length > 0) {
    throw new HTTPError({
      status: 400,
      statusText: 'Invalid allow policy',
      message: `One or more allow values from query params (${ALLOW_QUERY_KEYS.map((key) => `?${key}`).join(', ')}) or the ${ALLOW_HEADER} header could not be parsed.`,
      data: { failedRules: failedAllowRules },
    })
  }

  const noMcp = parseNoMcp(collectServerNoMcpSources(query, event.req.headers))

  return transport.respond(event.req, {
    env: 'server' as const,
    // execute uses authorizationHeader to forward the user's auth to
    // Cumulocity. If we only have a cookie, execute will fail with a clear
    // missing-auth error at invocation time — same shape as the CLI
    // no-active-tenant path.
    auth: authorizationHeader
      ? { tenantUrl: C8Y_BASEURL, authorizationHeader }
      : undefined,
    restrictions,
    allowRules: parsedAllowRules,
    noMcp,
    specs,
  })
})

// Bust the cache for the requesting tenant and restart discovery immediately.
// Returns the freshly discovered spec metadata.
app.post('/refresh-apis', async (event) => {
  try {
    const authorizationHeader = event.req.headers.get('authorization') ?? undefined
    const cookieHeader = event.req.headers.get('cookie') ?? undefined
    if (!authorizationHeader && !cookieHeader) {
      throw new HTTPError({
        status: 401,
        statusText: 'Unauthorized',
        message: 'Refresh requires user auth (Authorization header or session cookie).',
      })
    }

    const userClient = new Client(
      new MicroserviceClientRequestAuth({ authorization: authorizationHeader, cookie: cookieHeader }),
      C8Y_BASEURL,
    )
    const tenantId = (await userClient.tenant.current()).data?.name
    if (!tenantId) {
      throw new HTTPError({
        status: 400,
        statusText: 'Tenant resolution failed',
        message: 'Could not resolve current tenant via /tenant/currentTenant.',
      })
    }

    const subscribedCred = await getServiceUserCredentials(tenantId)
    if (!subscribedCred) {
      throw new HTTPError({
        status: 403,
        statusText: 'Tenant not subscribed',
        message: `Tenant '${tenantId}' is not subscribed to this microservice.`,
      })
    }

    const result = await refreshCapabilities(
      tenantId,
      new Client(new BasicAuth(subscribedCred), C8Y_BASEURL),
    )
    return {
      message: 'API spec discovery completed',
      tenantUrl: C8Y_BASEURL,
      tenantId,
      installedContextPaths: [...result.installedContextPaths],
      discovered: result.specs.map((s) => ({
        contextPath: s.contextPath,
        specLabel: s.specLabel,
        pathCount: Object.keys((s.spec as { paths?: Record<string, unknown> }).paths ?? {}).length,
      })),
    }
  } catch (err) {
    if (err instanceof HTTPError)
      throw err
    throw new HTTPError({
      status: 500,
      statusText: 'Discovery failed',
      message: err instanceof Error ? err.message : 'Failed to refresh API specs',
    })
  }
})

app.get('/health', () => 'OK')
app.get('/openapi.json', () => openApiSpec)

app.get('/', () => 'C8Y MCP Server is running!')

const port = parseInt(process.env.PORT ?? process.env.SERVER_PORT ?? '3000', 10)

consola.info(`Starting C8Y MCP over HTTP Transport on port ${port}...`)

serve(app, { port })
