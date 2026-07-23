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
import type { MethodIndex, SearchableMethod } from './method-search'
import { buildNamespaces, toSearchableMethods } from './namespaces'
import type { CodemodeNamespace, McpNamespace, OpenApiNamespace } from './namespaces'
import { buildSandboxApi, disposeAllSandboxSessions } from './sandbox'
import type { DocsSearchOptions } from './docs-index'
import { createC8yAuthHeaders, resolveC8yAuth } from '../utils/client'
import { McpHttpClient } from '../utils/mcp-client'
import { c8yMcpServer } from '../server-instance'
import { evaluateAccessPolicy } from '../utils/restriction-matcher'
import type { AllowRule, NoMcpConfig, RestrictionRule } from '../utils/restrictions'
import type { TenantCapabilities } from '../utils/capability-resolution'

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
  disposeAllSandboxSessions()
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
  // `sandbox` is opt-in: the host omits the key when the surface is disabled,
  // so agent code guards with `typeof sandbox !== "undefined"`.
  'if (__api.sandbox) globalThis.sandbox = __api.sandbox',
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
 * A live-call dispatcher; degraded to throwing stubs when no tenant is active.
 */
interface LiveCalls {
  operation: (namespace: OpenApiNamespace, opName: string, input: unknown) => Promise<unknown>
  mcpCall: (namespace: McpNamespace, toolName: string, args: unknown) => Promise<unknown>
  /**
   * Close any MCP sessions opened during the run. Never throws.
   */
  dispose: () => Promise<void>
}

