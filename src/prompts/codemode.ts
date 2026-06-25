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
- Do NOT declare \`coreSpec\`, \`serviceSpecs\`, or \`searchSpecs\` as function parameters — they are already available as top-level bindings in the surrounding scope
- **Browse the specs directly first.** Inspect \`coreSpec.paths\` / \`serviceSpecs[...].paths\` and the operation you expect to use
- \`searchSpecs(query, opts)\` is a secondary, keyword-based lookup over a prebuilt index of every visible spec (one document per endpoint, per tag, and per spec info block). Reach for it **after** browsing paths — when you need to know how a specific parameter is used or its expected format (e.g. the query language documented only under core), to understand request/response bodies, or as a fallback when you are not sure you found the correct endpoint. Read each hit's \`header\` (a JS accessor) to jump to the source in \`coreSpec\`/\`serviceSpecs\`
- \`coreSpec\` is for the main Cumulocity REST surface: inventory, alarms, events, measurements, identity, device control, users, tenants, audit
- \`serviceSpecs\` contains microservice APIs available on the current tenant, keyed by contextPath (e.g. \`serviceSpecs.dtm\`). An entry is present if the service is actually reachable on this tenant — use \`serviceSpecs.<key>\` or \`'<key>' in serviceSpecs\` to check availability. Paths are already prefixed for direct use with \`cumulocity.request()\`
- Return the exact value you want back from that function
- Sync and async functions are both supported
- Strings are returned as-is; other results are returned as JSON text
- The \`query\` tool shows the raw bundled OpenAPI specs for the selected build
- The current MCP connection may still block \`execute\` requests through deny rules and/or an allow list even when an operation exists in a visible spec
- Prefer endpoint-native filters/expansions/selectors over manual traversal loops when they can express the same result
- Inspect operation \`parameters\` first, then use referenced \`tags\` documentation to discover domain query-language features and constraints
- If you are going to send a request with a \`query=\` parameter (or any parameter whose schema format is \`c8y:query\`), you MUST verify the query-language syntax first via \`searchSpecs(...)\` or the referenced tag docs, and cite what you found in your reasoning before calling \`execute\`
- Fall back to custom traversal/aggregation only when endpoint-native options cannot express the required output

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

type Spec = {
  paths: Record<string, PathItem>
  tags?: Array<{ name: string, description?: string }>
}

type SpecSearchHit = {
  // JS accessor pointing at the source, e.g.
  //   "coreSpec.paths['/inventory/managedObjects'].get"
  //   "coreSpec.tags — Query language"
  header: string
  text: string
  kind: 'endpoint' | 'tag' | 'spec'
  spec: string // 'core' or a serviceSpecs key
  score: number // higher = more relevant; hits come back best-first
}

declare const coreSpec: Spec
declare const serviceSpecs: ${serviceSpecsType}
declare function searchSpecs(
  query: string,
  opts?: { limit?: number, minScore?: number, fuzzy?: number, prefix?: boolean, specs?: string[] }
): SpecSearchHit[]
\`\`\`

### Searching Across Specs

\`searchSpecs\` indexes endpoints, tags, and spec info from every visible spec in one place. Use it **after** browsing the paths directly — to learn how a parameter or format works (e.g. the query language), to understand bodies, or to confirm you have the right endpoint when unsure. Hits come back best-first; each \`header\` is a JS accessor pointing at the source. Cap with \`opts.limit\` (default 10), scope with \`opts.specs\`, threshold with \`opts.minScore\`.

\`\`\`js
// Confirm/inspect how the query language is used — it is documented in core but
// applies across services. The header points to where to read the full text.
() => searchSpecs('query language filter operator', { limit: 5 })
\`\`\`

\`\`\`js
// Scope the search to a single service
() => searchSpecs('asset hierarchy', { specs: ['dtm'] })
\`\`\`

### Tag Documentation

Both \`coreSpec\` and each \`serviceSpecs\` entry have a top-level \`tags\` array with domain documentation. 
Each operation may reference one or more tags by name via its \`tags[]\` field. When you need deeper context 
about an API area or resource, look up the matching tag entry by name and read its \`description\`.

\`\`\`js
// Get all tag names to find relevant documentation areas - use first when you know the domain but not the exact path
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

\`\`\`js
() => coreSpec.paths['/inventory/managedObjects']?.get
\`\`\`

\`\`\`js
() => {
  const op = coreSpec.paths['/inventory/managedObjects']?.get
  const tagName = op?.tags?.[0]
  return tagName ? coreSpec.tags?.find((t) => t.name === tagName)?.description : null
}
\`\`\`

## execute
Use \`execute\` when you want to call the real Cumulocity API.


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
1. Use \`query\` to find the right endpoint, parameters, and response shape — browse \`coreSpec\`/\`serviceSpecs\` paths directly first, then use \`searchSpecs(...)\` when you need parameter/format/body insight or are unsure you found the right endpoint.
2. If an operation uses \`query\` / \`c8y:query\`, verify syntax before execute: inspect operation \`parameters\`, then use \`searchSpecs(...)\` and/or the referenced tag description to confirm operators/functions and constraints.
3. Cite that evidence in your response before the write/read execute call that depends on it.
4. Prefer endpoint-native filters/expansions/selectors before manual traversal.
5. Use \`execute\` with a small async function expression that calls that endpoint and returns only the needed result.
6. Keep functions small and return only the data needed for the next reasoning step.
${restrictionSection}
`,
    )
  })
}
