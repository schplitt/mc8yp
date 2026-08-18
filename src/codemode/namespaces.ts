import consola from 'consola'
import { deriveOperations } from './derive-operations'
import { sanitizeToolName } from './operation-naming'
import { evaluateAccessPolicy } from '../utils/restriction-matcher'
import type { DerivedOperation } from './derive-operations'
import type { JsonSchema } from './type-render'
import type { SearchableMethod } from './method-search'
import type { DiscoveredMcpServer } from '../utils/capability-discovery'
import type { TenantCapabilities, Spec } from '../utils/capability-resolution'
import type { AllowRule, NoMcpConfig, RestrictionRule } from '../utils/restrictions'
import type { ExternalMcpServer } from './external-mcp-session'
import type { ExternalMcpServerConfig } from '../utils/external-mcp'

// ─────────────────────────────────────────────────────────────────────────
// Namespace assembly — the per-connection view over derived operations,
// discovered MCP servers, and connection-supplied external MCP servers.
//
// Derivation (deriveOperations) is cached and policy-independent; THIS is the
// layer that applies the connection's restriction/allow rules and the
// `noMcp` opt-out. Blocked operations never appear in namespaces, search
// results, or describe output. The prefer-MCP rule lives here too: a service
// that exposes an MCP server is wrapped as an MCP namespace and its OpenAPI
// spec is skipped, unless the connection opted that service out — then the
// spec is the fallback.
//
// External MCP servers (from the connection's own config, not from the tenant)
// are appended last and cannot displace a tenant namespace: on a name
// collision the external entry is skipped, so a header can never shadow a real
// service. `noMcp` does not apply to them — it selects between a service's MCP
// and OpenAPI views, and an external server has no spec view to fall back to.
//
// Path-based restriction/allow rules do NOT apply to MCP tools — they have
// no METHOD:path identity. This is a documented gap, not an oversight.
// ─────────────────────────────────────────────────────────────────────────

/**
 * The core spec's sandbox namespace.
 */
export const CORE_NAMESPACE = 'c8y'

/**
 * Namespaces that can never be taken by a discovered service contextPath.
 * `codemode`/`docs` are the platform SDK, `sandbox` is the (opt-in) scratch
 * compute surface, `c8y` is core, and `cumulocity` is reserved so a service
 * cannot impersonate the historical request global.
 */
export const RESERVED_NAMESPACES = new Set(['codemode', 'docs', 'sandbox', 'c8y', 'cumulocity'])

/**
 * One wrapped MCP tool: the sandbox method name plus the raw wire name.
 */
export interface McpNamespaceTool {
  /**
   * Sandbox method name (sanitized MCP tool name).
   */
  name: string
  /**
   * Raw MCP tool name used in `tools/call`.
   */
  toolName: string
  description?: string
  inputSchema: JsonSchema
  outputSchema?: JsonSchema
}

interface NamespaceBase {
  /**
   * Sandbox global name, e.g. `c8y` or `dtm`.
   */
  name: string
  /**
   * Key in the resolved specs: `core` or a service contextPath.
   */
  specKey: string
}

export interface OpenApiNamespace extends NamespaceBase {
  kind: 'openapi'
  /**
   * The spec object the operations were derived from.
   */
  spec: Spec
  /**
   * Policy-filtered operations visible to this connection.
   */
  operations: DerivedOperation[]
}

export interface McpNamespace extends NamespaceBase {
  kind: 'mcp'
  server: DiscoveredMcpServer
  tools: McpNamespaceTool[]
  /**
   * Set when the namespace comes from the connection's own config rather than
   * tenant discovery. Dispatch reads it to call the absolute URL with the
   * entry's own credentials instead of the tenant transport.
   */
  external?: ExternalMcpServerConfig
}

export type CodemodeNamespace = OpenApiNamespace | McpNamespace

function buildMcpTools(server: DiscoveredMcpServer): McpNamespaceTool[] {
  const tools: McpNamespaceTool[] = []
  const used = new Set<string>()
  for (const tool of server.tools) {
    const name = sanitizeToolName(tool.name)
    if (used.has(name)) {
      consola.warn(`[codemode] MCP tool "${tool.name}" on "${server.contextPath}" maps to the already-used method name "${name}" — skipping.`)
      continue
    }
    used.add(name)
    tools.push({
      name,
      toolName: tool.name,
      description: tool.description ?? tool.title,
      inputSchema: (tool.inputSchema ?? { type: 'object' }) as JsonSchema,
      outputSchema: tool.outputSchema as JsonSchema | undefined,
    })
  }
  return tools
}

/**
 * Per-connection inputs to namespace assembly. An options object rather than
 * positional parameters because the connection view is assembled from four
 * independent knobs and call sites routinely set only one of them.
 */
