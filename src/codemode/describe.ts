import { searchMethods } from './method-search'
import { renderMethodDeclaration } from './type-render'
import type { MethodIndex } from './method-search'
import type { CodemodeNamespace } from './namespaces'
import type { DerivedOperation } from './derive-operations'

// ─────────────────────────────────────────────────────────────────────────
// codemode.describe — on-demand documentation rendering.
//
// Deliberately method-only: rendering the full typed block for a whole
// namespace would flood the agent's context (c8y alone has ~250 operations).
// The only real target is a single method — `describe("dtm.getAssets")` —
// and its output is lean: the request line, prose, the bare signature, and
// the input/output types (whose properties carry the OpenAPI descriptions
// as JSDoc). Discovery across methods is codemode.search's job, not a
// namespace dump.
// ─────────────────────────────────────────────────────────────────────────

export interface DescribeOutput {
  target: string
  kind: 'overview' | 'method'
  content: string
}

interface SpecWithInfo {
  info?: { title?: string, description?: string }
}

function renderOverview(namespaces: readonly CodemodeNamespace[]): string {
  const lines = ['Available API namespaces on this tenant (do not assume capabilities from prior knowledge — search each relevant domain):']
  for (const ns of namespaces) {
    const info = (ns.spec as SpecWithInfo).info
    const title = info?.title
    // One flattened, truncated line of the spec's own description — enough
    // to route a problem domain to its namespace without flooding context.
    const summary = info?.description?.trim().replace(/\s+/g, ' ')
    const short = summary ? (summary.length > 220 ? `${summary.slice(0, 220)}…` : summary) : undefined
    lines.push(`- ${ns.name}${title ? ` — ${title}` : ''} (${ns.operations.length} methods)${short ? `: ${short}` : ''}`)
  }
  lines.push(
    '',
    'Workflow:',
    '- codemode.search("keywords") — find methods by name/path/summary (top 20 by score)',
    '- codemode.describe("<namespace>.<method>") — types and docs for one method',
    '- docs.search("keywords") / docs.read(id) — documentation topics (domain query languages, concepts)',
    '- <namespace>.<method>({ ...params, body }) — call the API',
    '- <namespace>.request({ method, path, params, body, headers }) — low-level escape hatch',
  )
  return lines.join('\n')
}

function renderMethod(namespace: CodemodeNamespace, op: DerivedOperation): string {
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

function renderSearchRedirect(target: string, namespaces: readonly CodemodeNamespace[], methodIndex: MethodIndex): string {
  const visible = new Set(namespaces.flatMap((ns) => ns.operations.map((op) => `${ns.name}.${op.name}`)))
  const { results } = searchMethods(methodIndex, target, (t) => visible.has(t))
  const suggestions = results.slice(0, 3)
  const lines = [`"${target}" is not a method target. Use codemode.describe("<namespace>.<method>") for one method, or codemode.search("keywords") to find methods.`]
  if (suggestions.length > 0) {
    lines.push('', 'Closest methods:')
    for (const s of suggestions) lines.push(`- ${s.target} — ${s.httpMethod} ${s.apiPath}`)
  }
  return lines.join('\n')
}

/**
 * Resolve a describe target: nothing (short overview of namespaces), a
 * `namespace.method` pair, or a bare method name searched across all
 * namespaces. Namespace-only targets are intentionally rejected — a full
 * method dump floods context; search is the discovery path.
 * @param namespaces
 * @param methodIndex
 * @param target
 */
export function describeTarget(namespaces: readonly CodemodeNamespace[], methodIndex: MethodIndex, target?: string): DescribeOutput {
  const trimmed = target?.trim() ?? ''
  if (trimmed === '')
    return { target: '', kind: 'overview', content: renderOverview(namespaces) }

  const [maybeNamespace, maybeMethod] = trimmed.includes('.')
    ? [trimmed.slice(0, trimmed.indexOf('.')), trimmed.slice(trimmed.indexOf('.') + 1)]
    : [trimmed, undefined]

  const namespace = namespaces.find((ns) => ns.name === maybeNamespace)

  const methodName = maybeMethod ?? trimmed
  const candidates = namespace && maybeMethod !== undefined ? [namespace] : namespaces
  for (const candidate of candidates) {
    const op = candidate.operations.find((o) => o.name === methodName)
    if (op)
      return { target: `${candidate.name}.${op.name}`, kind: 'method', content: renderMethod(candidate, op) }
  }

  return { target: trimmed, kind: 'method', content: renderSearchRedirect(trimmed, namespaces, methodIndex) }
}
