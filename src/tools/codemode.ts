import { defineTool } from 'tmcp/tool'
import { tool } from 'tmcp/utils'
import * as v from 'valibot'
import { execute, query } from '../codemode/excute'
import { addTenantURLToSchema } from '../utils/schema'

function createCodeSchema(description: string) {
  return v.pipe(
    v.string(),
    v.minLength(1),
    v.description(description),
  )
}

export function createQueryTool() {
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
    description: `Execute JavaScript code against the Cumulocity API. First use the query tool to find the right endpoint, then write a JavaScript module that uses cumulocity.request().

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

Your code should be JavaScript module source. The top-level binding \`cumulocity\` is available automatically. Call \`await cumulocity.request({ method, path, ... })\`, export the final result as the default export, and use top-level \`await\` when needed.

Structured tool results are returned in Toon format to reduce token usage. If you export a string, it is returned as-is.

In CLI mode, this MCP can access multiple tenants. Use list-credentials first if the tenant is unclear, then pass the chosen tenantUrl to this tool.

Examples:
export default await cumulocity.request({
  method: 'GET',
  path: '/inventory/managedObjects?pageSize=5',
})

const alarms = await cumulocity.request({
  method: 'GET',
  path: '/alarm/alarms?pageSize=10&withTotalPages=true',
})

export default alarms

const device = await cumulocity.request({
  method: 'GET',
  path: '/inventory/managedObjects/12345',
})

export default { id: device.id, name: device.name }
`,
    schema: addTenantURLToSchema(v.object({
      code: createCodeSchema('JavaScript module source. The top-level binding `cumulocity` is available automatically. Export the final result with `export default`. Top-level `await` is supported.'),
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
