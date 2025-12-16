import { HttpTransport } from '@tmcp/transport-http'
import consola from 'consola'
import { H3, serve } from 'h3'
import { createC8YMcpServer } from './server'
import { getAuthContext } from './ctx/auth'
import process from 'node:process'
import { extractAuthFromHeaders } from './utils/auth'

globalThis.executionEnvironment = 'server'

const server = createC8YMcpServer()

const transport = new HttpTransport(server)

const app = new H3().all('/mcp', async (event) => {
  // Extract authentication from request headers
  const credentials = extractAuthFromHeaders(event.req)

  // Set auth context for the request
  const authContext = getAuthContext()
  return authContext.call(credentials, () => transport.respond(event.req))
})

app.get('/health', () => 'OK')

app.get('/', () => 'C8Y MCP Server is running!')

const port = parseInt(process.env.PORT ?? process.env.SERVER_PORT ?? '3000', 10)

consola.info(`Starting C8Y MCP over HTTP Transport on port ${port}...`)

serve(app, { port })
