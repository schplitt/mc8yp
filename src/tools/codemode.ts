import type { McpServer } from 'tmcp'
import { defineTool } from 'tmcp/tool'
import { tool } from 'tmcp/utils'
import * as v from 'valibot'
import { getCoreOpenApiLabel } from '#core-openapi'
import { execute, query } from '../codemode/execute'
import type { C8yMcpCustomContext } from '../types/mcp-context'
import { BUNDLED_OPENAPI_ENTRIES, OPENAPI_PARTS } from '../utils/openapi'
import { addTenantURLToSchema } from '../utils/schema'

// TODO: remove
function createCodeSchema(description: string) {
  return v.pipe(
    v.string(),
    v.minLength(1),
    v.description(description),
  )
}
// TODO: as compiler flag?
function getExecuteEnvironmentNote(): string {
  return globalThis.executionEnvironment === 'cli'
    ? 'This MCP can access multiple tenants. Use list-credentials first if the tenant is unclear, then pass the chosen tenantUrl to this tool.'
    : 'This deployed MCP server executes requests against the current tenant using the service user attached to this MCP connection. Do not pass tenant-specific credentials or tenant URLs yourself.'
}

function getOpenApiNote(server: McpServer<undefined, C8yMcpCustomContext>): string {
  const disabledApis = server.ctx.custom?.disabledApis ?? []
  const enabledApis = OPENAPI_PARTS.filter((api) => !disabledApis.includes(api))
  return `This MCP currently exposes the ${getCoreOpenApiLabel()} bundled core OpenAPI snapshot together with the other bundled product specs for the query tool. Bundled specs on this connection: ${BUNDLED_OPENAPI_ENTRIES.map((entry) => `${entry.api} (${entry.version})`).join(', ')}. Enabled bundled OpenAPI parts for execute policy: ${enabledApis.join(', ')}.

Use \`coreSpec\` for the main Cumulocity REST surface such as inventory, alarms, events, measurements, identity, device control, users, tenants, audit, and the broader platform APIs.
Use \`dtmSpec\` for Digital Twin Manager work such as schema definitions, asset models, linked series, and DTM asset or definition APIs.`
}

export function createQueryTool(server: McpServer<undefined, C8yMcpCustomContext>) {
  return defineTool({
    name: 'query',
    title: 'Query Bundled OpenAPI Specs',
    description: `Search the bundled OpenAPI specs by evaluating a JavaScript function.

${getOpenApiNote(server)}

Available in your function:

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
  tags?: Array<{ name: string, description?: string }>
}

type DtmSpec = {
  paths: Record<string, PathItem>
  tags?: Array<{ name: string, description?: string }>
}

type SpecsEnabled = {
  core: boolean
  dtm: boolean
}

declare const coreSpec: CoreSpec
declare const dtmSpec: DtmSpec
declare const specsEnabled: SpecsEnabled

Your code must evaluate to a function. The top-level bindings \

a) \`coreSpec\` — use this for the main Cumulocity REST APIs such as inventory, alarms, events, measurements, identity, device control, users, tenants, audit, and the broader platform REST surface
\nb) \`dtmSpec\` — use this for Digital Twin Manager work such as schema definitions, asset models, linked series, and DTM asset or definition APIs
\nc) \`specsEnabled\` — tells you which bundled spec families are enabled for execute policy on this connection

are available automatically. The sandbox assigns your function to a local variable, invokes it, and returns its result.

Recommended shapes:
\`(() => { ... })\`
\`async () => { ... }\`

If your function returns a string, it is returned as-is. Otherwise the result is returned as JSON text.

The specs exposed by \`query\` are the raw bundled OpenAPI snapshots. They are never hidden or rewritten for the current MCP connection policy.
The current MCP connection may still block \`execute\` calls through restrictions and/or an allow list, so do not assume every operation visible in a spec is executable on this connection.
Use \`specsEnabled\` to see which bundled spec families are enabled for execute policy on this connection.

Examples:
() => specsEnabled

() => {
  return Object.keys(coreSpec.paths).filter((path) => path.includes('inventory'))
}

() => {
  const results = []
  for (const [path, methods] of Object.entries(dtmSpec.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      if (op?.tags?.some(tag => tag.toLowerCase().includes('asset'))) {
        results.push({ method: method.toUpperCase(), path, summary: op.summary })
      }
    }
  }

  return results
}

() => {
  const op = coreSpec.paths['/inventory/managedObjects']?.get
  return { summary: op?.summary, parameters: op?.parameters, responses: op?.responses }
}
`,
    schema: v.object({
      code: createCodeSchema('A JavaScript function expression. The top-level bindings `coreSpec`, `dtmSpec`, and `specsEnabled` are available automatically. Return the final result from that function. Async functions are supported.'),
    }),
  }, async (input) => {
    try {
      return tool.text(await query(input.code, server.ctx.custom?.restrictions ?? [], server.ctx.custom?.allowRules ?? [], server.ctx.custom?.disabledApis ?? []))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return tool.error(message)
    }
  })
}

export function createExecuteTool(server: McpServer<undefined, C8yMcpCustomContext>) {
  return defineTool({
    name: 'execute',
    title: 'Execute Cumulocity API Call',
    description: `Execute JavaScript code against the Cumulocity API. First use the query tool to find the right endpoint, then write an async JavaScript function expression that uses cumulocity.request().

${getOpenApiNote(server)}

Available in your module:

type CumulocityRequestOptions = {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  body?: unknown
  headers?: Record<string, string>
}

declare const cumulocity: {
  request<T = unknown>(options: CumulocityRequestOptions): Promise<T>
}

Your code must evaluate to a function. The top-level binding \`cumulocity\` is available automatically. The sandbox assigns your function to a local variable, invokes it, and returns its result.

Recommended shape:
\`async () => { ... }\`

Inside that function, call \`await cumulocity.request({ method, path, ... })\` and \`return\` the final value you want.

Internally the sandbox classifies execution as success, blocked, or failed.

Tool output behavior:
- On success, the actual function result is returned in Toon format.
- On blocked or failed execution, the tool returns a plain text message.

The current MCP connection may deny certain method/path combinations and may also use an allow list.
The \`query\` tool does not annotate or filter visible operations inside a spec for that policy, and \`cumulocity.request(...)\` will reject blocked calls before sending them.
When that happens, the tool returns a plain text connection-policy message. That is not a Cumulocity API failure and retrying the same operation through the same connection will not help.

${getExecuteEnvironmentNote()}

Examples:
async () => {
  return await cumulocity.request({
    method: 'GET',
    path: '/inventory/managedObjects?pageSize=5',
  })
}

async () => {
  const alarms = await cumulocity.request({
    method: 'GET',
    path: '/alarm/alarms?pageSize=10&withTotalPages=true',
  })

  return alarms
}

async () => {
  const asset = await cumulocity.request({
    method: 'GET',
    path: '/assets?pageSize=5',
  })

  return asset
}
`,
    schema: addTenantURLToSchema(v.object({
      code: createCodeSchema('An async JavaScript function expression. The top-level binding `cumulocity` is available automatically. Return the final result from that function. `await` is supported.'),
    })),
  }, async (input) => {
    try {
      return tool.text(await execute(input.code, input, server.ctx.custom?.restrictions ?? [], server.ctx.custom?.allowRules ?? [], server.ctx.custom?.disabledApis ?? []))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return tool.error(message)
    }
  })
}
