import { HttpTransport } from '@tmcp/transport-http'
import consola from 'consola'
import { getQuery, H3, HTTPError, readBody, serve } from 'h3'
import openApiSpec from '../openapi.json' with { type: 'json' }
import { c8yMcpServer, setupMcpServer } from './server'
import { createSessionEvictingInfoSessionManager } from './codemode/session-eviction'
import process from 'node:process'
import {
  ALLOW_HEADER,
  ALLOW_QUERY_KEYS,
  RESTRICTION_HEADER,
  RESTRICTION_QUERY_KEYS,
  collectServerAllowSources,
  collectServerEnableSandboxSources,
  collectServerNoMcpSources,
  collectServerRestrictionSources,
  parseAllowRule,
  parseEnableSandbox,
  parseNoMcp,
  parseRestrictionRule,
} from './utils/restrictions'
import {
  EXTERNAL_MCP_HEADER,
  collectServerExternalMcpSources,
  parseExternalMcpServers,
} from './utils/external-mcp'
import { resolveExternalMcpCandidates } from './utils/external-mcp-resolve'
import { buildNamespaces } from './codemode/namespaces'
import { BasicAuth, Client, MicroserviceClientRequestAuth } from '@c8y/client'
import { getCachedDiscovery, refreshCapabilities } from './utils/capability-discovery'
import { resolveCapabilities } from './utils/capability-resolution'
import { getServiceUserCredentials, startSubscriptionsRefresh } from './utils/subscriptions'
import { getSandbox } from './codemode/execute'

// Microservice mode requires bootstrap credentials. The subscriptions cache
// fetches per-tenant service-user creds via the bootstrap user, and proactive
// discovery rides on every successful refresh. Hard-fail at startup so
// misconfigured deployments do not silently degrade.
startSubscriptionsRefresh() // throws synchronously if C8Y_BOOTSTRAP_* / C8Y_BASEURL are missing

setupMcpServer('server')

