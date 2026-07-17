import { defineTool } from 'tmcp/tool'
import { tool } from 'tmcp/utils'
import * as v from 'valibot'
import { execute } from '../codemode/execute'
import type { Env } from '../types'

function getSafetyPreface(env: Env): string {
  const sharedFooter = 'A method visible in discovery may still return 404 when the service is not actually installed on the current tenant.'
  if (env === 'server')
    return sharedFooter
  return [
    '**Read first.** Every result starts with a marker line: either `Executed against tenant: <url>` or a no-active-tenant notice. Verify it matches the tenant you intend to act on before reporting the result. The active tenant is global to this CLI session and can be flipped between calls by `set-active-tenant`. Without an active tenant, discovery (codemode/docs) works against bundled reference snapshots but live API calls fail with a missing-auth error — call `status` and `set-active-tenant` to connect.',
    '',
    sharedFooter,
  ].join('\n')
}

export function createCodemodeTool(env: Env) {
  return defineTool({
    name: 'codemode',
    title: 'Cumulocity Code Mode',
    description: `${getSafetyPreface(env)}

Run an async JavaScript function against the Cumulocity API. Discovery, documentation, and typed API calls all happen inside one function — find what you need and call it in the same run.

The expensive mistake is a hasty API call: an unparameterized request returns large payloads that flood your context. \`search\` and \`describe\` are cheap — spend calls there first.

Do NOT rely on prior knowledge of these APIs and do not assume anything: the available namespaces and their capabilities are tenant-specific and discovered at runtime. What you think you know about an API may be outdated or may be outclassed by a service on this tenant you have never seen. Verify through search, describe, and docs.

Available globals (do NOT declare these as function parameters):

\`\`\`ts
declare const codemode: {
  /** Ranked fuzzy search over API method names, REST paths, and summaries. Returns the top 20 by score. Pass several phrasings at once — results are unioned. */
  search: (query: string | string[]) => Promise<{
    results: Array<{ target: string, namespace: string, method: string, httpMethod?: string, apiPath?: string, summary?: string, score: number }>
    total: number
    truncated: boolean
  }>
  /**
   * No target: overview of the namespaces on THIS tenant and their
   * responsibilities — ALWAYS your first call.
   * "namespace.method": the typed interface for ONE method — signature,
   * input/output types with OpenAPI docs as JSDoc, related doc ids.
   * Array of method targets (max 5): describe a shortlist in one call and
   * COMPARE their input types before picking.
   * Namespace-only targets are rejected — use search to find methods.
   */
  describe: (target?: string | string[]) => Promise<
    { target: string, kind: 'overview' | 'method', content: string }
    | Array<{ target: string, kind: 'overview' | 'method', content: string }>
  >
}

declare const docs: {
  /** Fuzzy full-text search over prose documentation topics: domain query languages, concepts, API-area guides. Per-method details live in codemode.describe instead. */
  search: (query: string, opts?: { limit?: number, fuzzy?: number, prefix?: boolean, minScore?: number, maxTextLength?: number }) => Promise<Array<{
    id: string, title: string, text: string, truncated: boolean, kind: 'topic' | 'overview', namespace: string, score: number
  }>>
  /**
   * Full untruncated text of a documentation entry. Return it WHOLE — never
   * slice or truncate doc text: the crucial capability (an operator, a
   * function, a constraint) is often documented near the end, and a blind
   * cut loses exactly the part you searched for. Long doc topics are the
   * one output where length is justified.
   */
  read: (id: string) => Promise<{ id: string, title: string, text: string, kind: string, namespace: string }>
}

// API namespaces: \`c8y\` (Cumulocity core — always present) plus one global
// per microservice available on the current tenant (e.g. \`dtm\`), each with
// one typed method per operation. If a method seems missing, search
// with different wording; if it truly does not exist, say so instead of
// improvising:
//   await c8y.getManagedObjectCollectionResource({ pageSize: 5 })
\`\`\`

Workflow — ALWAYS in this order: describe() → search → describe(shortlist) → call.
1. \`codemode.describe()\` (no target) — ALWAYS start here. It lists the API namespaces on THIS tenant with their responsibilities. A domain service (asset management, data preparation, …) usually has a far better API for its domain — server-side hierarchy queries, bulk operations — than composing the generic core API. Decide which namespaces could own the problem's domain, and search with each of their vocabularies.
2. \`codemode.search(["phrasing 1", "phrasing 2"])\` — find candidate methods (top 20 by score). Results usually contain several overlapping endpoints (single-item, collection, count, by-external-id, bulk variants) — read all summaries and shortlist every candidate that could satisfy the request in ONE call, don't grab the first hit. If all results come from one namespace, re-check the overview — another namespace may own the domain with a stronger API. If the expected method is missing, re-search with other domain words before concluding it does not exist — check \`total\` too.
3. \`codemode.describe(["ns.methodA", "ns.methodB"])\` (max 5) — ALWAYS describe before calling, and describe the whole shortlist in one call. Compare the input types: prefer the method whose parameters push the work to the server — query/filter parameters (especially ones marked \`@format c8y:query\` or documenting a query grammar), hierarchy/recursive selectors, bulk endpoints — over methods that would force per-item calls or client-side filtering. Describing five candidates costs almost nothing; one wrong or unfiltered API call costs more context than all your discovery combined.
4. \`docs.search("...")\` / \`docs.read(id)\` — when a parameter references domain syntax you don't know, read the docs before guessing values. Read doc texts to the END — never \`.slice()\` them: the operator or function you need is often documented in the later sections, and a blind cut loses exactly the crucial part.
5. Call the winner: \`await c8y.someMethod({ ...params, body })\` (path/query/header parameters and \`body\` share one flat input object). ONE well-parameterized call beats fetching broadly and filtering in your code, and beats chains of per-item calls. If you catch yourself looping over items to call an API for each one, go back to step 1 — a collection, query, or bulk endpoint usually exists.
6. Return only the data needed to answer — never return raw unfiltered collections.

Discovery and API calls can be combined in a single run. Methods blocked by the connection access policy are omitted from discovery entirely; a blocked live request fails with an explanatory message — that is a connection-level access restriction, not a Cumulocity API failure, and retrying will not help.

Your code must evaluate to an async function. Return the final value you want; on success it is returned in Toon format.

Examples:
\`\`\`js
async () => {
  const { results } = await codemode.search('alarms by severity')
  const { content } = await codemode.describe(results[0].target)
  return content
}
\`\`\`

\`\`\`js
async () => {
  return await c8y.getAlarmCollectionResource({ pageSize: 10, severity: 'MAJOR' })
}
\`\`\`

\`\`\`js
async () => {
  const hits = await docs.search('inventory query language syntax')
  return hits.length > 0 ? (await docs.read(hits[0].id)).text : 'no docs found'
}
\`\`\`
`,
    schema: v.object({
      code: v.pipe(
        v.string(),
        v.minLength(1),
        v.description('An async JavaScript function expression. The globals codemode, docs, c8y, and per-service namespaces are available automatically — do not declare them as parameters. Return the final result.'),
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
