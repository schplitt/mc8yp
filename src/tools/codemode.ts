import type { McpServer } from 'tmcp'
import { defineTool } from 'tmcp/tool'
import { tool } from 'tmcp/utils'
import * as v from 'valibot'
import { execute, query } from '../codemode/excute'
import type { C8yMcpCustomContext } from '../types/mcp-context'
import { addTenantURLToSchema } from '../utils/schema'

function createCodeSchema(description: string) {
  return v.pipe(
    v.string(),
    v.minLength(1),
    v.description(description),
  )
}

export function createQueryTool(server: McpServer<undefined, C8yMcpCustomContext>) {
  return defineTool({
    name: 'query',
    title: 'Query Cumulocity OpenAPI Spec',
    description: `Search the Cumulocity OpenAPI spec using a JavaScript module.

Available in your module:

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

type Spec = {
  paths: Record<string, PathItem>
  // Further explanations of body and query parameters are available here.
  tags: Array<{ name: string, description: string }>
}

declare const spec: Spec

Your code should be JavaScript module source. The top-level binding \`spec\` is available automatically. Export the final result as the default export. Top-level \`await\` is supported.

Structured tool results are returned in Toon format to reduce token usage. If you export a string, it is returned as-is.

The current MCP connection may mark blocked operations with \`x-mc8yp-restricted\` and related \`x-mc8yp-*\` fields. These operations are intentionally unavailable even though they still exist in the OpenAPI spec.
Treat those annotations as a hard connection-level restriction: use them to understand what exists, but do not plan to call those operations with \`execute\`.

Examples:
const results = []
for (const [path, methods] of Object.entries(spec.paths)) {
  for (const [method, op] of Object.entries(methods)) {
    if (op?.tags?.some(tag => tag.toLowerCase() === 'inventory')) {
      results.push({ method: method.toUpperCase(), path, summary: op.summary })
    }
  }
}

export default results

const op = spec.paths['/inventory/managedObjects']?.get
export default { summary: op?.summary, parameters: op?.parameters, responses: op?.responses }
`,
    schema: v.object({
      code: createCodeSchema('JavaScript module source. The top-level binding `spec` is available automatically. Export the final result with `export default`. Top-level `await` is supported.'),
    }),
  }, async (input) => {
    try {
      return tool.text(await query(input.code, server.ctx.custom?.restrictions ?? []))
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

Your code must evaluate to a function, preferably an async anonymous function or async arrow function expression. The top-level binding \`cumulocity\` is available automatically. The sandbox assigns your function to a local variable, invokes it, and returns its result.

Recommended shape:
\`async () => { ... }\`

Inside that function, call \`await cumulocity.request({ method, path, ... })\` and \`return\` the final value you want.

Internally the sandbox classifies execution as success, blocked, or failed.

Tool output behavior:
- On success, the actual function result is returned in Toon format.
- On blocked or failed execution, the tool returns a plain text message.

The current MCP connection may deny certain method/path combinations. Restricted routes remain visible in the spec, and \`cumulocity.request(...)\` will reject blocked calls before sending them.
When that happens, the tool returns a plain text connection-policy message. That is not a Cumulocity API failure and retrying the same operation through the same connection will not help.

In CLI mode, this MCP can access multiple tenants. Use list-credentials first if the tenant is unclear, then pass the chosen tenantUrl to this tool.

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
  const device = await cumulocity.request({
    method: 'GET',
    path: '/inventory/managedObjects/12345',
  })

  return { id: device.id, name: device.name }
}
`,
    schema: addTenantURLToSchema(v.object({
      code: createCodeSchema('An async JavaScript function expression. The top-level binding `cumulocity` is available automatically. Return the final result from that function. `await` is supported.'),
    })),
  }, async (input) => {
    try {
      return tool.text(await execute(input.code, input, server.ctx.custom?.restrictions ?? []))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return tool.error(message)
    }
  })
}
