import type { McpServer } from 'tmcp'
import { createCodeModeGuidePrompt } from './codemode'
import type { C8yMcpCustomContext } from '../types/mcp-context'

// Create all prompts - called at server startup after execution context is set
export function createPrompts(server: McpServer<undefined, C8yMcpCustomContext>) {
  return [
    createCodeModeGuidePrompt(server),
  ]
}
