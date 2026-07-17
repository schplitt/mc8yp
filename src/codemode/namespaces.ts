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

// ─────────────────────────────────────────────────────────────────────────
// Namespace assembly — the per-connection view over derived operations and
// discovered MCP servers.
//
// Derivation (deriveOperations) is cached and policy-independent; THIS is the
// layer that applies the connection's restriction/allow rules and the
// `noMcp` opt-out. Blocked operations never appear in namespaces, search
// results, or describe output. The prefer-MCP rule lives here too: a service
// that exposes an MCP server is wrapped as an MCP namespace and its OpenAPI
// spec is skipped, unless the connection opted that service out — then the
// spec is the fallback.
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
 * `codemode`/`docs` are the platform SDK, `c8y` is core, and `cumulocity` is
 * reserved so a service cannot impersonate the historical request global.
 */
export const RESERVED_NAMESPACES = new Set(['codemode', 'docs', 'c8y', 'cumulocity'])

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
 * Build the per-connection namespace list: core as `c8y` plus one namespace
 * per available service. A service exposing an MCP server becomes an MCP
 * namespace (its spec is skipped) unless opted out via `noMcp` — then its
 * spec is used as the fallback. Operations blocked by the connection policy
 * are omitted from OpenAPI namespaces; path templates are matched as-is.
 * @param resolved
 * @param restrictions
 * @param allowRules
 * @param noMcp Per-connection MCP-wrapping opt-out.
 */
export function buildNamespaces(
  resolved: TenantCapabilities,
  restrictions: readonly RestrictionRule[] = [],
  allowRules: readonly AllowRule[] = [],
  noMcp?: NoMcpConfig,
): CodemodeNamespace[] {
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
