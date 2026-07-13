import { createCodemodeTool } from './codemode'

export function createTools(env: 'cli' | 'server') {
  return [
    createCodemodeTool(env),
  ]
}
