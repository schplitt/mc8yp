import process from 'node:process'
import { encode } from '@toon-format/toon'
import { createSafeFetch } from '@iso4/fetch'
import type { SafeFetchGlobal } from '@iso4/fetch'
import { createSandbox } from '@iso4/sandbox'
import type { HostGlobals, Sandbox } from '@iso4/sandbox'
import { createC8yAuthHeaders, resolveC8yAuth } from '../utils/client'
import { c8yMcpServer } from '../server-instance'
import { evaluateAccessPolicy } from '../utils/restriction-matcher'
import { HTTP_METHODS } from '../utils/restrictions'
import type { AllowRule, RestrictionRule } from '../utils/restrictions'

const QUERY_ENTRY_PATH = '/codemode-query.mjs'
const EXECUTE_ENTRY_PATH = '/codemode-execute.mjs'

export const BLOCKED_REQUEST_PREFIX = 'Request blocked by MCP connection policy.'

const SANDBOX_LIMITS = {
  memoryMb: 128,
  cpuTimeMs: 50_000,
  maxBridgeCalls: 200,
} as const

// ─────────────────────────────────────────────────────────────────────────
// Sandbox lifecycle (lazy singleton)
// ─────────────────────────────────────────────────────────────────────────

let sandboxPromise: Promise<Sandbox> | null = null

async function getSandbox(): Promise<Sandbox> {
  sandboxPromise ??= createSandbox({ maxIsolates: 10 })
  return sandboxPromise
}

export async function disposeSandbox(): Promise<void> {
  if (!sandboxPromise)
    return
  const pending = sandboxPromise
  sandboxPromise = null
  try {
    const sandbox = await pending
    await sandbox.dispose()
  } catch {
    // already disposed or failed to start
  }
}

// Best-effort shutdown for CLI stdio mode where there is no explicit teardown.
process.once('exit', () => {
  if (sandboxPromise) {
    sandboxPromise.then((s) => s.dispose()).catch(() => undefined)
  }
})

// ─────────────────────────────────────────────────────────────────────────
// Blocked-policy error formatters
// ─────────────────────────────────────────────────────────────────────────

function formatRestrictionBlockMessage(
  method: string,
  pathname: string,
  matching: readonly RestrictionRule[],
): string {
  return [
    BLOCKED_REQUEST_PREFIX,
    '',
    'This operation is intentionally denied by the current MCP connection configuration.',
    'It did not fail at the Cumulocity API and it was not executed against the tenant.',
    'Retrying or trying the same operation again through this connection will not succeed.',
    '',
    'Report this to the user as a connection-level access restriction.',
    'If the operation is needed, the MCP restrictions for this connection must be updated by whoever manages that configuration.',
    '',
    'Blocked operation:',
    `Method: ${method}`,
    `Path: ${pathname}`,
    'Matching restrictions:',
    ...matching.map((rule) => `- ${rule.source}`),
  ].join('\n')
}

function formatAllowBlockMessage(
  method: string,
  pathname: string,
  allowRules: readonly AllowRule[],
): string {
  return [
    BLOCKED_REQUEST_PREFIX,
    '',
    'This operation is intentionally blocked because it is not included in the current MCP connection allow list.',
    'It did not fail at the Cumulocity API and it was not executed against the tenant.',
    'Retrying or trying the same operation again through this connection will not succeed.',
    '',
    'Report this to the user as a connection-level access restriction.',
    'If the operation is needed, the MCP allow list for this connection must be updated by whoever manages that configuration.',
    '',
    'Blocked operation:',
    `Method: ${method}`,
    `Path: ${pathname}`,
    'Configured allow rules:',
    ...(allowRules.length > 0 ? allowRules.map((rule) => `- ${rule.source}`) : ['- (none)']),
  ].join('\n')
}

// ─────────────────────────────────────────────────────────────────────────
// safeFetch wiring
//
// All host-side responsibilities live as origin middleware:
//   1. restriction / allow-rule enforcement (throws blocked-policy message)
//   2. auth header injection (last write wins so agent cannot override)
//   3. response unwrap: parse body, throw on non-2xx, replace ctx.res.body
//      with the parsed value so the sandbox-side wrapper can return it
//      directly without ever calling res.json() / res.text().
// ─────────────────────────────────────────────────────────────────────────

