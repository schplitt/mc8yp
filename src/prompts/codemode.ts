import { definePrompt } from 'tmcp/prompt'
import { prompt } from 'tmcp/utils'
import { getCoreOpenApiLabel } from '#core-openapi'
import { c8yMcpServer } from '../server-instance'
import { getAllReadySpecs } from '../utils/api-discovery'
import { BUNDLED_OPENAPI_ENTRIES } from '../utils/openapi'

function getRuntimeSection(): string {
  return globalThis.executionEnvironment === 'cli'
    ? '## CLI Runtime\nUse `list-credentials` to see available tenants when needed. Then pass the chosen `tenantUrl` to `execute`.'
    : '## Server Runtime\nThis deployed MCP server uses the current tenant and the service user attached to this MCP connection. Do not pass tenant-specific credentials or tenant URLs yourself.'
}

function getOpenApiSection(): string {
  return `## OpenAPI Specs\nThe query tool exposes the ${getCoreOpenApiLabel()} bundled core snapshot (${BUNDLED_OPENAPI_ENTRIES.map((entry) => `${entry.api} ${entry.version}`).join(', ')}) via \`coreSpec\`, and any microservice APIs discovered on the tenant via \`serviceSpecs\`.`
}

export function createCodeModeGuidePrompt() {
  return definePrompt({
    name: 'code-mode-guide',
    description: 'Guide for the two code-mode tools: query and execute, including available shapes and examples.',
  }, () => {
    const restrictions = c8yMcpServer.ctx.custom?.restrictions ?? []
    const allowRules = c8yMcpServer.ctx.custom?.allowRules ?? []
    const discoveredSpecs = globalThis.executionEnvironment === 'cli'
      ? getAllReadySpecs()
      : (c8yMcpServer.ctx.custom?.discoveredSpecs ?? [])
    const serviceSpecsType = discoveredSpecs.length === 0
      ? 'Record<string, ServiceSpecEntry>'
      : `{\n${discoveredSpecs.map((ds) => `  ${ds.contextPath}: ServiceSpecEntry`).join('\n')}\n}`
    const policyLines = [
      ...restrictions.map((rule) => `- deny: \`${rule.source}\``),
      ...allowRules.map((rule) => `- allow: \`${rule.source}\``),
    ]
    const restrictionSection = policyLines.length > 0
      ? `\n## Current Connection Access Policy\n${policyLines.join('\n')}\n\nThe \`query\` tool still shows the raw bundled OpenAPI specs for this connection. These rules are enforced when requests are executed. Disabled bundled OpenAPI parts affect execute policy rather than hiding specs from query.\n`
      : ''

    return prompt.message(
      `# Cumulocity Code Mode

You have two MCP tools available.

## query
Use \`query\` to inspect OpenAPI specs (bundled core or discovered microservices).

- Input: a **zero-parameter** JavaScript function expression
- Do NOT declare \`coreSpec\` or \`serviceSpecs\` as function parameters — they are already declared as top-level constants in the surrounding scope
- \`coreSpec\` is for the main Cumulocity REST surface: inventory, alarms, events, measurements, identity, device control, users, tenants, audit
- \`serviceSpecs\` contains microservice APIs discovered on the current tenant, keyed by contextPath (e.g. \`serviceSpecs['dtm']\`). Paths are already prefixed for direct use with \`cumulocity.request()\`
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

type ServiceSpecEntry = {
  label: string
  contextPath: string
  spec: { paths: Record<string, PathItem> }
}

declare const coreSpec: CoreSpec
declare const serviceSpecs: ${serviceSpecsType}
\`\`\`

Examples (all zero-parameter — note no arguments in the arrow function signatures):
\`\`\`js
() => Object.keys(coreSpec.paths).filter((path) => path.includes('inventory'))
\`\`\`

\`\`\`js
() => {
  const op = serviceSpecs['dtm']?.spec.paths['/service/dtm/assets']?.get
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
- If a request is blocked by MCP connection policy, \`execute\` returns an explanatory text message — that is an access restriction, not a Cumulocity API failure

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
    path: '/service/dtm/assets?pageSize=20',
  })
}
\`\`\`

${getRuntimeSection()}

${getOpenApiSection()}

## Working Pattern
1. Use \`query\` to find the right endpoint, parameters, and response shape.
2. Use \`execute\` with a small async function expression that calls that endpoint and returns only the needed result.
3. Keep functions small and return only the data needed for the next reasoning step.
${restrictionSection}
`,
    )
  })
}
