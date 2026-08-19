import { probeExternalMcpServer } from '../codemode/external-mcp-session'
import { RESERVED_NAMESPACES } from '../codemode/namespaces'
import { deriveExternalMcpNamespace, validateExternalMcpEntry } from './external-mcp'
import type { ExternalMcpServer } from '../codemode/external-mcp-session'
import type { ExternalMcpServerConfig } from './external-mcp'

// ─────────────────────────────────────────────────────────────────────────
// Configuration-time resolution for connection-supplied MCP servers.
//
// The `mc8yp-mcp-server` header is a RUNTIME contract: strict, verbatim, and
// fail-loud. That leaves whoever BUILDS that header — a tenant admin UI, a
// deployment script — with three questions it cannot answer on its own:
//
//   1. What namespace will this server be mounted under? Only mc8yp knows the
//      derivation (`sanitizeToolName`, the same one that turns `knowledge-base-ms`
//      into `knowledge_base_ms`).
//   2. Is that namespace even available? Reserved names are static, but the
//      TENANT namespaces depend on which applications are subscribed and on
//      mc8yp's own discovery cache. A collision there means the server is
//      silently skipped at assembly time (`buildNamespaces`) — the operator
//      believes the agent has a namespace it does not have.
//   3. Does the URL/credential combination actually work, and what tools does
//      the agent then see? mc8yp already speaks MCP with the exact auth
//      semantics these entries get (`token` → Bearer, then `headers` so an
//      explicit entry wins, tenant auth never forwarded). A caller probing on
//      its own reimplements that and drifts from it.
//
// So this module answers all three in one pass, and `POST /resolve-mcp-servers`
// is the transport. It reuses the header path's own validator rather than
// re-deriving the rules: a check that green-lights an entry the header then
// rejects would be worse than no check at all.
//
// What it deliberately does NOT do is change the runtime contract. A caller
// resolves a display name once, stores the `namespace` it got back, and keeps
// sending that verbatim — so the agent-visible namespace is stable even if this
// derivation is refined later.
// ─────────────────────────────────────────────────────────────────────────

/**
 * The single actionable field of a resolution: would this entry give the agent a
 * working namespace, and if not, whose fault is it?
 *
 * - `ok` — valid, namespace free, server answered.
 * - `invalid` — the entry itself is malformed (bad URL, non-string header value).
 *   Sending it in the header would 400 the whole request.
 * - `namespace-taken` — well-formed, but the namespace is already claimed. At
 *   runtime this server is SKIPPED, so the agent silently would not have it.
 * - `unreachable` — well-formed and free, but the handshake failed. mc8yp mounts
 *   nothing this run and reports it to the agent; it retries on the next call,
 *   so this may be transient.
 */
export type ExternalMcpResolutionStatus = 'ok' | 'invalid' | 'namespace-taken' | 'unreachable'

/**
 * Who holds the namespace an entry wanted.
 */
export type NamespaceHolder = 'reserved' | 'tenant' | 'request'

/**
 * One tool as an operator needs to see it — enough to judge, not a schema dump.
 */
export interface ResolvedExternalMcpTool {
  name: string
  description?: string
}

/**
 * The verdict for one candidate entry.
 */
export interface ExternalMcpResolution {
  /**
   * The `name` as supplied, echoed so a caller can match results to input.
   */
  name: string
  /**
   * The namespace this entry would be mounted under — derived from `name`. This
   * is the value to STORE and to send in the `mc8yp-mcp-server` header from now
   * on.
   */
  namespace: string
  status: ExternalMcpResolutionStatus
  /**
   * Why the status is not `ok`. Absent when it is.
   */
  reason?: string
  /**
   * Set when `status` is `namespace-taken`.
   */
  namespaceTakenBy?: NamespaceHolder
  /**
   * The downstream server's self-reported identity, when it answered.
   */
  server?: { name?: string, version?: string, instructions?: string }
  /**
   * The tools the agent would get. Present whenever the handshake succeeded —
   * including for a `namespace-taken` entry, because an operator renaming it
   * still wants to know the URL and credential are right.
   */
  tools?: ResolvedExternalMcpTool[]
}

export interface ResolveExternalMcpOptions {
  /**
   * Namespaces already in use on the tenant (core, one per available service).
   * `null` means the check could not run — no tenant namespace collision is
   * reported in that case, and callers must say so rather than imply the
   * namespace is free.
   */
  tenantNamespaces: readonly string[] | null
  /**
   * Injection seam for tests; defaults to a real, uncached handshake.
   */
  probe?: (config: ExternalMcpServerConfig) => Promise<ExternalMcpServer>
}

