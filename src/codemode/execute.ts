import process from 'node:process'
import { encode } from '@toon-format/toon'
import { createSafeFetch } from '@iso4/fetch'
import type { SafeFetchGlobal } from '@iso4/fetch'
import { createSandbox } from '@iso4/sandbox'
import type { HostModuleObject, Sandbox } from '@iso4/sandbox'
import { toRequest } from './derive-operations'
import { describeTarget } from './describe'
import { getDocsIndex, readDoc, searchDocs } from './docs-index'
import { getMethodIndex, searchMethods } from './method-search'
import type { MethodIndex } from './method-search'
import { buildNamespaces, toSearchableMethods } from './namespaces'
import type { CodemodeNamespace } from './namespaces'
import type { DocsSearchOptions } from './docs-index'
import { createC8yAuthHeaders, resolveC8yAuth } from '../utils/client'
import { c8yMcpServer } from '../server-instance'
import { evaluateAccessPolicy } from '../utils/restriction-matcher'
import { HTTP_METHODS } from '../utils/restrictions'
import type { AllowRule, RestrictionRule } from '../utils/restrictions'
import type { ResolvedSpecs } from '../utils/spec-resolution'

const EXECUTE_ENTRY_PATH = '/codemode-execute.mjs'

export const BLOCKED_REQUEST_PREFIX = 'Request blocked by MCP connection policy.'

const SANDBOX_LIMITS = {
  memoryMb: 128,
  cpuTimeMs: 50_000,
  wallTimeMs: 120_000,
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
// All request-time responsibilities live as origin middleware:
//   1. restriction / allow-rule enforcement (throws blocked-policy message)
//   2. auth header injection (last write wins so agent cannot override)
//   3. response unwrap: parse body, throw on non-2xx, replace ctx.res.body
//      with the parsed value.
//
// The safeFetch is never exposed to the sandbox: every live call — derived
// namespace method or `.request` escape hatch — is dispatched host-side and
// invokes `handler` directly, so the sandbox has no fetch surface at all.
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
// Host-side request dispatch
// ─────────────────────────────────────────────────────────────────────────

interface OutgoingRequest {
  method: string
  path: string
  query?: Record<string, unknown>
  body?: unknown
  headers?: Record<string, string>
}

/**
 * Build the final URL and invoke the safeFetch handler directly (host-side).
 * Policy enforcement, auth injection, and response parsing all happen in the
 * safeFetch middleware — this is the single funnel every live request goes
 * through, derived method and escape hatch alike.
 * @param safeFetch
 * @param tenantUrl
 * @param request
 */
async function performRequest(safeFetch: SafeFetchGlobal, tenantUrl: string, request: OutgoingRequest): Promise<unknown> {
  const base = tenantUrl.endsWith('/') ? tenantUrl : `${tenantUrl}/`
  let url = base + (request.path.startsWith('/') ? request.path.slice(1) : request.path)

  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(request.query ?? {})) {
    if (value === undefined || value === null)
      continue
    if (Array.isArray(value)) {
      for (const item of value) search.append(key, String(item))
    } else {
      search.append(key, String(value))
    }
  }
  const queryString = search.toString()
  if (queryString)
    url += (url.includes('?') ? '&' : '?') + queryString

  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(request.headers ?? {})) {
    if (typeof value === 'string')
      headers[key] = value
  }

  let body: unknown = request.body ?? null
  if (body !== null && typeof body !== 'string' && !(body instanceof Uint8Array)) {
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type'))
      headers['content-type'] = 'application/json'
    body = JSON.stringify(body)
  }

  const response = await safeFetch.handler(url, { method: request.method, headers, body })
  return response.body
}

// ─────────────────────────────────────────────────────────────────────────
// Sandbox module assembly
//
// iso4 host modules replace string preambles: the api module below is a
// plain object whose function leaves become bridge stubs inside a generated
// ESM module. The static entry module wires those exports onto globalThis
// and calls the agent's function, which arrives as its own source module.
// ─────────────────────────────────────────────────────────────────────────

const API_MODULE_SPECIFIER = 'mc8yp:api'
const AGENT_MODULE_SPECIFIER = 'mc8yp:agent'

