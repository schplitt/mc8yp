import { defineTool } from 'tmcp/tool'
import { tool } from 'tmcp/utils'
import * as v from 'valibot'
import { getCoreOpenApiLabel } from '#core-openapi'
import { execute, query } from '../codemode/execute'
import { BUNDLED_OPENAPI_ENTRIES } from '../utils/openapi'

function createCodeSchema(description: string) {
  return v.pipe(v.string(), v.minLength(1), v.description(description))
}

function getOpenApiNote(): string {
  return `This MCP exposes the ${getCoreOpenApiLabel()} bundled core OpenAPI snapshot plus bundled service specs (${BUNDLED_OPENAPI_ENTRIES.map((e) => `${e.api} ${e.version}`).join(', ')}). Use \`coreSpec\` for the main Cumulocity REST surface. Bundled and live-discovered microservices are available via \`serviceSpecs\` keyed by contextPath; live discovery on the current tenant overrides the bundled fallback when both exist.`
}

export function createQueryTool() {
  return defineTool({
    name: 'query',
    title: 'Query OpenAPI Specs',
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

type Spec = {
  paths: Record<string, PathItem>
  tags?: Array<{ name: string, description?: string }>
}

type ServiceSpecEntry = {
  label: string
  contextPath: string
  spec: Spec
}

type SpecsEnabled = Record<string, boolean>

declare const coreSpec: Spec
declare const specsEnabled: SpecsEnabled
declare const serviceSpecs: Record<string, ServiceSpecEntry>
\`\`\`

- \`coreSpec\` — the bundled Cumulocity core REST surface. Always present.
- \`specsEnabled\` — per known bundled service: is it actually installed on this tenant? (e.g. \`specsEnabled.dtm\`). Check this before calling execute against a known service; if false the request will be blocked by connection policy.
- \`serviceSpecs\` — microservice APIs available on the tenant, keyed by contextPath. Includes bundled service specs (e.g. \`serviceSpecs.dtm\` for Digital Twin Manager) and any live-discovered services. Paths are already prefixed (e.g. \`/service/dtm/assets\`). Live discovery on the tenant overrides the bundled fallback when present.

If your function returns a string it is returned as-is. Any other value is returned as JSON.
The current MCP connection may still block \`execute\` calls even when an operation is visible in a spec.

Examples:
\`() => specsEnabled\`
\`() => Object.keys(coreSpec.paths).filter((p) => p.includes('inventory'))\`
\`() => Object.keys(serviceSpecs)\`

\`\`\`js
() => {
  const op = coreSpec.paths['/inventory/managedObjects']?.get
  return { summary: op?.summary, parameters: op?.parameters }
}
\`\`\`
`,
    schema: v.object({
      code: createCodeSchema(
        'A zero-parameter JavaScript function expression. coreSpec, specsEnabled, and serviceSpecs are already declared as top-level constants — do not redeclare them as function parameters. Return the final result. Async functions are supported.',
      ),
    }),
  }, async (input) => {
    try {
      return tool.text(await query(input.code))
    } catch (error) {
      return tool.error(error instanceof Error ? error.message : String(error))
    }
  })
}

export function createExecuteTool() {
  return defineTool({
    name: 'execute',
    title: 'Execute Cumulocity API Call',
    description: `Execute JavaScript code against the Cumulocity API. Use the query tool first to find the right endpoint, then write an async function that calls cumulocity.request().

${getOpenApiNote()}

Available in your function:

\`\`\`ts
type CumulocityRequestOptions = {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  body?: unknown
  headers?: Record<string, string>
}

declare const cumulocity: {
  request<T = unknown>(options: CumulocityRequestOptions): Promise<T>
}
\`\`\`

Your code must evaluate to an async function. Return the final value you want.

On success the result is returned in Toon format. On a blocked or failed execution a plain text message is returned. A blocked message means the operation was denied by connection policy — retrying through the same connection will not help.

Examples:
\`\`\`js
async () => {
  return await cumulocity.request({ method: 'GET', path: '/inventory/managedObjects?pageSize=5' })
}
\`\`\`
`,
    schema: v.object({
      code: createCodeSchema(
        'An async JavaScript function expression. The top-level binding `cumulocity` is available automatically. Return the final result. `await` is supported.',
      ),
    }),
  }, async (input) => {
    try {
      return tool.text(await execute(input.code))
    } catch (error) {
      return tool.error(error instanceof Error ? error.message : String(error))
    }
  })
}
