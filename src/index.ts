import { HttpTransport } from '@tmcp/transport-http'
import consola from 'consola'
import { getQuery, H3, HTTPError, serve } from 'h3'
import { createC8YMcpServer } from './server'
import { getAuthContext } from './ctx/auth'
import process from 'node:process'
import { extractAuthFromHeaders } from './utils/auth'
import { parseRestrictionRule } from './utils/restrictions'

globalThis.executionEnvironment = 'server'

const server = createC8YMcpServer()

const transport = new HttpTransport(server, {
  path: '/mcp',
  disableSse: true,
})

const app = new H3().all('/mcp', async (event) => {
  // Extract authentication from request headers
  const credentials = extractAuthFromHeaders(event.req)
  const restriction = getQuery(event).restriction
  const restrictionSources = (Array.isArray(restriction) ? restriction : [restriction]).filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  )
  const { parsedRules, failedRules } = parseRestrictionRule(restrictionSources)

  if (failedRules.length > 0) {
    throw new HTTPError({
      status: 400,
      statusText: 'Invalid restriction query',
      message: 'One or more restriction query parameters could not be parsed.',
      data: {
        failedRules,
      },
    })
  }

  // Set auth context for the request
  const authContext = getAuthContext()
  return authContext.call(credentials, () => transport.respond(event.req, { restrictions: parsedRules }))
})

app.get('/health', () => 'OK')

app.get('/', () => 'C8Y MCP Server is running!')

const port = parseInt(process.env.PORT ?? process.env.SERVER_PORT ?? '3000', 10)

consola.info(`Starting C8Y MCP over HTTP Transport on port ${port}...`)

serve(app, { port })
