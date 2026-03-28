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
    description: `Search the Cumulocity OpenAPI spec. All data is available through the function argument; do not rely on globals.

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

type Spec = {
  paths: Record<string, PathItem>
  // Further explanations of body and query parameters are available here.
  tags: Array<{ name: string, description: string }>
}

Your code must be a JavaScript function. It will be called like ({ spec }) => ... and must return the result.

Examples:
async ({ spec }) => {
  const results = []
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      if (op?.tags?.some(tag => tag.toLowerCase() === 'inventory')) {
        results.push({ method: method.toUpperCase(), path, summary: op.summary })
      }
    }
  }
  return results
}

async ({ spec }) => {
  const op = spec.paths['/inventory/managedObjects']?.get
  return { summary: op?.summary, parameters: op?.parameters, responses: op?.responses }
}`,
    schema: v.object({
      code: createCodeSchema('JavaScript function source. It will be called with one argument object containing `spec`, for example async ({ spec }) => Object.keys(spec.paths). Return the value to send back.'),
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
    description: `Execute JavaScript code against the Cumulocity API. First use the query tool to find the right endpoint, then write a function using cumulocity.request().

Available in your function:

type CumulocityRequestOptions = {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  body?: unknown
  headers?: Record<string, string>
}

declare const cumulocity: {
  request<T = unknown>(path: string, init?: RequestInit): Promise<T>
  request<T = unknown>(options: CumulocityRequestOptions): Promise<T>
}

Your code must be a JavaScript function. It will be called like async ({ cumulocity }) => ... and must return the result.

In CLI mode, this MCP can access multiple tenants. Use list-credentials first if the tenant is unclear, then pass the chosen tenantUrl to this tool.

Examples:
async ({ cumulocity }) => {
  return cumulocity.request('/inventory/managedObjects?pageSize=5', {
    method: 'GET',
  })
}

async ({ cumulocity }) => {
  return cumulocity.request({
    method: 'GET',
    path: '/alarm/alarms?pageSize=10&withTotalPages=true',
  })
}

async ({ cumulocity }) => {
  const device = await cumulocity.request({
    method: 'GET',
    path: '/inventory/managedObjects/12345',
  })
  return { id: device.id, name: device.name }
}`,
    schema: addTenantURLToSchema(v.object({
      code: createCodeSchema('JavaScript function source. It will be called with one argument object containing `cumulocity`, for example async ({ cumulocity }) => cumulocity.request(...). Return the final value to send back.'),
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
