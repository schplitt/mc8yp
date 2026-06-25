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
- **Browse \`coreSpec.paths\` / \`serviceSpecs[...].paths\` to locate the endpoint** you expect to use
- **\`searchSpecs(query, opts)\` is your primary tool for discovering capabilities the path listing does NOT show** — the query language, \`$filter\` operators, hierarchy operators (e.g. \`isinhierarchyof\`), parameter formats, and request/response bodies. They live in tag docs, not path names, so browsing paths alone never reveals them. It indexes every visible spec (one document per endpoint, per tag, and per spec info block). Each hit's \`text\` is a truncated preview; **paste the hit's \`header\` (a pasteable JS accessor) into a follow-up \`query\` to read the full, untruncated source**
- \`coreSpec\` is for the main Cumulocity REST surface: inventory, alarms, events, measurements, identity, device control, users, tenants, audit
- \`serviceSpecs\` contains microservice APIs available on the current tenant, keyed by contextPath (e.g. \`serviceSpecs.dtm\`). An entry is present if the service is actually reachable on this tenant — use \`serviceSpecs.<key>\` or \`'<key>' in serviceSpecs\` to check availability. Paths are already prefixed for direct use with \`cumulocity.request()\`
- Return the exact value you want back from that function
- Sync and async functions are both supported
- Strings are returned as-is; other results are returned as JSON text
- The \`query\` tool shows the raw bundled OpenAPI specs for the selected build
- The current MCP connection may still block \`execute\` requests through deny rules and/or an allow list even when an operation exists in a visible spec
- **Before writing any manual traversal, recursion, or client-side aggregation loop, \`searchSpecs\` for a server-side operator that does it in one request** (filters, expansions, hierarchy operators). A hand-written BFS over sub-resources is almost always the wrong answer.
- Inspect operation \`parameters\` first; use \`searchSpecs(...)\` to discover domain query-language features and constraints
- **If you are going to send a request with a \`query=\` / \`$filter=\` parameter, you MUST \`searchSpecs\` the query language and confirm the exact operator and syntax first**, and cite what you found in your reasoning before calling \`execute\`. Known gotchas: \`eq\` supports wildcards (\`name eq 'Borkum*'\`), \`like\` is NOT supported, and "everything under X" is \`isinhierarchyof(<id>...)\`, not a recursive fetch
- Avoid hardcoded ID arrays copied from prior responses. For open-ended tenant data, derive IDs via endpoint-native filters, hierarchy operators, or subresource endpoints at execution time.
- Avoid N+1 per-ID fetch loops when the candidate set can grow. Use one bulk/list endpoint with server-side filtering first; fall back to per-ID requests only when no endpoint-native alternative exists.
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
  // Pasteable JS accessor pointing at the source — read it for the full text, e.g.
  //   coreSpec.paths['/inventory/managedObjects'].get
  //   coreSpec.tags.find((t) => t.name === 'Query language')
  header: string
  text: string // a TRUNCATED preview of the match; read \`header\` for the full source
  truncated: boolean // true when \`text\` was cut to a preview
  kind: 'endpoint' | 'tag' | 'spec'
  spec: string // 'core' or a serviceSpecs key
  score: number // higher = more relevant; hits come back best-first
}

declare const coreSpec: Spec
declare const serviceSpecs: ${serviceSpecsType}
declare function searchSpecs(
  query: string,
  opts?: { limit?: number, minScore?: number, fuzzy?: number, prefix?: boolean, maxTextLength?: number }
): SpecSearchHit[]
\`\`\`

### Searching Across Specs

\`searchSpecs\` indexes endpoints, tags, and spec info from every visible spec in one place. Browse paths to locate an endpoint, but **reach for \`searchSpecs\` to discover anything the path listing does not show** — query-language and \`$filter\` operators, hierarchy operators (e.g. \`isinhierarchyof\`), parameter formats, and request/response bodies (these live in tag docs, not path names). Always search it before writing a manual traversal loop or sending a \`query=\` request. Hits come back best-first. Each hit's \`text\` is a **truncated preview** (long matches are cut and marked \`[TRUNCATED PREVIEW …]\`, with \`truncated: true\`) — it is **not** the full doc. Each \`header\` is a **pasteable accessor**: when a hit looks relevant, **paste its \`header\` into a follow-up \`query\` call to read the full, untruncated source** (the binding itself is never truncated). Cap with \`opts.limit\` (default 5), threshold with \`opts.minScore\`, resize the preview with \`opts.maxTextLength\`.

\`\`\`js
// 1) Find the relevant doc — the query language is documented in core but
//    applies across services. Hit \`text\` is a truncated preview.
() => searchSpecs('query language filter operator', { limit: 5 })
\`\`\`
\`\`\`js
// 2) Read the FULL, untruncated source by pasting the chosen hit's header.
//    (e.g. for the "Query language" tag hit above)
() => coreSpec.tags.find((t) => t.name === 'Query language')?.description
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
1. Use \`query\` to find the right endpoint, parameters, and response shape — browse \`coreSpec\`/\`serviceSpecs\` paths to locate the endpoint, and use \`searchSpecs(...)\` to discover query-language/\`$filter\`/hierarchy operators and parameter formats that the path listing does not show.
2. If an operation uses \`query\` / \`c8y:query\`, or you are about to write a traversal/recursion/aggregation loop, verify syntax before execute: inspect operation \`parameters\`, then use \`searchSpecs(...)\` to confirm operators/functions (e.g. \`isinhierarchyof\`, wildcard \`eq\`) and constraints. Reach for a server-side operator before any manual loop.
3. Cite that evidence in your response before the write/read execute call that depends on it.
4. Plan for scale: assume tenant datasets can be large and unbounded.
5. Do not hardcode ID lists from sample outputs unless the user explicitly provided a fixed ID set.
6. Prefer endpoint-native filters/expansions/selectors/hierarchy operators before manual traversal.
7. Avoid N+1 per-ID fetch loops unless the candidate set is explicitly small and bounded.
8. Use \`execute\` with a small async function expression that calls that endpoint and returns only the needed result.
9. Keep functions small and return only the data needed for the next reasoning step.
${restrictionSection}
`,
    )
  })
}
