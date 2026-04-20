import { ValibotJsonSchemaAdapter } from '@tmcp/adapter-valibot'
import { McpServer } from 'tmcp'
import consola from 'consola'
import pkgjson from '../package.json' with { type: 'json' }
import { createPrompts } from './prompts'
import { createTools } from './tools'
import { createListCredentialsTool } from './tools/credentials'
import type { C8yMcpCustomContext } from './types/mcp-context'

export function createC8YMcpServer(): McpServer<undefined, C8yMcpCustomContext> {
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
  ).withContext<C8yMcpCustomContext>()

  server.tools(createTools(server))
  server.prompts(createPrompts(server))
  const executionEnvironment = globalThis.executionEnvironment
  consola.info('Running in execution environment:', executionEnvironment)

  if (executionEnvironment === 'cli') {
    server.tool(createListCredentialsTool())
  }

  return server
}
