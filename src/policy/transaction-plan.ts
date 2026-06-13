import type { InterceptedOp } from '../codemode/execute'

interface OpaTransaction {
  id: string
  method: string
  /**
   * Exact path from the request, without query string.
   */
  path: string
  /**
   * Path with numeric/UUID segments replaced by `*` so that glob patterns
   * in data.json rules can match them directly.
   * Example: `/inventory/managedObjects/12345` → `/inventory/managedObjects/*`
   */
  pathTemplate: string
  /**
   * Extracted resource ID, or null when path has no trailing ID segment.
   */
  resourceId: string | null
  /**
   * Parsed query parameters, or null when none present.
   */
  queryParams: Record<string, string> | null
  /**
   * Parsed request body, or null for bodyless methods.
   */
  body: unknown
}

export interface OpaTransactionPlan {
  input: {
    principal: { tenant: string }
    transactions: OpaTransaction[]
    context: { tool: 'mc8yp-execute' }
  }
}

function canonicalize(path: string): { base: string, id: string | null } {
  const [pathPart, qs] = path.split('?', 2) as [string, string | undefined]
  const segments = pathPart.split('/')
  const last = segments[segments.length - 1] ?? ''
  const isId = /^\d+$/.test(last) || /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(last)
  if (isId) {
    // Use `*` (not `{id}`) so the value works as a glob target in data.json rules.
    segments[segments.length - 1] = '*'
    return { base: segments.join('/') + (qs != null ? `?${qs}` : ''), id: last }
  }
  return { base: path, id: null }
}

export function buildOpaTransactionPlan(ops: InterceptedOp[], tenantUrl: string): OpaTransactionPlan {
  return {
    input: {
      principal: { tenant: tenantUrl },
      transactions: ops.map((op, i) => {
        const [pathPart, qs] = op.path.split('?', 2) as [string, string | undefined]
        const { base, id: resourceId } = canonicalize(op.path)
        const pathTemplate = base.split('?')[0] as string
        const queryParams = qs
          ? Object.fromEntries(new URLSearchParams(qs))
          : null
        return {
          id: `op-${i}`,
          method: op.method,
          path: pathPart,
          pathTemplate,
          resourceId,
          queryParams,
          body: op.body,
        }
      }),
      context: { tool: 'mc8yp-execute' },
    },
  }
}
