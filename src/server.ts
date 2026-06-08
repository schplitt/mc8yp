import consola from 'consola'
import { c8yMcpServer } from './server-instance'
import { createPrompts } from './prompts'
import { createTools } from './tools'
import { createListCredentialsTool } from './tools/credentials'
import { createSetActiveTenantTool } from './tools/active-tenant'

export { c8yMcpServer } from './server-instance'

/**
 * Register tools and prompts on the shared server instance.
 * @param env - The execution environment, controls which CLI-only tools are registered.
 */
export function setupMcpServer(env: 'cli' | 'server'): void {
  c8yMcpServer.tools(createTools())
  c8yMcpServer.prompts(createPrompts())
  consola.info('Running in execution environment:', env)

  if (env === 'cli') {
    c8yMcpServer.tool(createListCredentialsTool())
    c8yMcpServer.tool(createSetActiveTenantTool())
  }
}
