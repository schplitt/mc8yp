import { searchMethods } from './method-search'
import { renderMethodDeclaration } from './type-render'
import { SANDBOX_INTERFACE_TS } from './sandbox/types'
import type { MethodIndex } from './method-search'
import type { CodemodeNamespace, McpNamespace, McpNamespaceTool, OpenApiNamespace } from './namespaces'
import type { DerivedOperation } from './derive-operations'
import type { ExternalMcpFailure } from './external-mcp-session'

// ─────────────────────────────────────────────────────────────────────────
// codemode.describe — on-demand documentation rendering.
//
// Deliberately method-only: rendering the full typed block for a whole
// namespace would flood the agent's context (c8y alone has ~250 operations).
// The only real target is a single method — `describe("dtm.getAssets")` —
// and its output is lean: the request line, prose, the bare signature, and
// the input/output types (whose properties carry the OpenAPI descriptions
// as JSDoc). Discovery across methods is codemode.search's job, not a
// namespace dump. Wrapped MCP tools render through the same path — their
// schemas are already JSON Schema.
// ─────────────────────────────────────────────────────────────────────────

export interface DescribeOutput {
  target: string
  kind: 'overview' | 'method'
  content: string
}

interface SpecWithInfo {
  info?: { title?: string, description?: string }
}

function truncateLine(text: string | undefined): string | undefined {
  const flattened = text?.trim().replace(/\s+/g, ' ')
  if (!flattened)
    return undefined
  return flattened.length > 220 ? `${flattened.slice(0, 220)}…` : flattened
}

// Count the method leaves in the sandbox interface so its overview line shows
// a method count like every namespace, without hardcoding a drifting number.
const SANDBOX_METHOD_COUNT = (SANDBOX_INTERFACE_TS.match(/^ {2}\w+:/gm) ?? []).length

function renderOverview(
  namespaces: readonly CodemodeNamespace[],
  sandboxEnabled: boolean,
  externalFailures: readonly ExternalMcpFailure[],
): string {
  const lines = ['Available namespaces on this tenant (do not assume capabilities from prior knowledge — search each relevant domain):']
  for (const ns of namespaces) {
    // One flattened, truncated line of the service's own description —
    // enough to route a problem domain to its namespace without flooding
    // context. The backing protocol is deliberately not shown.
    if (ns.kind === 'openapi') {
      const info = (ns.spec as SpecWithInfo).info
      const short = truncateLine(info?.description)
      lines.push(`- ${ns.name}${info?.title ? ` — ${info.title}` : ''} (${ns.operations.length} methods)${short ? `: ${short}` : ''}`)
    } else {
      const short = truncateLine(ns.server.description)
      // Provenance IS surfaced even though the backing protocol is not: an
      // external server is a different trust and data boundary — it is not part
      // of the tenant and calls to it leave Cumulocity — and the agent needs
      // that to report accurately where data came from or went.
      const label = ns.external
        ? `EXTERNAL MCP server at ${ns.external.url} — configured for this connection, NOT part of this tenant`
        : ns.server.mcpName
      lines.push(`- ${ns.name} — ${label} (${ns.tools.length} methods)${short ? `: ${short}` : ''}`)
    }
  }
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
  const lines = [`"${target}" is not a method target. Use codemode.describe("<namespace>.<method>") for one method, or codemode.search("keywords") to find methods.`]
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
 * `namespace.method` pair, or a bare method name searched across all
 * namespaces. Namespace-only targets are intentionally rejected — a full
 * method dump floods context; search is the discovery path.
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

  const methodName = maybeMethod ?? trimmed
  const candidates = namespace && maybeMethod !== undefined ? [namespace] : namespaces
  for (const candidate of candidates) {
    const found = findMethod(candidate, methodName)
    if (found)
      return found
  }

  return { target: trimmed, kind: 'method', content: renderSearchRedirect(trimmed, namespaces, methodIndex) }
}
