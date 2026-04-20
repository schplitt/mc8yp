import type { McpServer } from 'tmcp'
import { definePrompt } from 'tmcp/prompt'
import { prompt } from 'tmcp/utils'
import type { C8yMcpCustomContext } from '../types/mcp-context'

export function createCodeModeGuidePrompt(server: McpServer<undefined, C8yMcpCustomContext>) {
  return definePrompt({
    name: 'code-mode-guide',
    description: 'Guide for the two code-mode tools: query and execute, including available shapes and examples.',
  }, () => {
    const restrictions = server.ctx.custom?.restrictions ?? []
    const restrictionSection = restrictions.length > 0
      ? `\n## Current Connection Restrictions\nThe current MCP connection blocks matching operations using these deny rules:\n${restrictions.map((rule) => `- \`${rule.source}\``).join('\n')}\n\nRestricted operations stay visible in the spec and are annotated with \`x-mc8yp-restricted\` and related \`x-mc8yp-*\` fields.\n`
      : ''

    return prompt.message(
      `# Cumulocity Code Mode

You have exactly two MCP tools available.

## query
Use \`query\` when you need to inspect the OpenAPI spec.

- Input: JavaScript module source
- The top-level binding \`spec\` is available automatically
- Export the exact value you want back with \`export default\`
- Top-level \`await\` is supported
- Structured results are returned in Toon format; exported strings are returned as-is
- Restricted operations stay visible and are annotated with \`x-mc8yp-restricted\` and related \`x-mc8yp-*\` fields

### Available Shape
\`\`\`ts
type OperationInfo = {
  summary?: string
  description?: string
  tags?: string[]
  parameters?: Array<{ name: string, in: string, required?: boolean, schema?: unknown, description?: string }>
  requestBody?: { required?: boolean, content?: Record<string, { schema?: unknown }> }
  responses?: Record<string, { description?: string, content?: Record<string, { schema?: unknown }> }>
}

type PathItem = {
  get?: OperationInfo
  post?: OperationInfo
  put?: OperationInfo
  patch?: OperationInfo
  delete?: OperationInfo
}

declare const spec: {
  paths: Record<string, PathItem>
}
\`\`\`

Example:
\`\`\`js
export default Object.keys(spec.paths).filter((path) => path.includes('inventory'))
\`\`\`

\`\`\`js
const op = spec.paths['/inventory/managedObjects']?.get
export default op?.parameters
\`\`\`

## execute
Use \`execute\` when you want to call the real Cumulocity API.

- Input: JavaScript module source
- The top-level binding \`cumulocity\` is available automatically
- It can call \`await cumulocity.request({ method, path, ... })\`
- Do not build auth headers or tenant URLs yourself
- Export the exact value you want back with \`export default\`
- Top-level \`await\` is supported
- Structured results are returned in Toon format; exported strings are returned as-is
- The current MCP connection may reject restricted method/path combinations before network access

### Available Shape
\`\`\`ts
interface CumulocityRequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  body?: unknown
  headers?: Record<string, string>
}

declare const cumulocity: {
  request<T = unknown>(options: CumulocityRequestOptions): Promise<T>
}
\`\`\`

Examples:
\`\`\`js
export default await cumulocity.request({
  method: 'GET',
  path: '/inventory/managedObjects?pageSize=5',
})
\`\`\`

\`\`\`js
const alarms = await cumulocity.request({
  method: 'GET',
  path: '/alarm/alarms?pageSize=10',
})

export default alarms.alarms
\`\`\`

\`\`\`js
const devices = await cumulocity.request({
  method: 'GET',
  path: '/inventory/managedObjects?pageSize=20&withTotalPages=true',
})

export default devices
\`\`\`

## CLI Mode
When running in CLI mode, first use \`list-credentials\` to see available tenants. Then pass the chosen \`tenantUrl\` to \`execute\`.

## Working Pattern
1. Use \`query\` to find the right endpoint, parameters, and response shape.
2. Use \`execute\` to call that endpoint.
3. Keep modules small and export only the data needed for the next reasoning step.
${restrictionSection}
`,
    )
  })
}
