import { createExecuteTool, createQueryTool } from './codemode'

export function createTools() {
  return [
    createQueryTool(),
    createExecuteTool(),
  ]
}
