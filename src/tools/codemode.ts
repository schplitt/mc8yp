import { defineTool } from 'tmcp/tool'
import { tool } from 'tmcp/utils'
import * as v from 'valibot'
import { getCoreOpenApiLabel } from '#core-openapi'
import { execute, query } from '../codemode/execute'

import { BUNDLED_OPENAPI_ENTRIES } from '../utils/openapi'
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

function getOpenApiNote(): string {
  return `This MCP exposes the ${getCoreOpenApiLabel()} bundled core OpenAPI snapshot (${BUNDLED_OPENAPI_ENTRIES.map((entry) => `${entry.api} ${entry.version}`).join(', ')}). Use \`coreSpec\` for inventory, alarms, events, measurements, users, tenants, and the broader Cumulocity REST surface. Microservice APIs discovered on the current tenant are available via \`serviceSpecs\` in the query tool.`
}

export function createQueryTool() {
  return defineTool({
    name: 'query',
    title: 'Query OpenAPI Specs',
    // defineTool accepts a lazy () => string for description at runtime;
    // the TypeScript overload only declares string so we cast.
    description: `Search the bundled and discovered OpenAPI specs by evaluating a JavaScript function.

${getOpenApiNote()}

Available bindings (all zero-parameter — do NOT declare these as function parameters):

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
  tags?: Array<{ name: string, description?: string }>
}

type ServiceSpecEntry = {
  label: string
  contextPath: string
  spec: { paths: Record<string, PathItem> }
}

declare const coreSpec: CoreSpec
declare const serviceSpecs: Record<string, ServiceSpecEntry>
\`\`\`

- \`coreSpec\` — the main Cumulocity REST surface (inventory, alarms, events, measurements, identity, device control, users, tenants, audit)
- \`serviceSpecs\` — microservice APIs discovered on the current tenant, keyed by contextPath. Paths are prefixed with the service route (e.g. \`/service/dtm/assets\`) and can be passed directly to \`cumulocity.request()\`.

If your function returns a string, it is returned as-is. Otherwise the result is returned as JSON text.
The current MCP connection may still block \`execute\` calls even when an operation is visible in a spec.

Examples:
\`() => Object.keys(serviceSpecs)\`
\`() => Object.keys(coreSpec.paths).filter((p) => p.includes('inventory'))\`

\`\`\`js
() => {
  return Object.entries(serviceSpecs).flatMap(([ctx, entry]) =>
    Object.keys(entry.spec.paths).map((p) => ({ service: ctx, path: p }))
  )
}
\`\`\`

\`\`\`js
() => {
  const op = coreSpec.paths['/inventory/managedObjects']?.get
  return { summary: op?.summary, parameters: op?.parameters }
}
\`\`\`
`,
    schema: v.object({
      code: createCodeSchema('A zero-parameter JavaScript function expression. The bindings coreSpec and serviceSpecs are already declared as top-level constants in the surrounding scope. Do not redeclare them as function parameters. Return the final result. Async functions are supported.'),
    }),
  }, async (input) => {
    try {
      return tool.text(await query(input.code))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return tool.error(message)
    }
  })
}

export function createExecuteTool() {
  return defineTool({
    name: 'execute',
    title: 'Execute Cumulocity API Call',
    description: `Execute JavaScript code against the Cumulocity API. First use the query tool to find the right endpoint, then write an async JavaScript function expression that uses cumulocity.request().

${getOpenApiNote()}

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
    path: '/service/dtm/assets?pageSize=5',
  })

  return asset
}
`,
    schema: addTenantURLToSchema(v.object({
      code: createCodeSchema('An async JavaScript function expression. The top-level binding `cumulocity` is available automatically. Return the final result from that function. `await` is supported.'),
    })),
  }, async (input) => {
    try {
      return tool.text(await execute(input.code, input))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return tool.error(message)
    }
  })
}
