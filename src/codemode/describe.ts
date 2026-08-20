import { searchMethods } from './method-search'
import { renderMethodDeclaration } from './type-render'
import { SANDBOX_INTERFACE_TS } from './sandbox/types'
import type { MethodIndex } from './method-search'
import type { CodemodeNamespace, McpNamespace, McpNamespaceTool, OpenApiNamespace } from './namespaces'
import type { DerivedOperation } from './derive-operations'
import type { ExternalMcpFailure } from './external-mcp-session'

// ─────────────────────────────────────────────────────────────────────────
// codemode.describe — on-demand documentation rendering, at three altitudes:
//
// - no target      → the namespace overview (one line per namespace)
// - `"<ns>"`       → every method in that namespace, ONE LINE each: the
//                    fully-qualified callable target (`c8y.getAlarmResource`,
//                    the same string search returns and describe accepts),
//                    `METHOD /path`, and the operation's own summary.
//                    Deliberately NO types — rendering the full typed block
//                    for ~250 core operations would flood context, while the
//                    one-liner listing costs ~7k tokens for all of core and
//                    lets the agent see a domain's real shape (which nearby
//                    variants exist: collection, count, by-external-id, bulk)
//                    instead of only what a search query happened to rank.
// - `"<ns>.<m>"`   → the lean full render for one method: the request line,
//                    prose, the bare signature, and input/output types (whose
//                    properties carry the OpenAPI descriptions as JSDoc).
//
// Only the summary goes into a listing, never `description` — that is the
// long prose, and 250 of them is the context flood this avoids. Search stays
// the entry point for "which method does X"; the listing answers "what is in
// this namespace". Wrapped MCP tools render through the same paths — their
// schemas are already JSON Schema.
// ─────────────────────────────────────────────────────────────────────────

export interface DescribeOutput {
  target: string
  kind: 'overview' | 'namespace' | 'method'
  content: string
}

interface SpecWithInfo {
  info?: { title?: string, description?: string }
}

function truncateLine(text: string | undefined, limit = 220): string | undefined {
  const flattened = text?.trim().replace(/\s+/g, ' ')
  if (!flattened)
    return undefined
  return flattened.length > limit ? `${flattened.slice(0, limit)}…` : flattened
}

// Count the method leaves in the sandbox interface so its overview line shows
// a method count like every namespace, without hardcoding a drifting number.
const SANDBOX_METHOD_COUNT = (SANDBOX_INTERFACE_TS.match(/^ {2}\w+:/gm) ?? []).length

// The one-line identity of a namespace: name, what it is, how many methods,
// and a truncated version of its own description. Shared by the overview and
// the namespace listing header so the external-provenance label — a trust
// boundary the agent must be able to report on — cannot drift between them.
function namespaceHeadline(ns: CodemodeNamespace): string {
  // One flattened, truncated line of the service's own description — enough
  // to route a problem domain to its namespace without flooding context. The
  // backing protocol is deliberately not shown.
  if (ns.kind === 'openapi') {
    const info = (ns.spec as SpecWithInfo).info
    const short = truncateLine(info?.description)
    return `${ns.name}${info?.title ? ` — ${info.title}` : ''} (${ns.operations.length} methods)${short ? `: ${short}` : ''}`
  }
  const short = truncateLine(ns.server.description)
  // Provenance IS surfaced even though the backing protocol is not: an
  // external server is a different trust and data boundary — it is not part
  // of the tenant and calls to it leave Cumulocity — and the agent needs
  // that to report accurately where data came from or went.
  const label = ns.external
    ? `EXTERNAL MCP server at ${ns.external.url} — configured for this connection, NOT part of this tenant`
    : ns.server.mcpName
  return `${ns.name} — ${label} (${ns.tools.length} methods)${short ? `: ${short}` : ''}`
}

function renderOverview(
  namespaces: readonly CodemodeNamespace[],
  sandboxEnabled: boolean,
  externalFailures: readonly ExternalMcpFailure[],
): string {
  const lines = ['Available namespaces on this tenant (do not assume capabilities from prior knowledge — search each relevant domain):']
  for (const ns of namespaces)
    lines.push(`- ${namespaceHeadline(ns)}`)
  // Listed as a peer of the API namespaces, same bullet format, so the agent
  // treats it with the same confidence. Its methods are a fixed set surfaced by
  // describe("sandbox") rather than by search (they are not spec-derived).
  if (sandboxEnabled) {
    lines.push(`- sandbox — in-memory shell + virtual filesystem (${SANDBOX_METHOD_COUNT} methods): jq/awk/grep/sed/sort/sqlite over data you fetched; no network, no host FS. codemode.describe("sandbox") for its methods.`)
  }
  // Unreachable external servers are reported, not silently absent: unlike a
  // service that simply is not installed, these were explicitly configured for
  // this connection, so their absence is a fault worth telling the user about.
  if (externalFailures.length > 0) {
    lines.push('', 'Configured but unreachable right now (report this to the user; retrying may work if it is transient):')
    for (const failure of externalFailures)
      lines.push(`- ${failure.name} (${failure.url}): ${failure.reason}`)
  }
  lines.push(
    '',
    'Workflow:',
    '- codemode.search("keywords") — find methods by name/path/summary (top 20 by score)',
    '- codemode.describe("<namespace>") — every method in one namespace, one line each, no types (the method count above is the cost: prefer search on large namespaces)',
    '- codemode.describe("<namespace>.<method>") — types and docs for one method',
    '- docs.search("keywords") / docs.read(id) — documentation topics (domain query languages, concepts)',
    '- <namespace>.<method>({ ...params, body }) — call the API',
  )
  return lines.join('\n')
}

