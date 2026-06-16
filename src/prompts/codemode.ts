import { definePrompt } from 'tmcp/prompt'
import { prompt } from 'tmcp/utils'
import { c8yMcpServer } from '../server-instance'

function getRuntimeSection(): string {
  return c8yMcpServer.ctx.custom?.env === 'cli'
    ? '## CLI Runtime\nUse `status` to see the active tenant, stored tenant URLs, and the specs visible to query right now. Use `set-active-tenant` to connect to a tenant. Once set, query and execute use that tenant automatically. When no tenant is active, query falls back to all bundled OpenAPI snapshots for reference and execute is unavailable. If a microservice was just (un)subscribed in the tenant, call `status` with `refresh: true` to bust the 30-minute discovery cache.'
    : '## Server Runtime\nThis deployed MCP server uses the current tenant and the service user attached to this MCP connection. Do not pass tenant-specific credentials or tenant URLs yourself.'
}

function getOpenApiSection(): string {
  return `## OpenAPI Specs\nThe query tool exposes a bundled Cumulocity core snapshot via \`coreSpec\`, and any microservice APIs (bundled or live-discovered) available on the tenant via \`serviceSpecs\`.`
}

export function createCodeModeGuidePrompt() {
  return definePrompt({
    name: 'code-mode-guide',
    description: 'Guide for the two code-mode tools: query and execute, including available shapes and examples.',
  }, () => {
    const restrictions = c8yMcpServer.ctx.custom?.restrictions ?? []
    const allowRules = c8yMcpServer.ctx.custom?.allowRules ?? []
    const resolvedSpecs = c8yMcpServer.ctx.custom?.specs!
    const serviceKeys = Object.keys(resolvedSpecs.specs)
    const serviceSpecsType = serviceKeys.length === 0
      ? 'Record<string, Spec>'
      : `{\n${serviceKeys.map((k) => `  ${k}: Spec`).join('\n')}\n}`
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
- \`serviceSpecs\` contains microservice APIs available on the current tenant, keyed by contextPath (e.g. \`serviceSpecs.dtm\`). An entry is present iff the service is actually reachable on this tenant — use \`serviceSpecs.<key>\` or \`'<key>' in serviceSpecs\` to check availability. Paths are already prefixed for direct use with \`cumulocity.request()\`
- Return the exact value you want back from that function
- Sync and async functions are both supported
- Strings are returned as-is; other results are returned as JSON text
- The \`query\` tool shows the raw bundled OpenAPI specs for the selected build
- The current MCP connection may still block \`execute\` requests through deny rules and/or an allow list even when an operation exists in a visible spec

### Available Shape

The function must accept **no parameters**. The bindings below are scope-level constants, not function arguments.

\`\`\`ts
type XCodemodeItem = {
  instruction: string      // always present — standalone guidance or LLM-only context
  // include-mode: prerequisite spec embedded inline — follow before executing
  includedPath?: string    // service-prefixed path to use in cumulocity.request()
  includedSpec?: PathItem  // full operations & schemas for the prerequisite endpoint
  // query-mode: advisory hint — query only if the user's request requires it
  queryPath?: string       // service-prefixed path to query if the dependency applies
}

type OperationInfo = {
  summary?: string
  description?: string
  tags?: string[]
  parameters?: Array<{ name: string, in: string, required?: boolean, schema?: unknown, description?: string }>
  requestBody?: { required?: boolean, content?: Record<string, { schema?: unknown }> }
  responses?: Record<string, { description?: string, content?: Record<string, { schema?: unknown }> }>
  'x-codemode'?: XCodemodeItem[]
}

type PathItem = {
  get?: OperationInfo
  post?: OperationInfo
  put?: OperationInfo
  patch?: OperationInfo
  delete?: OperationInfo
}

type Spec = {
  paths: Record<string, PathItem>
  tags?: Array<{ name: string, description?: string }>
}

declare const coreSpec: Spec
declare const serviceSpecs: ${serviceSpecsType}
\`\`\`

Examples (all zero-parameter — note no arguments in the arrow function signatures):
\`\`\`js
() => Object.keys(coreSpec.paths).filter((path) => path.includes('inventory'))
\`\`\`

\`\`\`js
() => {
  const op = serviceSpecs.dtm?.paths['/service/dtm/assets']?.get
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
2. Check the operation for \`x-codemode\` hints and act on every item in the array before executing:
   - **Instruction only** (no path fields): follow the instruction — it describes idempotency behavior, required headers, or other LLM-only context not surfaced in standard API docs.
   - **\`includedPath\` + \`includedSpec\` present**: mandatory prerequisite — fulfill the instruction completely before executing the target operation. The embedded spec contains everything needed (schemas, parameters) to complete the prerequisite step without an additional query.
   - **\`queryPath\` present** (no \`includedSpec\`): optional dependency — query that path only if the user's actual request requires it. Skip if the dependency does not apply to the specific request.
3. Use \`execute\` with a small async function expression that calls that endpoint and returns only the needed result.
4. Keep functions small and return only the data needed for the next reasoning step.
${restrictionSection}
`,
    )
  })
}
