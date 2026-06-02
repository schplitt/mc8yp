import { ValibotJsonSchemaAdapter } from '@tmcp/adapter-valibot'
import { McpServer } from 'tmcp'
import pkgjson from '../package.json' with { type: 'json' }
import type { C8yMcpCustomContext } from './types/mcp-context'

const adapter = new ValibotJsonSchemaAdapter()

export const c8yMcpServer = new McpServer(
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
      resources: { listChanged: true },
    },
  },
).withContext<C8yMcpCustomContext>()
