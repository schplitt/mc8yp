import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadPolicy } from '@open-policy-agent/opa-wasm'
import type { OpaTransactionPlan } from './transaction-plan'

export type PolicyAction = 'allow' | 'elicit' | 'deny'

export interface PolicyResult {
  action: PolicyAction
  /** Populated when action is 'deny'; empty otherwise. */
  denyReasons: string[]
}

// Lazily loaded and cached — the WASM module is heavy; we only instantiate it
// once and reuse it across evaluate() calls within the same process.
let _policy: Awaited<ReturnType<typeof loadPolicy>> | null = null

async function getPolicy(): Promise<Awaited<ReturnType<typeof loadPolicy>>> {
  if (!_policy) {
    const wasmPath = fileURLToPath(new URL('./bundle.wasm', import.meta.url))
    _policy = await loadPolicy(readFileSync(wasmPath))
  }
  return _policy
}

/**
 * Evaluates the bundled OPA policy against the given transaction plan and
 * the data document loaded from `dataPath`.
 *
 * The policy exposes a single `decision` entrypoint shaped as
 * `{ action, reasons }`. Returns `elicit` (the safe default) when the result
 * is missing or malformed.
 */
export async function evaluatePolicy(
  plan: OpaTransactionPlan,
  dataPath: string,
): Promise<PolicyResult> {
  const policy = await getPolicy()
  const data = JSON.parse(readFileSync(dataPath, 'utf8')) as object
  policy.setData(data)

  const results = policy.evaluate(plan.input) as Array<{ result?: { action?: unknown, reasons?: unknown } }> | null
  const decision = results?.[0]?.result
  const raw = decision?.action
  const action: PolicyAction = raw === 'allow' || raw === 'deny' || raw === 'elicit' ? raw : 'elicit'
  const denyReasons = action === 'deny' && Array.isArray(decision?.reasons) ? (decision.reasons as string[]) : []

  return { action, denyReasons }
}
