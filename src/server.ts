import consola from 'consola'
import { c8yMcpServer } from './server-instance'
import { createPrompts } from './prompts'
import { createTools } from './tools'
import { createListCredentialsTool } from './tools/credentials'

export { c8yMcpServer } from './server-instance'

/**
 * Register tools and prompts on the shared server instance.
 * Must be called after globalThis.executionEnvironment is set.
 */
export function setupMcpServer(): void {
  c8yMcpServer.tools(createTools())
  c8yMcpServer.prompts(createPrompts())
  consola.info('Running in execution environment:', globalThis.executionEnvironment)

  if (globalThis.executionEnvironment === 'cli') {
    c8yMcpServer.tool(createListCredentialsTool())
  }
}