// The sandbox surface is a fixed, small hand-written interface (not spec-
// derived), so — unlike API namespaces — describing the whole thing in one
// block is cheap and useful. Any `sandbox`-prefixed target returns it.
function renderSandbox(): string {
  return [
    'sandbox — in-memory shell + virtual filesystem for wrangling data you fetched (no network, no host FS; it never reaches Cumulocity).',
    '',
    '```ts',
    SANDBOX_INTERFACE_TS,
    '```',
  ].join('\n')
}

// Operations without a declared tag land here rather than being dropped or
// silently merged into the previous group.
const UNGROUPED = 'Other'

// MCP tool descriptions are written by third-party servers and are routinely
// multi-paragraph prose — nothing like an OpenAPI `summary` (p90 60 chars in
// core), which is why the listing clips them harder than a namespace
// description. Full text stays available at describe("<ns>.<tool>").
const MCP_LISTING_DESCRIPTION_LIMIT = 200

function renderNamespaceListing(namespace: CodemodeNamespace): string {
  // Usage hints go ABOVE the listing, not below: the listing itself can be
  // hundreds of lines, and the agent must read how to go deeper before it
  // reads the lines it will want to go deeper on.
  // Lines are FULLY QUALIFIED (`c8y.getAlarmCollectionResource`), matching
  // what search returns as `target` and what the agent actually types to call
  // or describe. A bare method name would make the listing the only surface
  // where the agent has to reassemble the callable name itself.
  const lines = [
    namespaceHeadline(namespace),
    '',
    `Every method in this namespace, one line each — no types. Each line is the callable target: await ${namespace.name}.<method>({ ...params, body }). For input/output types and full prose: codemode.describe("${namespace.name}.<method>") (up to 5 targets in one call). To rank these by relevance instead of reading all of them: codemode.search("keywords").`,
  ]

  if (namespace.kind === 'mcp') {
    if (namespace.external)
      lines.push('', `External MCP server (${namespace.external.url}) — configured for this MCP connection, not part of this tenant. Calls go to that host with its own credentials; tenant credentials are never sent.`)
    lines.push('')
    for (const tool of namespace.tools) {
      const short = truncateLine(tool.description, MCP_LISTING_DESCRIPTION_LIMIT)
      lines.push(`- ${namespace.name}.${tool.name}${short ? ` — ${short}` : ''}`)
    }
    return lines.join('\n')
  }

  // Grouped by the operation's FIRST declared tag, in order of first
  // appearance: the spec's own grouping is the domain structure the agent is
  // looking for, and it turns a 250-line wall into ~50 readable sections.
  // First tag only, so every method appears exactly once.
  const groups = new Map<string, string[]>()
  for (const op of namespace.operations) {
    const summary = truncateLine(op.summary)
    const request = `${op.method} ${op.path}`
    // `summary` falls back to `METHOD /path` when the spec has none — don't
    // print it twice.
    const entry = `- ${namespace.name}.${op.name} — ${request}${summary && summary !== request ? ` — ${summary}` : ''}`
    const group = op.tags[0] ?? UNGROUPED
    const existing = groups.get(group)
    if (existing)
      existing.push(entry)
    else
      groups.set(group, [entry])
  }

  // The headline description is truncated, and the group names double as doc
  // topic ids — point at both rather than leaving the agent with a cut-off
  // sentence and no way to read the rest.
  const info = (namespace.spec as SpecWithInfo).info
  if (info?.title || info?.description)
    lines.push('', `Full namespace overview: docs.read("${namespace.name}::overview").`)
  const specTags = new Set((namespace.spec as { tags?: Array<{ name?: string }> }).tags?.map((t) => t?.name) ?? [])
  if ([...groups.keys()].some((group) => specTags.has(group)))
    lines.push(`Group names are documentation topics: docs.read("${namespace.name}::topic::<group>").`)

  for (const [group, entries] of groups) {
    lines.push('', `${group} (${entries.length}):`, ...entries)
  }
  return lines.join('\n')
}

function renderOperation(namespace: OpenApiNamespace, op: DerivedOperation): string {
  const { types, signature } = renderMethodDeclaration(namespace.name, op.name, {
    inputSchema: op.inputSchema,
    outputSchema: op.outputSchema,
  })

  const lines = [`${op.method} ${op.path} — ${op.summary}`]
  if (op.description)
    lines.push('', op.description)

  lines.push('', '```ts', signature, '', types, '```')

  const specTags = new Set((namespace.spec as { tags?: Array<{ name?: string }> }).tags?.map((t) => t?.name) ?? [])
  const docPointers = op.tags.filter((tag) => specTags.has(tag)).map((tag) => `${namespace.name}::topic::${tag}`)
  if (docPointers.length > 0)
    lines.push('', `Related documentation: ${docPointers.map((id) => `docs.read(${JSON.stringify(id)})`).join(', ')}`)

  return lines.join('\n')
}

