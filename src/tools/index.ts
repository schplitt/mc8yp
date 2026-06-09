import { createExecuteTool, createQueryTool } from './codemode'

export function createTools(env: 'cli' | 'server') {
  return [
    createQueryTool(env),
    createExecuteTool(env),
  ]
}
