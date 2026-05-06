import { HttpTransport } from '@tmcp/transport-http'
import consola from 'consola'
import { getQuery, H3, HTTPError, serve } from 'h3'
import { createC8YMcpServer } from './server'
import { getAuthContext } from './ctx/auth'
import process from 'node:process'
import { extractAuthFromHeaders } from './utils/auth'
import { parseAllowRule, parseRestrictionRule } from './utils/restrictions'

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
  const restrictionSources = [query.restriction, query.restrict, query.r].flatMap((value) => Array.isArray(value) ? value : [value]).filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  )
  const { parsedRules: restrictions, failedRules: failedRestrictions } = parseRestrictionRule(restrictionSources)

  if (failedRestrictions.length > 0) {
    throw new HTTPError({
      status: 400,
      statusText: 'Invalid restriction query',
      message: 'One or more restriction query parameters (?restriction, ?restrict, ?r) could not be parsed.',
      data: {
        failedRules: failedRestrictions,
      },
    })
  }

  const allowSources = [query.allowed, query.allow, query.a].flatMap((value) => Array.isArray(value) ? value : [value]).filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  )
  const { parsedRules: allowRules, failedRules: failedAllowRules } = parseAllowRule(allowSources)

  if (failedAllowRules.length > 0) {
    throw new HTTPError({
      status: 400,
      statusText: 'Invalid allow query',
      message: 'One or more allow query parameters (?allowed, ?allow, ?a) could not be parsed.',
      data: {
        failedRules: failedAllowRules,
      },
    })
  }

  // Set auth context for the request
  const authContext = getAuthContext()
  return authContext.call(credentials, () => transport.respond(event.req, { restrictions, allowRules }))
})

app.get('/health', () => 'OK')

app.get('/', () => 'C8Y MCP Server is running!')

const port = parseInt(process.env.PORT ?? process.env.SERVER_PORT ?? '3000', 10)

consola.info(`Starting C8Y MCP over HTTP Transport on port ${port}...`)

serve(app, { port })
