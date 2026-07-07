import * as v from 'valibot'
import { dryRun } from '../codemode/execute'
import type { InterceptedOp } from '../codemode/execute'
import { c8yMcpServer } from '../server-instance'
import { buildOpaTransactionPlan, evaluatePolicy } from '../policy'

// ─────────────────────────────────────────────────────────────────────────
// Mutating-operation summary for elicitation
// ─────────────────────────────────────────────────────────────────────────

const MAX_INLINE_IDS = 5
const MAX_BODY_FIELDS = 5
const MAX_STRING_LEN = 60

function truncate(s: string): string {
  return s.length > MAX_STRING_LEN ? `${s.slice(0, MAX_STRING_LEN)}…` : s
}

function summarizeValue(val: unknown): string {
  if (val === null || val === undefined)
    return 'null'
  if (typeof val === 'string')
    return `"${truncate(val)}"`
  if (typeof val === 'number' || typeof val === 'boolean')
    return String(val)
  if (Array.isArray(val))
    return `[${val.length} items]`
  if (typeof val === 'object')
    return `{${Object.keys(val as object).join(', ')}}`
  return String(val)
}

function bodyLines(body: unknown): string[] {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return []
  const entries = Object.entries(body as Record<string, unknown>)
  const shown = entries.slice(0, MAX_BODY_FIELDS).map(([k, val]) => `    ${k}: ${summarizeValue(val)}`)
  if (entries.length > MAX_BODY_FIELDS)
    shown.push(`    … (${entries.length - MAX_BODY_FIELDS} more fields)`)
  return shown
}

function canonicalize(path: string): { base: string, id: string | null } {
  const [pathPart, qs] = path.split('?', 2) as [string, string | undefined]
  const segments = pathPart.split('/')
  const last = segments[segments.length - 1] ?? ''
  const isId = /^\d+$/.test(last) || /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(last)
  if (isId) {
    segments[segments.length - 1] = '{id}'
    return { base: segments.join('/') + (qs != null ? `?${qs}` : ''), id: last }
  }
  return { base: path, id: null }
}

function formatMutatingOpsSummary(ops: InterceptedOp[]): string {
  const postCount = ops.filter((o) => o.method === 'POST').length
  const putCount = ops.filter((o) => o.method === 'PUT').length
  const delCount = ops.filter((o) => o.method === 'DELETE').length
  const parts = [
    delCount > 0 ? `${delCount} DELETE` : '',
    putCount > 0 ? `${putCount} PUT` : '',
    postCount > 0 ? `${postCount} POST` : '',
  ].filter(Boolean).join(', ')

  const lines: string[] = [
    `${ops.length} mutating API operation${ops.length !== 1 ? 's' : ''} detected (${parts}):`,
    '',
  ]

  interface Group { method: string, base: string, ids: string[], ops: InterceptedOp[] }
  const groups = new Map<string, Group>()
  for (const op of ops) {
    const { base, id } = canonicalize(op.path)
    const key = `${op.method}:${base}`
    if (!groups.has(key))
      groups.set(key, { method: op.method, base, ids: [], ops: [] })
    const g = groups.get(key)!
    if (id)
      g.ids.push(id)
    g.ops.push(op)
  }

  for (const g of groups.values()) {
    const first = g.ops[0]
    if (!first)
      continue
    if (g.ops.length === 1) {
      lines.push(`${g.method} ${first.path}`)
      if (g.method !== 'DELETE')
        lines.push(...bodyLines(first.body))
    } else {
      lines.push(`${g.method} ${g.base} ×${g.ops.length}`)
      if (g.ids.length > 0) {
        const shown = g.ids.slice(0, MAX_INLINE_IDS)
        const rest = g.ids.length - shown.length
        lines.push(`  IDs: ${shown.join(', ')}${rest > 0 ? ` … (+${rest} more)` : ''}`)
      }
      if (g.method !== 'DELETE') {
        const sample = bodyLines(first.body)
        if (sample.length > 0) {
          lines.push('  Body (first operation):')
          lines.push(...sample)
        }
      }
    }
  }

  return lines.join('\n')
}

// ─────────────────────────────────────────────────────────────────────────
// Elicitation workflow
// ─────────────────────────────────────────────────────────────────────────

/**
 * Runs a dry-run of the given code and, if POST/PUT/DELETE operations are
 * detected, applies the OPA policy (when `--policy-data` was supplied) or
 * falls back to MCP elicitation.
 *
 * OPA decisions:
 *   allow  — proceed silently, no prompt
 *   elicit — show the approval prompt (same as the no-policy fallback)
 *   deny   — auto-reject without prompting
 *
 * Returns null if execution should proceed, or an error string if blocked.
 * @param code The JavaScript code to analyze, as a zero-parameter function expression.
 */
export async function evaluatePolicies(code: string): Promise<string | null> {
  const ops = await dryRun(code)
  const mutating = ops.filter((o) => o.method === 'POST' || o.method === 'PUT' || o.method === 'DELETE')

  if (mutating.length === 0)
    return null

  const tenantUrl = c8yMcpServer.ctx.custom?.auth?.tenantUrl ?? '(unknown)'
  const policyDataPath = c8yMcpServer.ctx.custom?.policyDataPath

  // ── OPA policy evaluation ──────────────────────────────────────────────
  if (policyDataPath) {
    const plan = buildOpaTransactionPlan(mutating, tenantUrl)
    let decision
    try {
      decision = await evaluatePolicy(plan, policyDataPath)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      return `Execution blocked: OPA policy evaluation failed — ${reason}`
    }

    if (decision.action === 'allow')
      return null
    if (decision.action === 'deny') {
      const reasons = decision.denyReasons.length > 0
        ? `\n${decision.denyReasons.map((r) => `- ${r}`).join('\n')}`
        : ''
      return `Execution blocked by policy.${reasons}`
    }
    // action === 'elicit' → fall through to the elicitation prompt below
  }

  // ── Elicitation (no policy data, or policy says "elicit") ─────────────
  const message = [
    formatMutatingOpsSummary(mutating),
  ].join('\n')

  // v.optional allows undefined content when action is 'decline' or 'cancel',
  // avoiding a spurious validation throw inside tmcp that would mask the real action.
  const schema = v.optional(v.object({}))

  let approval
  try {
    approval = await c8yMcpServer.elicitation(message, schema)
  } catch {
    return (
      'Execution blocked: mutating operations (POST/PUT/DELETE) require your approval, '
      + 'but the MCP client does not support elicitation. '
      + 'Use a client that supports MCP elicitation (e.g. Claude Desktop) to run mutating operations.'
    )
  }

  if (approval.action === 'decline')
    return 'Execution cancelled: you declined the approval prompt.'
  if (approval.action === 'cancel')
    return 'Execution cancelled: the approval prompt was dismissed.'
  if (approval.action !== 'accept')
    return 'Execution was not approved.'

  return null
}