export function createCumulocitySafeFetch(
  tenantUrl: string,
  authHeaders: Record<string, string>,
  restrictions: readonly RestrictionRule[] = [],
  allowRules: readonly AllowRule[] = [],
): SafeFetchGlobal {
  const parsedTenant = new URL(tenantUrl)

  return createSafeFetch({
    rules: {
      host: parsedTenant.hostname,
      port: parsedTenant.port ? Number(parsedTenant.port) : undefined,
      httpsOnly: parsedTenant.protocol === 'https:',
      routes: [{ path: '/**' }],
      middleware: async (ctx, next) => {
        const method = ctx.req.method.toUpperCase()
        const pathname = new URL(ctx.req.url).pathname

        const decision = evaluateAccessPolicy(restrictions, allowRules, method, pathname)
        if (decision.blocked) {
          throw new Error(
            decision.blockedBy === 'restriction'
              ? formatRestrictionBlockMessage(method, pathname, decision.matchingRestrictions)
              : formatAllowBlockMessage(method, pathname, allowRules),
          )
        }

        for (const [k, v] of Object.entries(authHeaders)) {
          ctx.req.header(k, v)
        }

        await next()

        const res = ctx.res!
        const raw = res.body
        const text = raw instanceof Uint8Array
          ? new TextDecoder().decode(raw)
          : typeof raw === 'string'
            ? raw
            : ''
        const contentType = String(res.headers['content-type'] ?? '')
        const data = text === ''
          ? null
          : contentType.includes('json')
            ? JSON.parse(text)
            : text

        if (res.status < 200 || res.status >= 300) {
          const detail = typeof data === 'string' ? data : JSON.stringify(data)
          throw new Error(
            `Cumulocity request failed with ${res.status} ${res.statusText ?? ''}${detail ? `: ${detail}` : ''}`.trim(),
          )
        }

        ctx.res = { ...res, body: data }
      },
    },
    // Cumulocity tenants are operator-configured, not agent-chosen — the
    // SSRF surface that pinDns guards against does not exist here. Disabling
    // it also lets on-prem tenants resolved to private IPs work.
    pinDns: false,
    allowCompressedResponses: false,
  })
}

// ─────────────────────────────────────────────────────────────────────────
// Code generation
// ─────────────────────────────────────────────────────────────────────────

