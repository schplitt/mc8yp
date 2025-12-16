import { ValibotJsonSchemaAdapter } from '@tmcp/adapter-valibot'
import { McpServer } from 'tmcp'
import pkgjson from '../package.json' with { type: 'json' }
import { createPrompts } from './prompts'
import { createTools } from './tools'
import { createListCredentialsTool } from './tools/credentials'
import consola from 'consola'

export function createC8YMcpServer(): McpServer {
  const adapter = new ValibotJsonSchemaAdapter()

  const server = new McpServer(
    {
      name: `${pkgjson.name}-server`,
      version: pkgjson.version,
      description: pkgjson.description,
    },
    {
      adapter,
      capabilities: {
        tools: { listChanged: true },
        prompts: { listChanged: true },
        resources: { listChanged: false },
      },
    },
  )

  server.tools(createTools())
  server.prompts(createPrompts())
  const executionEnvironment = globalThis.executionEnvironment
  consola.info('Running in execution environment:', executionEnvironment)

  if (executionEnvironment === 'cli') {
    server.tool(createListCredentialsTool())
  }

  return server
}
