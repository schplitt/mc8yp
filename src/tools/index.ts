import type { McpServer } from 'tmcp'
import { createExecuteTool, createQueryTool } from './codemode'
import type { C8yMcpCustomContext } from '../types/mcp-context'

// Create all tools - called at server startup after execution context is set
export function createTools(server: McpServer<undefined, C8yMcpCustomContext>) {
  return [
    createQueryTool(server),
    createExecuteTool(server),
  ]
}