function renderMcpTool(namespace: McpNamespace, tool: McpNamespaceTool): string {
  const { types, signature } = renderMethodDeclaration(namespace.name, tool.name, {
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
  })

  const lines = [`${namespace.name}.${tool.name}`]
  // Repeated at method level, not just in the overview: the agent may reach a
  // method through search without ever reading the overview, and "this call
  // leaves the tenant" must not depend on that.
  if (namespace.external)
    lines.push('', `External MCP server (${namespace.external.url}) — configured for this MCP connection, not part of this tenant. Calls go to that host with its own credentials; tenant credentials are never sent.`)
  if (tool.description)
    lines.push('', tool.description)

  lines.push('', '```ts', signature, '', types, '```')
  return lines.join('\n')
}

function findMethod(namespace: CodemodeNamespace, methodName: string): DescribeOutput | undefined {
  if (namespace.kind === 'openapi') {
    const op = namespace.operations.find((o) => o.name === methodName)
    if (op)
      return { target: `${namespace.name}.${op.name}`, kind: 'method', content: renderOperation(namespace, op) }
    return undefined
  }
  const tool = namespace.tools.find((t) => t.name === methodName)
  if (tool)
    return { target: `${namespace.name}.${tool.name}`, kind: 'method', content: renderMcpTool(namespace, tool) }
  return undefined
}

function renderSearchRedirect(target: string, namespaces: readonly CodemodeNamespace[], methodIndex: MethodIndex): string {
  const visible = new Set(namespaces.flatMap((ns) => ns.kind === 'openapi'
    ? ns.operations.map((op) => `${ns.name}.${op.name}`)
    : ns.tools.map((tool) => `${ns.name}.${tool.name}`)))
  const { results } = searchMethods(methodIndex, target, (t) => visible.has(t))
  const suggestions = results.slice(0, 3)
  const lines = [
    `"${target}" is not a known target. Use codemode.describe("<namespace>.<method>") for one method, codemode.describe("<namespace>") to list a whole namespace, or codemode.search("keywords") to find methods.`,
    `Namespaces on this connection: ${namespaces.map((ns) => ns.name).join(', ')}`,
  ]
  if (suggestions.length > 0) {
    lines.push('', 'Closest methods:')
    for (const s of suggestions) lines.push(`- ${s.target}${s.httpMethod ? ` — ${s.httpMethod} ${s.apiPath}` : s.summary ? ` — ${s.summary}` : ''}`)
  }
  return lines.join('\n')
}

/**
 * Run-scoped extras the overview reports alongside the namespace list.
 */
export interface DescribeOptions {
  /**
   * Whether the opt-in `sandbox` surface is exposed this run.
   */
  sandboxEnabled?: boolean
  /**
   * Connection-supplied MCP servers that could not be reached this run.
   */
  externalFailures?: readonly ExternalMcpFailure[]
}

/**
 * Resolve a describe target: nothing (short overview of namespaces), a
 * namespace name (one-line listing of its methods, no types), a
 * `namespace.method` pair, or a bare method name searched across all
 * namespaces.
 * @param namespaces
 * @param methodIndex
 * @param target
 * @param options Run-scoped extras for the overview.
 */
export function describeTarget(
  namespaces: readonly CodemodeNamespace[],
  methodIndex: MethodIndex,
  target?: string,
  options: DescribeOptions = {},
): DescribeOutput {
  const { sandboxEnabled = false, externalFailures = [] } = options
  const trimmed = target?.trim() ?? ''
  if (trimmed === '')
    return { target: '', kind: 'overview', content: renderOverview(namespaces, sandboxEnabled, externalFailures) }

  const [maybeNamespace, maybeMethod] = trimmed.includes('.')
    ? [trimmed.slice(0, trimmed.indexOf('.')), trimmed.slice(trimmed.indexOf('.') + 1)]
    : [trimmed, undefined]

  // The sandbox surface is described as one whole block (small, fixed shape).
  if (sandboxEnabled && maybeNamespace === 'sandbox')
    return { target: 'sandbox', kind: 'method', content: renderSandbox() }

  const namespace = namespaces.find((ns) => ns.name === maybeNamespace)

  // A bare namespace name (or a trailing-dot `"c8y."`) lists the namespace.
  // A namespace name wins over a method that happens to share it — the
  // method is still reachable as `<namespace>.<method>`.
  const methodPart = maybeMethod?.trim()
  if (namespace && !methodPart)
    return { target: namespace.name, kind: 'namespace', content: renderNamespaceListing(namespace) }

  const methodName = methodPart ?? trimmed
  const candidates = namespace && methodPart ? [namespace] : namespaces
  for (const candidate of candidates) {
    const found = findMethod(candidate, methodName)
    if (found)
      return found
  }

  return { target: trimmed, kind: 'method', content: renderSearchRedirect(trimmed, namespaces, methodIndex) }
}