// Import order matters for evaluation, not for safety: both imported modules
// only *define* values at evaluation time — the agent function body runs
// after the globalThis wiring below it.
const ENTRY_SOURCE = [
  `import * as __api from '${API_MODULE_SPECIFIER}'`,
  `import __run from '${AGENT_MODULE_SPECIFIER}'`,
  'globalThis.codemode = __api.codemode',
  'globalThis.docs = __api.docs',
  'for (const [name, namespace] of Object.entries(__api.namespaces)) globalThis[name] = namespace',
  'export default await __run()',
].join('\n')

function normalizeCode(functionCode: string): string {
  return functionCode
    .trim()
    .replace(/^```(?:js|javascript|ts|typescript)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()
}

function buildAgentModule(functionCode: string): string {
  return [
    `const __mc8ypExecute = (${normalizeCode(functionCode)});`,
    'if (typeof __mc8ypExecute !== "function") { throw new TypeError("Execute code must evaluate to a function.") }',
    'export default __mc8ypExecute',
  ].join('\n')
}

/**
 * A live-call dispatcher; degraded to a throwing stub when no tenant is active.
 */
interface LiveCalls {
  operation: (namespace: CodemodeNamespace, opName: string, input: unknown) => Promise<unknown>
  request: (options: unknown) => Promise<unknown>
}

function createLiveCalls(safeFetch: SafeFetchGlobal, tenantUrl: string): LiveCalls {
  return {
    operation: async (namespace, opName, input) => {
      const op = namespace.operations.find((o) => o.name === opName)!
      return performRequest(safeFetch, tenantUrl, toRequest(op, input))
    },
    request: async (rawOptions) => {
      if (!rawOptions || typeof rawOptions !== 'object')
        throw new TypeError('request options must be an object')
      const options = rawOptions as { method?: unknown, path?: unknown, params?: unknown, body?: unknown, headers?: unknown }
      if (typeof options.path !== 'string' || options.path.length === 0)
        throw new TypeError('request path must be a non-empty string')
      if (typeof options.method !== 'string' || options.method.trim().length === 0)
        throw new TypeError('request method must be a non-empty string')
      const method = options.method.trim().toUpperCase()
      if (!HTTP_METHODS.includes(method as typeof HTTP_METHODS[number]))
        throw new TypeError(`request method must be one of: ${HTTP_METHODS.join(', ')}`)
      return performRequest(safeFetch, tenantUrl, {
        method,
        path: options.path,
        query: options.params && typeof options.params === 'object' ? options.params as Record<string, unknown> : undefined,
        body: options.body,
        headers: options.headers && typeof options.headers === 'object' ? options.headers as Record<string, string> : undefined,
      })
    },
  }
}

function createUnauthenticatedCalls(message: string): LiveCalls {
  const fail = async (): Promise<never> => {
    throw new Error(message)
  }
  return { operation: fail, request: fail }
}

function buildApiModule(
  namespaces: readonly CodemodeNamespace[],
  methodIndex: MethodIndex,
  docsIndex: ReturnType<typeof getDocsIndex>,
  live: LiveCalls,
): HostModuleObject {
  const visibleTargets = new Set(namespaces.flatMap((ns) => ns.operations.map((op) => `${ns.name}.${op.name}`)))

  return {
    codemode: {
      search: async (...args: unknown[]) => {
        const [query] = args
        const valid = typeof query === 'string'
          ? query.trim() !== ''
          : Array.isArray(query) && query.some((q) => typeof q === 'string' && q.trim() !== '')
        if (!valid)
          throw new TypeError('codemode.search(query): pass a non-empty string or an array of query phrasings')
        return searchMethods(methodIndex, query as string | string[], (target) => visibleTargets.has(target))
      },
      describe: async (...args: unknown[]) => {
        const [target] = args
        // Array form: describe a SHORTLIST of methods in one call so their
        // input types can be compared side by side. Capped so it cannot
        // become a namespace dump through the back door.
        if (Array.isArray(target)) {
          const targets = target.filter((t) => typeof t === 'string' && t.trim() !== '')
          if (targets.length === 0)
            throw new TypeError('codemode.describe(targets): pass method targets like "c8y.getAlarmCollectionResource"')
          if (targets.length > 5)
            throw new TypeError(`codemode.describe(targets): at most 5 targets per call (got ${targets.length}) — shortlist candidates via search first`)
          return targets.map((t) => describeTarget(namespaces, methodIndex, t))
        }
        return describeTarget(namespaces, methodIndex, target == null ? undefined : String(target))
      },
    },
    docs: {
      search: async (...args: unknown[]) => {
        const [query, options] = args
        return searchDocs(
          docsIndex,
          String(query ?? ''),
          options && typeof options === 'object' ? options as DocsSearchOptions : {},
        )
      },
      read: async (...args: unknown[]) => {
        const [id] = args
        const doc = readDoc(docsIndex, String(id ?? ''))
        if (!doc)
          throw new Error(`No documentation with id "${String(id)}". Ids come from docs.search results and codemode.describe output.`)
        return doc
      },
    },
    namespaces: Object.fromEntries(namespaces.map((namespace) => [namespace.name, {
      request: async (...args: unknown[]) => live.request(args[0]),
      ...Object.fromEntries(namespace.operations.map((op) => [
        op.name,
        async (...args: unknown[]) => live.operation(namespace, op.name, args[0]),
      ])),
    }])),
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Runtime context resolution
// ─────────────────────────────────────────────────────────────────────────

interface CodemodeRuntime {
  resolved: ResolvedSpecs
  namespaces: CodemodeNamespace[]
  restrictions: readonly RestrictionRule[]
  allowRules: readonly AllowRule[]
}

function resolveRuntime(): CodemodeRuntime {
  const custom = c8yMcpServer.ctx.custom
  const resolved = custom?.specs
  if (!resolved) {
    throw new Error(
      custom?.env === 'cli'
        ? 'No active tenant set. Call set-active-tenant first.'
        : 'No tenant specs available for this MCP connection. This usually means the request reached the server without a resolvable tenant context (e.g. a platform probe). Reconnect with valid tenant auth.',
    )
  }
  const restrictions = custom?.restrictions ?? []
  const allowRules = custom?.allowRules ?? []
  return { resolved, restrictions, allowRules, namespaces: buildNamespaces(resolved, restrictions, allowRules) }
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

function withCliTenantMarker(text: string, tenantUrl: string | null): string {
  if (c8yMcpServer.ctx.custom?.env !== 'cli')
    return text
  const marker = tenantUrl
    ? `Executed against tenant: ${tenantUrl}`
    : 'No active tenant — discovery only. Live API calls require set-active-tenant, and visible specs are bundled reference snapshots that may not exist on any tenant.'
  return `${marker}\n\n${text}`
}

export async function execute(functionCode: string): Promise<string> {
  const { resolved, namespaces, restrictions, allowRules } = resolveRuntime()

  // The docs index (topic/overview documentation only — no endpoints, so no
  // per-connection policy concerns) is cached per resolved-specs object; its
  // entries come from an unfiltered namespace list so the cache stays
  // policy-independent.
  const docsIndex = getDocsIndex(resolved, () =>
    buildNamespaces(resolved).map((ns) => ({ namespace: ns.name, spec: ns.spec })))
  // Same pattern for the method index: built from an unfiltered namespace
  // list (policy-independent, cached per tenant); the connection's policy is
  // applied at query time via the visible-targets predicate.
  const methodIndex = getMethodIndex(resolved, () => toSearchableMethods(buildNamespaces(resolved)))

  // In CLI mode discovery must keep working before a tenant is active (the
  // bundled-only fallback), so a missing tenant degrades the live-call
  // dispatchers instead of failing the whole run.
  let tenantUrl: string | null = null
  let live: LiveCalls
  try {
    const auth = await resolveC8yAuth()
    tenantUrl = auth.tenantUrl
    const safeFetch = createCumulocitySafeFetch(auth.tenantUrl, createC8yAuthHeaders(auth), restrictions, allowRules)
    live = createLiveCalls(safeFetch, auth.tenantUrl)
  } catch (error) {
    live = createUnauthenticatedCalls(error instanceof Error ? error.message : String(error))
  }

  const sandbox = await getSandbox()
  const result = await sandbox.run({
    code: ENTRY_SOURCE,
    filename: EXECUTE_ENTRY_PATH,
    limits: SANDBOX_LIMITS,
    imports: {
      [API_MODULE_SPECIFIER]: buildApiModule(namespaces, methodIndex, docsIndex, live),
      [AGENT_MODULE_SPECIFIER]: buildAgentModule(functionCode),
    },
  })

  if (!result.ok) {
    // User error or blocked-policy throw — surface the raw message so the
    // BLOCKED_REQUEST_PREFIX prefix stays intact for callers that branch on it.
    return withCliTenantMarker(result.error.message, tenantUrl)
  }

  return withCliTenantMarker(encode(extractDefaultExport(result.exports)), tenantUrl)
}
