import { defineTool } from 'tmcp/tool'
import { tool } from 'tmcp/utils'
import * as v from 'valibot'
import { execute, query } from '../codemode/execute'
import type { Env } from '../types'

function createCodeSchema(description: string) {
  return v.pipe(v.string(), v.minLength(1), v.description(description))
}

function getOpenApiNote(): string {
  return 'This MCP exposes a bundled Cumulocity core OpenAPI snapshot. Use `coreSpec` for inventory, alarms, events, measurements, users, tenants, and the broader Cumulocity REST surface. Bundled and discovered microservice APIs available on the current tenant are exposed via `serviceSpecs` (keyed by contextPath). Prefer endpoint-native parameters (filters, expansions, paging, sorting) over manual multi-call traversal when they can express the request.'
}

function getQuerySafetyPreface(env: Env): string {
  if (env === 'server')
    return 'Searches the bundled and discovered OpenAPI specs available to the current connection.'
  return '**Read first.** The active tenant is global to this CLI session and can be flipped between calls by `set-active-tenant`. Every result ends with a footer line naming the active tenant (or noting there is none) so you can verify which tenant the result reflects before acting on it. If the footer says "no active tenant" you are looking at bundled reference snapshots — call `status` to see stored credentials and `set-active-tenant` to connect before relying on the result.'
}

function getExecuteSafetyPreface(env: Env): string {
  const sharedFooter = 'An endpoint visible in `query` may still return 404 from `execute` when the service is not actually installed on the current tenant.'
  if (env === 'server')
    return sharedFooter
  return [
    '**Read first.** Every result starts with an `Executed against tenant: <url>` marker line followed by a blank line. Verify it matches the tenant you intend to mutate before reporting the result. The active tenant is global to this CLI session and can be flipped between calls by `set-active-tenant`. If no tenant is active `execute` fails with a missing-auth error — call `status` and `set-active-tenant` to connect first.',
    '',
    sharedFooter,
  ].join('\n')
}

function getQueryResultDescription(env: Env): string {
  if (env === 'server')
    return 'If your function returns a string it is returned as-is. Any other value is returned as JSON.'
  return 'If your function returns a string it is returned as-is. Any other value is returned as JSON. A footer line naming the active tenant (or noting there is none) is appended after a `---` separator on every successful result.'
}

export function createQueryTool(env: Env) {
  return defineTool({
    name: 'query',
    title: 'Query OpenAPI Specs',
    description: `${getQuerySafetyPreface(env)}

Search the bundled and discovered OpenAPI specs by evaluating a JavaScript function.

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

declare const coreSpec: Spec
declare const serviceSpecs: Record<string, Spec>
\`\`\`

- \`coreSpec\` — the main Cumulocity REST surface. Always present.
- \`serviceSpecs\` — microservice APIs available on the active tenant, keyed by contextPath. An entry is **present iff** the service is reachable on this tenant. Paths are already prefixed (e.g. \`/service/myservice/items\`). Check with \`serviceSpecs.dtm\` (or \`'dtm' in serviceSpecs\`) before reaching in.
- Prefer checking operation \`parameters\` before designing multi-step logic. If filters, expansions, or selectors exist, use them first.
- When an operation has \`tags\`, read the matching tag descriptions to discover domain-specific query language/functions and recommended usage patterns.
- Fall back to custom traversal/aggregation only when endpoint-native options cannot express the needed result shape.

Both \`coreSpec\` and each \`serviceSpecs\` entry have a top-level \`tags\` array with domain documentation. Each operation may reference one or more tags by name via its \`tags[]\` field. When you need deeper context about an API area or resource, look up the matching tag entry by name and read its \`description\`.

\`\`\`js
// Get all tag names to find relevant documentation areas — use first when you know the domain but not the exact path
() => serviceSpecs.dtm?.tags?.map(t => t.name)
\`\`\`

\`\`\`js
// Find documentation for a known tag name
() => serviceSpecs.dtm?.tags?.find(t => t.name === 'Assets')?.description
\`\`\`

\`\`\`js
// Follow the tag reference from a specific operation
() => {
  const op = serviceSpecs.dtm?.paths['/service/dtm/assets/linkedSeries']?.get
  const tagName = op?.tags?.[0]
  return tagName ? serviceSpecs.dtm?.tags?.find(t => t.name === tagName)?.description : null
}
\`\`\`

${getQueryResultDescription(env)}
The current MCP connection may still block \`execute\` calls even when an operation is visible in a spec.

Examples:
\`() => Object.keys(serviceSpecs)\`
\`() => Object.keys(coreSpec.paths).filter((p) => p.includes('inventory'))\`
\`() => serviceSpecs.dtm?.paths['/service/dtm/assets']?.get\`

\`\`\`js
() => {
  const op = coreSpec.paths['/inventory/managedObjects']?.get
  return { summary: op?.summary, parameters: op?.parameters }
}
\`\`\`
`,
    schema: v.object({
      code: createCodeSchema(
        'A zero-parameter JavaScript function expression. coreSpec and serviceSpecs are already declared as top-level constants — do not redeclare them as function parameters. Return the final result. Async functions are supported.',
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

export function createExecuteTool(env: Env) {
  return defineTool({
    name: 'execute',
    title: 'Execute Cumulocity API Call',
    description: `${getExecuteSafetyPreface(env)}

Execute JavaScript code against the Cumulocity API. Use the query tool first to find the right endpoint, then write an async function that calls cumulocity.request().

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

Execution strategy:
- First inspect endpoint parameters with \`query\` and choose the lowest-call approach.
- Read relevant tag documentation to discover domain query language/features before writing custom control flow.
- Prefer native API filters/expansions/selectors over manual traversal loops when both satisfy the request.
- Use manual traversal only when endpoint-native options cannot express the needed result shape.

On success the result is returned in Toon format. On a blocked or failed execution a plain text message is returned. A blocked message means the operation was denied by connection policy — retrying through the same connection will not help.

Examples:
\`\`\`js
async () => {
  return await cumulocity.request({ method: 'GET', path: '/inventory/managedObjects?pageSize=5' })
}

async () => {
  return await cumulocity.request({
    method: 'GET',
    path: '/alarm/alarms?pageSize=10&type=myAlarmType',
  })
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