function normalizeCode(functionCode: string): string {
  return functionCode
    .trim()
    .replace(/^```(?:js|javascript|ts|typescript)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()
}

function buildQueryScript(sourceCode: string): string {
  const functionExpression = normalizeCode(sourceCode)
  const custom = c8yMcpServer.ctx.custom
  const resolved = custom?.specs
  if (!resolved) {
    throw new Error(
      custom?.env === 'cli'
        ? 'No active tenant set. Call set-active-tenant first.'
        : 'No tenant specs available for this MCP connection. This usually means the request reached the server without a resolvable tenant context (e.g. a platform probe). Reconnect with valid tenant auth.',
    )
  }
  return [
    `const coreSpec = ${JSON.stringify(resolved.core)};`,
    `const serviceSpecs = ${JSON.stringify(resolved.specs)};`,
    `const __mc8ypQuery = (${functionExpression});`,
    'if (typeof __mc8ypQuery !== "function") { throw new TypeError("Query code must evaluate to a function.") }',
    'export default await __mc8ypQuery();',
  ].join('\n')
}

/**
 * String-form HostGlobalValue for `cumulocity`.
 *
 * Installed by iso4 as `globalThis.cumulocity = (<expr>)`. Thin sandbox-side
 * wrapper that validates input, normalises object bodies to JSON, builds the
 * tenant-relative URL, and calls the bridged safeFetch. Everything else
 * (policy enforcement, auth injection, response parsing, error mapping) runs
 * host-side in the middleware above.
 * @param tenantUrl - canonical tenant origin used to resolve agent-supplied
 *   relative paths.
 */
function buildCumulocityPreamble(tenantUrl: string): string {
  const baseUrl = tenantUrl.endsWith('/') ? tenantUrl : `${tenantUrl}/`
  return `(() => {
  const BASE_URL = ${JSON.stringify(baseUrl)};
  const HTTP_METHODS = ${JSON.stringify(HTTP_METHODS)};
  return Object.freeze({
    request: async (opts) => {
      if (!opts || typeof opts !== 'object') throw new TypeError('request options must be an object');
      if (typeof opts.path !== 'string' || opts.path.length === 0) throw new TypeError('request path must be a non-empty string');
      if (typeof opts.method !== 'string' || opts.method.trim().length === 0) throw new TypeError('request method must be a non-empty string');
      const method = opts.method.trim().toUpperCase();
      if (!HTTP_METHODS.includes(method)) throw new TypeError('request method must be one of: ' + HTTP_METHODS.join(', '));
      // BASE_URL is normalised to end with '/'. iso4 does not expose URL as
      // a sandbox global, so resolve relative paths via string concat.
      const path = opts.path.startsWith('/') ? opts.path.slice(1) : opts.path;
      const url = BASE_URL + path;
      const headers = {};
      if (opts.headers && typeof opts.headers === 'object') {
        for (const [k, v] of Object.entries(opts.headers)) {
          if (typeof v === 'string') headers[k] = v;
        }
      }
      let body = opts.body == null ? null : opts.body;
      if (body !== null && typeof body !== 'string' && !(body instanceof Uint8Array)) {
        const hasCT = Object.keys(headers).some((k) => k.toLowerCase() === 'content-type');
        if (!hasCT) headers['content-type'] = 'application/json';
        body = JSON.stringify(body);
      }
      const res = await __c8y_fetch(url, { method, headers, body });
      return res.body;
    },
  });
})()`
}

// ─────────────────────────────────────────────────────────────────────────
// Public surface
// ─────────────────────────────────────────────────────────────────────────

const NO_DEFAULT_EXPORT_MESSAGE = 'Execution completed without returning a value.'

function extractDefaultExport(exportsObject: unknown): unknown {
  if ((typeof exportsObject === 'object' && exportsObject !== null) || typeof exportsObject === 'function') {
    if (Object.hasOwn(exportsObject, 'default')) {
      return (exportsObject as { default: unknown }).default
    }
  }
  if (typeof exportsObject !== 'undefined')
    return exportsObject
  throw new Error(NO_DEFAULT_EXPORT_MESSAGE)
}

export async function query(functionCode: string): Promise<string> {
  const sandbox = await getSandbox()
  const result = await sandbox.run({
    code: buildQueryScript(functionCode),
    filename: QUERY_ENTRY_PATH,
    limits: SANDBOX_LIMITS,
    // No globals → no fetch surface; the query sandbox cannot reach the network.
  })

  if (!result.ok) {
    throw new Error(`Execution failed with code ${result.error.code}: ${result.error.message}`)
  }

  const value = extractDefaultExport(result.exports)
  const body = typeof value === 'string' ? value : JSON.stringify(value)
  // The tenant footer is a CLI-only affordance: in CLI mode the active tenant
  // is global session state that can flip between calls, so the agent needs a
  // visible marker to verify which tenant a result reflects. In server mode
  // the tenant is fixed by deployment and request auth, so the footer would
  // just be noise.
  if (c8yMcpServer.ctx.custom?.env !== 'cli')
    return body
  const tenantUrl = c8yMcpServer.ctx.custom?.auth?.tenantUrl
  const footer = tenantUrl
    ? `Query ran against tenant: ${tenantUrl}. Visible specs are everything currently available for that tenant.`
    : 'Query ran against bundled OpenAPI snapshots only — no active tenant. Visibility here does NOT guarantee any service is installed on a tenant.'
  return `${body}\n\n---\n${footer}`
}

function withCliTenantMarker(text: string, tenantUrl: string): string {
  return c8yMcpServer.ctx.custom?.env === 'cli'
    ? `Executed against tenant: ${tenantUrl}\n\n${text}`
    : text
}

export async function execute(functionCode: string): Promise<string> {
  const auth = await resolveC8yAuth()
  const authHeaders = createC8yAuthHeaders(auth)
  const restrictions = c8yMcpServer.ctx.custom?.restrictions ?? []
  const allowRules = c8yMcpServer.ctx.custom?.allowRules ?? []

  const functionExpression = normalizeCode(functionCode)
  const code = [
    `const __mc8ypExecute = (${functionExpression});`,
    'if (typeof __mc8ypExecute !== "function") { throw new TypeError("Execute code must evaluate to a function.") }',
    'export default await __mc8ypExecute();',
  ].join('\n')

  const globals: HostGlobals = {
    __c8y_fetch: createCumulocitySafeFetch(auth.tenantUrl, authHeaders, restrictions, allowRules),
    cumulocity: buildCumulocityPreamble(auth.tenantUrl),
  }

  const sandbox = await getSandbox()
  const result = await sandbox.run({
    code,
    filename: EXECUTE_ENTRY_PATH,
    limits: SANDBOX_LIMITS,
    globals,
  })

  if (!result.ok) {
    // User error or blocked-policy throw — surface the raw message so the
    // BLOCKED_REQUEST_PREFIX prefix stays intact for callers that branch on it.
    return withCliTenantMarker(result.error.message, auth.tenantUrl)
  }

  return withCliTenantMarker(encode(extractDefaultExport(result.exports)), auth.tenantUrl)
}
