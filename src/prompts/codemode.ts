import type { McpServer } from 'tmcp'
import { definePrompt } from 'tmcp/prompt'
import { prompt } from 'tmcp/utils'
import { getCoreOpenApiLabel } from '#core-openapi'
import type { C8yMcpCustomContext } from '../types/mcp-context'
import { BUNDLED_OPENAPI_ENTRIES, OPENAPI_PARTS } from '../utils/openapi'

function getRuntimeSection(): string {
  return globalThis.executionEnvironment === 'cli'
    ? '## CLI Runtime\nUse `list-credentials` to see available tenants when needed. Then pass the chosen `tenantUrl` to `execute`.'
    : '## Server Runtime\nThis deployed MCP server uses the current tenant and the service user attached to this MCP connection. Do not pass tenant-specific credentials or tenant URLs yourself.'
}

function getOpenApiSection(server: McpServer<undefined, C8yMcpCustomContext>): string {
  const disabledApis = server.ctx.custom?.disabledApis ?? []
  const enabledApis = OPENAPI_PARTS.filter((api) => !disabledApis.includes(api))
  return `## Bundled OpenAPI Specs\nThe query tool currently exposes the ${getCoreOpenApiLabel()} bundled core OpenAPI snapshot together with the other bundled product specs. Bundled specs on this connection: ${BUNDLED_OPENAPI_ENTRIES.map((entry) => `${entry.api} (${entry.version})`).join(', ')}. Enabled bundled OpenAPI parts for execute policy: ${enabledApis.join(', ')}.`
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
      ? `\n## Current Connection Access Policy\n${policyLines.join('\n')}\n\nThe \`query\` tool still shows the raw bundled OpenAPI specs for this connection. These rules are enforced when requests are executed. Disabled bundled OpenAPI parts affect execute policy rather than hiding specs from query.\n`
      : ''

    return prompt.message(
      `# Cumulocity Code Mode

You have exactly two MCP tools available.

## query
Use \`query\` when you need to inspect the bundled OpenAPI specs.

- Input: a **zero-parameter** JavaScript function expression
- Do NOT declare \`coreSpec\`, \`dtmSpec\`, or \`specsEnabled\` as function parameters — they are already declared as top-level constants in the surrounding scope. Writing \`(dtmSpec) => ...\` would shadow the global with an undefined parameter and produce incorrect results
- The top-level bindings \`coreSpec\`, \`dtmSpec\`, and \`specsEnabled\` are available automatically inside the function body
- \`coreSpec\` is for the main Cumulocity REST surface such as inventory, alarms, events, measurements, identity, device control, users, tenants, audit, and the broader platform APIs
- \`dtmSpec\` is for Digital Twin Manager work such as schema definitions, asset models, linked series, and DTM asset or definition APIs
- Return the exact value you want back from that function
- Sync and async functions are both supported
- Strings are returned as-is; other results are returned as JSON text
- The \`query\` tool shows the raw bundled OpenAPI specs for the selected build
- The current MCP connection may still block \`execute\` requests through deny rules and/or an allow list even when an operation exists in a visible spec

### Available Shape

The function must accept **no parameters**. The bindings below are scope-level constants, not function arguments.

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

type CoreSpec = {
  paths: Record<string, PathItem>
}

type DtmSpec = {
  paths: Record<string, PathItem>
}

type SpecsEnabled = {
  core: boolean
  dtm: boolean
}

declare const coreSpec: CoreSpec
declare const dtmSpec: DtmSpec
declare const specsEnabled: SpecsEnabled
\`\`\`

Examples (all zero-parameter — note no arguments in the arrow function signatures):
\`\`\`js
() => specsEnabled
\`\`\`

\`\`\`js
() => Object.keys(coreSpec.paths).filter((path) => path.includes('inventory'))
\`\`\`

\`\`\`js
() => {
  // dtmSpec is already in scope — do NOT write (dtmSpec) => { ... }
  const op = dtmSpec.paths['/assets']?.get
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
  return await cumulocity.request({
    method: 'GET',
    path: '/assets?pageSize=20',
  })
}
\`\`\`

${getRuntimeSection()}

${getOpenApiSection(server)}

## Working Pattern
1. Use \`query\` to find the right endpoint, parameters, and response shape.
2. Use \`execute\` with a small async function expression that calls that endpoint and returns only the needed result.
3. Keep functions small and return only the data needed for the next reasoning step.
${restrictionSection}
`,
    )
  })
}
