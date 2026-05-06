import type { McpServer } from 'tmcp'
import { definePrompt } from 'tmcp/prompt'
import { prompt } from 'tmcp/utils'
import { getCoreOpenApiLabel } from '#core-openapi'
import type { C8yMcpCustomContext } from '../types/mcp-context'

function getRuntimeSection(): string {
  return globalThis.executionEnvironment === 'cli'
    ? '## CLI Runtime\nUse `list-credentials` to see available tenants when needed. Then pass the chosen `tenantUrl` to `execute`.'
    : '## Server Runtime\nThis deployed MCP server uses the current tenant and the service user attached to this MCP connection. Do not pass tenant-specific credentials or tenant URLs yourself.'
}

function getCoreOpenApiSection(): string {
  return `## Core OpenAPI Snapshot\nThe query tool currently exposes the ${getCoreOpenApiLabel()} core OpenAPI snapshot.`
}

export function createCodeModeGuidePrompt(server: McpServer<undefined, C8yMcpCustomContext>) {
  return definePrompt({
    name: 'code-mode-guide',
    description: 'Guide for the two code-mode tools: query and execute, including available shapes and examples.',
  }, () => {
    const restrictions = server.ctx.custom?.restrictions ?? []
    const allowRules = server.ctx.custom?.allowRules ?? []
    const policyLines = [
      ...restrictions.map((rule) => `- deny: \`${rule.source}\``),
      ...allowRules.map((rule) => `- allow: \`${rule.source}\``),
    ]
    const restrictionSection = policyLines.length > 0
      ? `\n## Current Connection Access Policy\n${policyLines.join('\n')}\n\nBlocked operations stay visible in the spec and are annotated with \`x-mc8yp-restricted\` and related \`x-mc8yp-*\` fields.\n`
      : ''

    return prompt.message(
      `# Cumulocity Code Mode

You have exactly two MCP tools available.

## query
Use \`query\` when you need to inspect the core OpenAPI spec.

- Input: a JavaScript function expression
- The top-level binding \`spec\` is available automatically
- Return the exact value you want back from that function
- Sync and async functions are both supported
- Strings are returned as-is; other results are returned as JSON text
- Blocked operations stay visible and are annotated with \`x-mc8yp-restricted\` and related \`x-mc8yp-*\` fields
- Treat operations marked with \`x-mc8yp-restricted\` as intentionally unavailable on this MCP connection; inspect them for context, but do not plan to execute them

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
() => Object.keys(spec.paths).filter((path) => path.includes('inventory'))
\`\`\`

\`\`\`js
() => {
  const op = spec.paths['/inventory/managedObjects']?.get
  return op?.parameters
}
\`\`\`

## execute
Use \`execute\` when you want to call the real Cumulocity API.

- Input: a JavaScript function expression
- The top-level binding \`cumulocity\` is available automatically
- It can call \`await cumulocity.request({ method, path, ... })\`
- Do not build auth headers or tenant URLs yourself
- Return the value you want from that function; async functions are usually the right choice here
- On success, the returned value is sent back in Toon format
- If execution is blocked or fails, execute returns a plain text error message
- The current MCP connection may reject restricted method/path combinations before network access, and it may also reject requests that are outside a configured allow list
- If a request is blocked by MCP connection policy, \`execute\` returns an explanatory text message. That is an intentional connection-level access restriction, not a Cumulocity API failure, and retrying through the same connection will not help

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
async () => {
  return await cumulocity.request({
    method: 'GET',
    path: '/inventory/managedObjects?pageSize=5',
  })
}
\`\`\`

\`\`\`js
async () => {
  const alarms = await cumulocity.request({
    method: 'GET',
    path: '/alarm/alarms?pageSize=10',
  })

  return alarms.alarms
}
\`\`\`

\`\`\`js
async () => {
  const devices = await cumulocity.request({
    method: 'GET',
    path: '/inventory/managedObjects?pageSize=20&withTotalPages=true',
  })

  return devices
}
\`\`\`

${getRuntimeSection()}

${getCoreOpenApiSection()}

## Working Pattern
1. Use \`query\` to find the right endpoint, parameters, and response shape.
2. Use \`execute\` with a small async function expression that calls that endpoint and returns only the needed result.
3. Keep functions small and return only the data needed for the next reasoning step.
${restrictionSection}
`,
    )
  })
}