function createLiveCalls(safeFetch: SafeFetchGlobal, tenantUrl: string, authHeaders: Record<string, string>): LiveCalls {
  // One MCP session per namespace per run, opened lazily on first use and
  // closed after the run — auth is the end user's, so sessions must not
  // outlive the connection context they were created for.
  const mcpClients = new Map<string, McpHttpClient>()
  const base = tenantUrl.endsWith('/') ? tenantUrl : `${tenantUrl}/`

  const mcpClientFor = (namespace: McpNamespace): McpHttpClient => {
    let client = mcpClients.get(namespace.name)
    if (!client) {
      client = new McpHttpClient({
        url: namespace.server.url,
        fetch: (path, init) => fetch(new URL(path.replace(/^\//, ''), base), {
          ...init,
          headers: {
            ...(init.headers as Record<string, string> | undefined),
            ...(namespace.server.sendAuthentication ? authHeaders : {}),
          },
        }),
      })
      mcpClients.set(namespace.name, client)
    }
    return client
  }

  return {
    operation: async (namespace, opName, input) => {
      const op = namespace.operations.find((o) => o.name === opName)!
      return performRequest(safeFetch, tenantUrl, toRequest(op, input))
    },
    mcpCall: async (namespace, toolName, args) => {
      return mcpClientFor(namespace).callTool(toolName, args)
    },
    dispose: async () => {
      await Promise.all([...mcpClients.values()].map((client) => client.close()))
      mcpClients.clear()
    },
  }
}

function createUnauthenticatedCalls(message: string): LiveCalls {
  const fail = async (): Promise<never> => {
    throw new Error(message)
  }
  return { operation: fail, mcpCall: fail, dispose: async () => {} }
}

function buildApiModule(
  namespaces: readonly CodemodeNamespace[],
  methodIndex: MethodIndex,
  docsIndex: ReturnType<typeof getDocsIndex>,
  live: LiveCalls,
  sandbox: HostModuleObject | undefined,
): HostModuleObject {
  const visibleTargets = new Set(namespaces.flatMap((ns) => ns.kind === 'openapi'
    ? ns.operations.map((op) => `${ns.name}.${op.name}`)
    : ns.tools.map((tool) => `${ns.name}.${tool.name}`)))

  const sandboxEnabled = sandbox !== undefined

  return {
    ...(sandbox ? { sandbox } : {}),
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
          return targets.map((t) => describeTarget(namespaces, methodIndex, t, sandboxEnabled))
        }
        return describeTarget(namespaces, methodIndex, target == null ? undefined : String(target), sandboxEnabled)
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
    // Namespaces are typed methods ONLY — no escape hatches, no marker of
    // whether a namespace wraps an OpenAPI spec or an MCP server. The
    // backing protocol is a host concern; the agent just calls methods.
    namespaces: Object.fromEntries(namespaces.map((namespace) => [
      namespace.name,
      namespace.kind === 'openapi'
        ? Object.fromEntries(namespace.operations.map((op) => [
            op.name,
            async (...args: unknown[]) => live.operation(namespace, op.name, args[0]),
          ]))
        : Object.fromEntries(namespace.tools.map((tool) => [
            tool.name,
            async (...args: unknown[]) => live.mcpCall(namespace, tool.toolName, args[0]),
          ])),
    ])),
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Runtime context resolution
// ─────────────────────────────────────────────────────────────────────────

interface CodemodeRuntime {
  resolved: TenantCapabilities
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
  const noMcp = custom?.noMcp
  return { resolved, restrictions, allowRules, namespaces: buildNamespaces(resolved, restrictions, allowRules, noMcp) }
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

  // Both views of every service exist per connection: MCP-preferred (default)
  // and the noMcp spec fallback. The cached, connection-independent artifacts
  // must cover the union so any connection's visible-targets predicate finds
  // its methods in the index.
  const SPEC_VIEW: NoMcpConfig = { all: true, contextPaths: new Set() }

  // The docs index (topic/overview documentation only — no endpoints, so no
  // per-connection policy concerns) is cached per resolved-specs object; its
  // entries come from the spec view so tag topics stay available regardless
  // of whether a service is wrapped as MCP (MCP tools carry no tag docs).
  const docsIndex = getDocsIndex(resolved, () =>
    buildNamespaces(resolved, [], [], SPEC_VIEW)
      .filter((ns): ns is OpenApiNamespace => ns.kind === 'openapi')
      .map((ns) => ({ namespace: ns.name, spec: ns.spec })))
  // Method index: union of the MCP-preferred and spec views (policy- and
  // opt-out-independent, cached per tenant); the connection's policy and
  // noMcp choice are applied at query time via the visible-targets predicate.
  const methodIndex = getMethodIndex(resolved, () => {
    const byTarget = new Map<string, SearchableMethod>()
    for (const item of [
      ...toSearchableMethods(buildNamespaces(resolved)),
      ...toSearchableMethods(buildNamespaces(resolved, [], [], SPEC_VIEW)),
    ]) {
      byTarget.set(item.target, item)
    }
    return [...byTarget.values()]
  })

  // In CLI mode discovery must keep working before a tenant is active (the
  // bundled-only fallback), so a missing tenant degrades the live-call
  // dispatchers instead of failing the whole run.
  let tenantUrl: string | null = null
  let live: LiveCalls
  try {
    const auth = await resolveC8yAuth()
    tenantUrl = auth.tenantUrl
    const authHeaders = createC8yAuthHeaders(auth)
    const safeFetch = createCumulocitySafeFetch(auth.tenantUrl, authHeaders, restrictions, allowRules)
    live = createLiveCalls(safeFetch, auth.tenantUrl, authHeaders)
  } catch (error) {
    live = createUnauthenticatedCalls(error instanceof Error ? error.message : String(error))
  }

  // Server-only scratch workspace, one in-memory sandbox per MCP session
  // (persists across codemode calls, idle-evicted). CLI mode never exposes it.
  const sessionId = c8yMcpServer.ctx.sessionId
  const sandboxApi = c8yMcpServer.ctx.custom?.env === 'server' && sessionId
    ? buildSandboxApi(sessionId)
    : undefined

  const sandbox = await getSandbox()
  const result = await sandbox.run({
    code: ENTRY_SOURCE,
    filename: EXECUTE_ENTRY_PATH,
    limits: SANDBOX_LIMITS,
    imports: {
      [API_MODULE_SPECIFIER]: buildApiModule(namespaces, methodIndex, docsIndex, live, sandboxApi),
      [AGENT_MODULE_SPECIFIER]: buildAgentModule(functionCode),
    },
  }).finally(() => live.dispose())

  if (!result.ok) {
    // User error or blocked-policy throw — surface the raw message so the
    // BLOCKED_REQUEST_PREFIX prefix stays intact for callers that branch on it.
    return withCliTenantMarker(result.error.message, tenantUrl)
  }

  return withCliTenantMarker(encode(extractDefaultExport(result.exports)), tenantUrl)
}