/**
 * Resolve a batch of candidate entries: derive each namespace, validate the
 * entry, classify namespace collisions, then handshake what is left.
 *
 * Entries are resolved as a BATCH because two of them can collide with each
 * other — the same reason `parseExternalMcpServers` threads `usedNames` through
 * its loop. Order matters exactly as it does in the header: the first entry to
 * claim a namespace keeps it, later ones are `namespace-taken` by `request`.
 * @param candidates Raw entries, shaped like the header's JSON objects but with `name` free-form.
 * @param options Tenant namespaces to check against, plus the probe seam.
 */
export async function resolveExternalMcpCandidates(
  candidates: readonly unknown[],
  options: ResolveExternalMcpOptions,
): Promise<ExternalMcpResolution[]> {
  const { tenantNamespaces, probe = probeExternalMcpServer } = options
  const tenantHeld = new Set(tenantNamespaces ?? [])
  const claimed = new Set<string>()

  // Pass 1 is sequential and synchronous: namespace claims are order-dependent,
  // so they cannot be decided inside the concurrent probe pass below.
  type Planned
    = | { resolution: ExternalMcpResolution }
      | { resolution: ExternalMcpResolution, config: ExternalMcpServerConfig }

  const planned: Planned[] = candidates.map((candidate) => {
    const rawName = typeof (candidate as { name?: unknown })?.name === 'string'
      ? (candidate as { name: string }).name
      : ''
    // An empty/absent name derives to nothing rather than to sanitizeToolName's
    // `_` placeholder: the validator's own "name is required" message is the
    // useful answer, and reporting a namespace of `_` would invite a caller to
    // store it.
    const namespace = rawName ? deriveExternalMcpNamespace(rawName) : ''

    // Validate with the DERIVED name in place, so the only failures reported are
    // ones a caller can act on — a display name that needed sanitizing is not
    // one of them. A candidate that is not an object at all is handed over
    // untouched, so the validator can say exactly that.
    const isObject = typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate)
    const validated = validateExternalMcpEntry(
      isObject ? { ...candidate, name: namespace } : candidate,
      claimed,
    )
    if ('reason' in validated) {
      // A duplicate/reserved name comes back from the validator as a reason
      // string; report those as the collision they are, not as a malformed entry.
      const holder: NamespaceHolder | undefined = RESERVED_NAMESPACES.has(namespace)
        ? 'reserved'
        : claimed.has(namespace)
          ? 'request'
          : undefined
      return {
        resolution: {
          name: rawName,
          namespace,
          status: holder ? 'namespace-taken' : 'invalid',
          reason: validated.reason,
          ...(holder ? { namespaceTakenBy: holder } : {}),
        },
      }
    }

    claimed.add(namespace)

    // Tenant namespaces win: `buildNamespaces` appends external servers last and
    // skips a name a tenant namespace already holds. Report that here rather
    // than letting it become a silent absence at run time.
    if (tenantHeld.has(namespace)) {
      return {
        resolution: {
          name: rawName,
          namespace,
          status: 'namespace-taken',
          namespaceTakenBy: 'tenant',
          reason: `Namespace "${namespace}" is already used by this tenant — a tenant namespace always wins, so this server would be skipped. Rename it.`,
        },
        config: validated.config,
      }
    }

    return { resolution: { name: rawName, namespace, status: 'ok' }, config: validated.config }
  })

  // Pass 2: handshake everything that is well-formed, concurrently. A
  // `namespace-taken` entry is probed too — an operator fixing the name wants to
  // know in the same round trip whether the URL and credential are right.
  return Promise.all(planned.map(async (entry) => {
    if (!('config' in entry))
      return entry.resolution

    try {
      const probed = await probe(entry.config)
      return {
        ...entry.resolution,
        server: {
          ...(probed.serverName ? { name: probed.serverName } : {}),
          ...(probed.serverVersion ? { version: probed.serverVersion } : {}),
          ...(probed.instructions ? { instructions: probed.instructions } : {}),
        },
        tools: probed.tools.map((tool) => ({
          name: tool.name,
          ...(tool.description ?? tool.title ? { description: tool.description ?? tool.title } : {}),
        })),
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      // A taken namespace is the more actionable failure of the two, so it keeps
      // the status; the handshake failure is appended to the reason.
      return entry.resolution.status === 'namespace-taken'
        ? { ...entry.resolution, reason: `${entry.resolution.reason} (it also did not answer: ${reason})` }
        : { ...entry.resolution, status: 'unreachable' as const, reason }
    }
  }))
}
