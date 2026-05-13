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
  OPENAPI_DISABLED_HEADER,
  OPENAPI_DISABLED_QUERY_KEY,
  RESTRICTION_HEADER,
  RESTRICTION_QUERY_KEYS,
  collectServerAllowSources,
  collectServerDisabledOpenApiSources,
  collectServerRestrictionSources,
  parseAllowRule,
  parseDisabledOpenApiParts,
  parseRestrictionRule,
} from './utils/restrictions'
import { createOpenApiPartRestrictionRules } from './utils/openapi'

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

  const openApiSources = collectServerDisabledOpenApiSources(query, event.req.headers)
  const { disabledApis, failedValues: failedOpenApiValues } = parseDisabledOpenApiParts(openApiSources)

  if (failedOpenApiValues.length > 0) {
    throw new HTTPError({
      status: 400,
      statusText: 'Invalid bundled OpenAPI disable selection',
      message: `One or more bundled OpenAPI values from the ?${OPENAPI_DISABLED_QUERY_KEY} query parameter or the ${OPENAPI_DISABLED_HEADER} header could not be parsed.`,
      data: {
        failedValues: failedOpenApiValues,
      },
    })
  }

  // When a request forbids bundled OpenAPI parts, expand that selection into
  // concrete restriction rules here so execute enforcement can stay purely path/method-based.
  const effectiveRestrictions = disabledApis.length > 0
    ? [...restrictions, ...createOpenApiPartRestrictionRules(disabledApis)]
    : restrictions

  // Set auth context for the request
  const authContext = getAuthContext()
  return authContext.call(credentials, () => transport.respond(event.req, { restrictions: effectiveRestrictions, allowRules: parsedAllowRules, disabledApis }))
})

app.get('/health', () => 'OK')

app.get('/', () => 'C8Y MCP Server is running!')

const port = parseInt(process.env.PORT ?? process.env.SERVER_PORT ?? '3000', 10)

consola.info(`Starting C8Y MCP over HTTP Transport on port ${port}...`)

serve(app, { port })