const transport = new HttpTransport(c8yMcpServer, {
  path: '/mcp',
  disableSse: true,
  // Evict a session's sandbox and cached external MCP tool lists the moment the
  // client closes cleanly (DELETE); the 15-min idle TTLs backstop sessions that
  // never send one. `streams` defaults to the transport's
  // InMemoryStreamSessionManager.
  sessionManager: { info: createSessionEvictingInfoSessionManager() },
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
  const enableSandbox = parseEnableSandbox(collectServerEnableSandboxSources(query, event.req.headers))

  // Connection-supplied external MCP servers. Fail the request rather than
  // dropping a bad entry: the agent would otherwise be missing a namespace the
  // operator believes it has, with nothing pointing at the typo.
  const { servers: externalMcpServers, failedEntries: failedExternalMcp } = parseExternalMcpServers(
    collectServerExternalMcpSources(event.req.headers),
  )
  if (failedExternalMcp.length > 0) {
    throw new HTTPError({
      status: 400,
      statusText: 'Invalid external MCP server configuration',
      message: `One or more ${EXTERNAL_MCP_HEADER} header entries could not be parsed. Each entry is a JSON object {"name":"…","url":"https://…","token":"…"} (or a JSON array of them).`,
      data: { failedEntries: failedExternalMcp },
    })
  }

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
    enableSandbox,
    externalMcpServers,
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

// Configuration-time check for connection-supplied external MCP servers: derive
// the namespace each entry would be mounted under, say whether that namespace is
// free, and report what the agent would actually get from the server.
//
// This exists because the `mc8yp-mcp-server` header is a strict runtime
// contract, and the three things a caller building that header cannot know on
// its own all live in here: the derivation, the tenant's namespace list, and the
// MCP handshake with these entries' own auth semantics. See
// ./utils/external-mcp-resolve.ts for the reasoning.
//
// It is a POST with a body rather than a GET taking the header, because entries
// carry credentials and a management UI is testing a candidate that is not
// configured on any connection yet.
app.post('/resolve-mcp-servers', async (event) => {
  try {
    const authorizationHeader = event.req.headers.get('authorization') ?? undefined
    const cookieHeader = event.req.headers.get('cookie') ?? undefined
    if (!authorizationHeader && !cookieHeader) {
      throw new HTTPError({
        status: 401,
        statusText: 'Unauthorized',
        message: 'Resolving MCP servers requires user auth (Authorization header or session cookie).',
      })
    }

    // A malformed body is the caller's mistake, so it must not fall through to
    // the 500 handler below: readBody throws on unparseable JSON.
    const badBody = new HTTPError({
      status: 400,
      statusText: 'Invalid body',
      message: 'Body must be JSON {"servers":[{"name":"…","url":"https://…","token":"…"}]} — one entry per server, `name` free-form (the namespace is derived from it).',
    })
    let body: { servers?: unknown } | undefined
    try {
      body = await readBody<{ servers?: unknown }>(event)
    } catch {
      throw badBody
    }
    const servers = body?.servers
    if (!Array.isArray(servers))
      throw badBody

    // The tenant namespace list is what makes a collision verdict possible, and
    // it is the one part that can legitimately be unavailable: discovery is
    // cached per tenant and warmed by the subscriptions refresh. When it cannot
    // be resolved we return the resolutions WITHOUT a tenant check and say so in
    // `warnings` — reporting a namespace as free when we could not look is the
    // failure mode this route exists to remove.
    const warnings: string[] = []
    let tenantId: string | undefined
    let tenantNamespaces: string[] | null = null
    try {
      const userClient = new Client(
        new MicroserviceClientRequestAuth({ authorization: authorizationHeader, cookie: cookieHeader }),
        C8Y_BASEURL,
      )
      tenantId = (await userClient.tenant.current()).data?.name
      if (!tenantId)
        throw new Error('could not resolve the current tenant via /tenant/currentTenant')

      // Nothing warmed yet (fresh container, or a tenant whose refresh has not
      // run) means discovering on demand: this route is an admin action, so
      // paying the spec download once beats answering with an unchecked
      // namespace.
      const cached = getCachedDiscovery(tenantId)
      let discovery
      if (cached) {
        discovery = await cached
      } else {
        const subscribedCred = await getServiceUserCredentials(tenantId)
        if (!subscribedCred)
          throw new Error(`tenant '${tenantId}' is not subscribed to this microservice`)
        discovery = await refreshCapabilities(tenantId, new Client(new BasicAuth(subscribedCred), C8Y_BASEURL))
      }

      const resolved = resolveCapabilities(discovery.specs, discovery.installedContextPaths, discovery.mcpServers)
      // Assembled the same way a real connection assembles it, with no policy:
      // restrictions filter operations, never namespace names, so the set of
      // names is exactly what an external entry has to fit around.
      tenantNamespaces = buildNamespaces(resolved).map((ns) => ns.name)
    } catch (err) {
      warnings.push(
        `Tenant namespace check did not run (${err instanceof Error ? err.message : String(err)}). `
        + 'A namespace reported as free here may still be taken by a tenant namespace at runtime.',
      )
    }

    return {
      tenantUrl: C8Y_BASEURL,
      ...(tenantId ? { tenantId } : {}),
      tenantNamespaces,
      warnings,
      servers: await resolveExternalMcpCandidates(servers, { tenantNamespaces }),
    }
  } catch (err) {
    if (err instanceof HTTPError)
      throw err
    throw new HTTPError({
      status: 500,
      statusText: 'Resolution failed',
      message: err instanceof Error ? err.message : 'Failed to resolve external MCP servers',
    })
  }
})

app.get('/health', async () => {
  const result = await (await getSandbox()).run({
    code: 'export default \'alive\';',
  })
  return result.ok
})
app.get('/openapi.json', () => openApiSpec)

app.get('/', () => 'C8Y MCP Server is running!')

const port = parseInt(process.env.PORT ?? process.env.SERVER_PORT ?? '3000', 10)

consola.info(`Starting C8Y MCP over HTTP Transport on port ${port}...`)

serve(app, { port })