export interface BuildNamespacesOptions {
  restrictions?: readonly RestrictionRule[]
  allowRules?: readonly AllowRule[]
  /**
   * Per-connection MCP-wrapping opt-out (tenant services only).
   */
  noMcp?: NoMcpConfig
  /**
   * Connection-supplied MCP servers with tool lists already resolved.
   */
  externalServers?: readonly ExternalMcpServer[]
}

/**
 * Build the per-connection namespace list: core as `c8y`, one namespace per
 * available service, then one per connection-supplied external MCP server. A
 * service exposing an MCP server becomes an MCP namespace (its spec is skipped)
 * unless opted out via `noMcp` — then its spec is used as the fallback.
 * Operations blocked by the connection policy are omitted from OpenAPI
 * namespaces; path templates are matched as-is.
 * @param resolved
 * @param options Per-connection policy, opt-outs, and external servers.
 */
export function buildNamespaces(
  resolved: TenantCapabilities,
  options: BuildNamespacesOptions = {},
): CodemodeNamespace[] {
  const { restrictions = [], allowRules = [], noMcp, externalServers = [] } = options

  const visibleOperations = (spec: Spec): DerivedOperation[] =>
    deriveOperations(spec).filter((op) => !evaluateAccessPolicy(restrictions, allowRules, op.method, op.path).blocked)

  const namespaces: CodemodeNamespace[] = [
    { kind: 'openapi', name: CORE_NAMESPACE, specKey: 'core', spec: resolved.core, operations: visibleOperations(resolved.core) },
  ]
  const used = new Set([CORE_NAMESPACE])

  // Defensive default: contexts resolved before the MCP feature (or seeded
  // in tests) may not carry the map.
  const mcpServers = resolved.mcpServers ?? {}
  const contextPaths = new Set([...Object.keys(resolved.specs), ...Object.keys(mcpServers)])
  for (const contextPath of contextPaths) {
    const name = sanitizeToolName(contextPath)
    if (RESERVED_NAMESPACES.has(name) || used.has(name)) {
      consola.warn(
        `[codemode] service "${contextPath}" maps to namespace "${name}", which is `
        + `${RESERVED_NAMESPACES.has(name) ? 'reserved' : 'already used'} — skipping this service.`,
      )
      continue
    }

    const mcpServer = mcpServers[contextPath]
    const optedOut = noMcp !== undefined && (noMcp.all || noMcp.contextPaths.has(contextPath))
    if (mcpServer && !optedOut) {
      used.add(name)
      namespaces.push({ kind: 'mcp', name, specKey: contextPath, server: mcpServer, tools: buildMcpTools(mcpServer) })
      continue
    }

    const spec = resolved.specs[contextPath]
    if (spec) {
      used.add(name)
      namespaces.push({ kind: 'openapi', name, specKey: contextPath, spec, operations: visibleOperations(spec) })
    }
    // MCP opted out and no spec fallback → the service gets no namespace.
  }

  // Connection-supplied servers last: the tenant's own surface wins any name
  // collision, so a header cannot shadow a real service namespace.
  for (const external of externalServers) {
    const name = external.config.name
    if (RESERVED_NAMESPACES.has(name) || used.has(name)) {
      consola.warn(
        `[codemode] external MCP server "${name}" (${external.config.url}) maps to a namespace that is `
        + `${RESERVED_NAMESPACES.has(name) ? 'reserved' : 'already used by this tenant'} — skipping this server.`,
      )
      continue
    }
    used.add(name)
    // Shaped as a DiscoveredMcpServer so describe/search treat external and
    // tenant MCP namespaces identically. sendAuthentication is always false:
    // tenant auth must never reach a connection-supplied host.
    const server: DiscoveredMcpServer = {
      contextPath: name,
      appLabel: name,
      mcpName: name,
      description: external.config.description ?? external.instructions,
      url: external.config.url,
      sendAuthentication: false,
      tools: external.tools,
    }
    namespaces.push({ kind: 'mcp', name, specKey: name, external: external.config, server, tools: buildMcpTools(server) })
  }

  return namespaces
}

/**
 * Flatten namespaces into the method-search item list. The backing protocol
 * is deliberately NOT exposed — the agent sees uniform methods; entries
 * without a REST identity simply omit httpMethod/apiPath.
 * @param namespaces
 */
export function toSearchableMethods(namespaces: readonly CodemodeNamespace[]): SearchableMethod[] {
  return namespaces.flatMap((ns): SearchableMethod[] => ns.kind === 'openapi'
    ? ns.operations.map((op) => ({
        target: `${ns.name}.${op.name}`,
        namespace: ns.name,
        method: op.name,
        httpMethod: op.method,
        apiPath: op.path,
        summary: op.summary,
      }))
    : ns.tools.map((tool) => ({
        target: `${ns.name}.${tool.name}`,
        namespace: ns.name,
        method: tool.name,
        summary: firstLine(tool.description),
      })))
}

function firstLine(text: string | undefined): string | undefined {
  if (!text)
    return undefined
  const line = text.split('\n', 1)[0]!.trim()
  return line.length > 140 ? `${line.slice(0, 140)}…` : line
}
