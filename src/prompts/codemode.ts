import { definePrompt } from 'tmcp/prompt'
import { prompt } from 'tmcp/utils'
import { c8yMcpServer } from '../server-instance'
import { buildNamespaces } from '../codemode/namespaces'

function getRuntimeSection(): string {
  return c8yMcpServer.ctx.custom?.env === 'cli'
    ? '## CLI Runtime\nUse `status` to see the active tenant, stored tenant URLs, and the API surface visible right now. Use `set-active-tenant` to connect to a tenant. Once set, codemode uses that tenant automatically. When no tenant is active, discovery (`codemode.search`/`describe`, `docs`) falls back to bundled reference snapshots and live API calls fail with a missing-auth error. If a microservice was just (un)subscribed in the tenant, call `status` with `refresh: true` to bust the 30-minute discovery cache.'
    : '## Server Runtime\nThis deployed MCP server uses the current tenant and the service user attached to this MCP connection. Do not pass tenant-specific credentials or tenant URLs yourself.'
}

export function createCodeModeGuidePrompt() {
  return definePrompt({
    name: 'code-mode-guide',
    description: 'Guide for the codemode tool: discovery, documentation search, and typed API calls in one sandboxed function.',
  }, () => {
    const restrictions = c8yMcpServer.ctx.custom?.restrictions ?? []
    const allowRules = c8yMcpServer.ctx.custom?.allowRules ?? []
    const resolvedSpecs = c8yMcpServer.ctx.custom?.specs
    const namespaceNames = resolvedSpecs
      ? buildNamespaces(resolvedSpecs, restrictions, allowRules).map((ns) => ns.name)
      : ['c8y']
    const policyLines = [
      ...restrictions.map((rule) => `- deny: \`${rule.source}\``),
      ...allowRules.map((rule) => `- allow: \`${rule.source}\``),
    ]
    const restrictionSection = policyLines.length > 0
      ? `\n## Current Connection Access Policy\n${policyLines.join('\n')}\n\nOperations blocked by these rules are omitted from discovery (search/describe) entirely, and any live request that matches a deny rule (or misses the allow list) fails before reaching the tenant.\n`
      : ''

    return prompt.message(
      `# Cumulocity Code Mode

One MCP tool: \`codemode\`. It runs an async JavaScript function in a sandbox where API discovery, documentation, and live Cumulocity API calls are all available as globals — a full find-inspect-call cycle fits in a single tool invocation.

## Globals

\`\`\`ts
declare const codemode: {
  search: (query: string | string[]) => Promise<{ results: Array<{ target: string, namespace: string, method: string, httpMethod: string, apiPath: string, summary?: string, score: number }>, total: number, truncated: boolean }>
  describe: (target?: string | string[]) => Promise<{ target: string, kind: 'overview' | 'method', content: string } | Array<{ target: string, kind: 'overview' | 'method', content: string }>>
}

declare const docs: {
  search: (query: string, opts?: { limit?: number, fuzzy?: number, prefix?: boolean, minScore?: number, maxTextLength?: number }) => Promise<Array<{ id: string, title: string, text: string, truncated: boolean, kind: 'topic' | 'overview', namespace: string, score: number }>>
  read: (id: string) => Promise<{ id: string, title: string, text: string, kind: string, namespace: string }>
}
\`\`\`

API namespaces currently visible: ${namespaceNames.map((n) => `\`${n}\``).join(', ')}.

- \`c8y\` is the Cumulocity core REST surface (inventory, alarms, events, measurements, identity, device control, users, tenants, audit). Always present.
- Each additional namespace is a microservice available on the current tenant (e.g. \`dtm\`). A namespace exists only when the service is actually reachable.
- Every namespace has one typed method per API operation plus a low-level escape hatch: \`<ns>.request({ method, path, params?, body?, headers? })\` with tenant-relative paths. The escape hatch is a last resort — reach for it only after repeated searches found no derived method.
- Method inputs are a single flat object: path/query/header parameters as top-level keys, the request payload under \`body\`.

## Discovery Workflow — ALWAYS in this order: describe() → search → describe(shortlist) → call.

The expensive mistake is a hasty API call: an unparameterized request returns large payloads that flood your context. Search and describe are cheap — spend calls there first.

Do NOT rely on prior knowledge of these APIs and do not assume anything: the available namespaces and their capabilities are tenant-specific and discovered at runtime. What you think you know about an API may be outdated or outclassed by a service on this tenant you have never seen. Verify through search, describe, and docs.

1. \`codemode.describe()\` (no target) — ALWAYS start here. It lists the API namespaces on THIS tenant with their responsibilities. A domain service (asset management, data preparation, …) usually has a far better API for its domain — server-side hierarchy queries, bulk operations — than composing the generic core API. Decide which namespaces could own the problem's domain, and search with each of their vocabularies.
2. \`codemode.search(["phrasing 1", "phrasing 2"])\` — ranked fuzzy search over method names, REST paths, and summaries (top 20 by score); multiple phrasings are unioned. Results usually contain several overlapping endpoints (single-item, collection, count, by-external-id, bulk variants) — read all summaries and shortlist every candidate that could satisfy the request in ONE call, don't grab the first hit. If all results come from one namespace, re-check the overview — another namespace may own the domain with a stronger API. If the expected method is missing, re-search with other domain words before concluding it does not exist.
3. \`codemode.describe(["<ns>.<methodA>", "<ns>.<methodB>"])\` (max 5) — ALWAYS describe before calling, and describe the whole shortlist in one call. Compare the input types: prefer the method whose parameters push the work to the server — query/filter parameters (especially ones documenting a query grammar), hierarchy/recursive selectors, bulk endpoints — over methods that would force per-item calls or client-side filtering. Describe is method-only by design — there is no whole-namespace dump.
4. \`docs.search("keywords")\` — fuzzy full-text search over documentation topics: domain query languages, concepts, API-area guides. When a parameter description references a concept, read the docs before guessing values.
5. \`docs.read(id)\` — returns the FULL text; read it to the END and never \`.slice()\` it. The operator or function you need is often documented in the later sections — a blind cut loses exactly the crucial part. Long doc topics are the one output where length is justified.

## Execution Guidance

- Prefer ONE call that pushes the work to the server (filters, query parameters, pageSize, sorting, expansions) over fetching broadly and filtering in your code, and over chains of per-item calls.
- If you catch yourself looping over items to call an API for each one, go back to search — a collection, query, or bulk endpoint usually exists.
- Return only the data needed to answer — never return raw unfiltered collections.
- On success the returned value is encoded in Toon format. Errors return plain text.
- A blocked request message means a connection-level access restriction — not a Cumulocity API failure. Retrying through the same connection will not succeed.

## Examples

\`\`\`js
async () => {
  const { results } = await codemode.search('managed objects by fragment')
  return (await codemode.describe(results[0].target)).content
}
\`\`\`

\`\`\`js
async () => {
  const hits = await docs.search('inventory query language')
  const grammar = hits.length > 0 ? (await docs.read(hits[0].id)).text : null
  const devices = await c8y.getManagedObjectCollectionResource({ query: "$filter=(type eq 'c8y_Device')", pageSize: 5 })
  return { grammar: grammar?.slice(0, 200), devices }
}
\`\`\`

\`\`\`js
async () => {
  return await c8y.request({ method: 'GET', path: '/service/dtm/assets', params: { pageSize: 20 } })
}
\`\`\`

${getRuntimeSection()}
${restrictionSection}`,
    )
  })
}
