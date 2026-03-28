import { createExecuteTool, createQueryTool } from './codemode'

// Create all tools - called at server startup after execution context is set
export function createTools() {
  return [
    createQueryTool(),
    createExecuteTool(),
  ]
}
