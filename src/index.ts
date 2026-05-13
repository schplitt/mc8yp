import { HttpTransport } from '@tmcp/transport-http'
import consola from 'consola'
import { getQuery, H3, HTTPError, serve } from 'h3'
import { createC8YMcpServer } from './server'
import { getAuthContext } from './ctx/auth'
import process from 'node:process'
import { extractAuthFromHeaders } from './utils/auth'
import {
  ALLOW_HEADER,
  ALLOW_QUERY_KEYS,
  OPENAPI_HEADER,
  OPENAPI_QUERY_KEYS,
  RESTRICTION_HEADER,
  RESTRICTION_QUERY_KEYS,
  collectServerAllowSources,
  collectServerOpenApiSources,
  collectServerRestrictionSources,
  parseAllowRule,
  parseEnabledOpenApiParts,
  parseRestrictionRule,
} from './utils/restrictions'
import { createOpenApiPartAllowRules } from './utils/openapi'

globalThis.executionEnvironment = 'server'

const server = createC8YMcpServer()

const transport = new HttpTransport(server, {
  path: '/mcp',
  disableSse: true,
})

const app = new H3().all('/mcp', async (event) => {
  // Extract authentication from request headers
  const credentials = extractAuthFromHeaders(event.req)
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

  const openApiSources = collectServerOpenApiSources(query, event.req.headers)
  const { enabledApis, failedValues: failedOpenApiValues } = parseEnabledOpenApiParts(openApiSources)

  if (failedOpenApiValues.length > 0) {
    throw new HTTPError({
      status: 400,
      statusText: 'Invalid bundled OpenAPI selection',
      message: `One or more bundled OpenAPI values from query params (${OPENAPI_QUERY_KEYS.map((key) => `?${key}`).join(', ')}) or the ${OPENAPI_HEADER} header could not be parsed.`,
      data: {
        failedValues: failedOpenApiValues,
      },
    })
  }

  // When a request narrows bundled OpenAPI parts, expand that selection into
  // concrete allow rules here so execute enforcement can stay purely path/method-based.
  const allowRules = enabledApis.length > 0
    ? [...parsedAllowRules, ...createOpenApiPartAllowRules(enabledApis)]
    : parsedAllowRules

  // Set auth context for the request
  const authContext = getAuthContext()
  return authContext.call(credentials, () => transport.respond(event.req, { restrictions, allowRules, enabledApis }))
})

app.get('/health', () => 'OK')

app.get('/', () => 'C8Y MCP Server is running!')

const port = parseInt(process.env.PORT ?? process.env.SERVER_PORT ?? '3000', 10)

consola.info(`Starting C8Y MCP over HTTP Transport on port ${port}...`)

serve(app, { port })
