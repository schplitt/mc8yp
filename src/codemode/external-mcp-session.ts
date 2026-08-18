import consola from 'consola'
import { McpHttpClient } from '../utils/mcp-client'
import { createExternalMcpFetch } from '../utils/external-mcp'
import type { McpToolDefinition } from '../utils/mcp-client'
import type { ExternalMcpServerConfig } from '../utils/external-mcp'

// ─────────────────────────────────────────────────────────────────────────
// Per-session tool lists for connection-supplied MCP servers.
//
// Tenant-discovered MCP servers get their tool list from the 30-minute
// discovery cache, so namespace assembly needs no round-trips. External servers
// arrive per connection (`mc8yp-mcp-server` header / `--mcp-server` flag) and
// have no discovery run behind them, so the handshake happens here: once per
// (session, server config), reused by every later codemode call in that
// session. Without this cache every codemode call would pay an
// initialize + tools/list round-trip per external server.
//
// Cache shape mirrors ./sandbox/index.ts deliberately — same session keying,
// same 15-minute idle TTL reset on use, same three eviction paths (idle timer,
// clean client DELETE via ../codemode/session-eviction.ts, process exit).
//
// The config itself is part of the cache key, so rotating a token or changing a
// URL mid-session re-handshakes instead of serving a stale tool list.
//
// Failures are NOT cached: a server that was unreachable on one call is retried
// on the next, and the failure is reported to the agent in the codemode
// overview rather than silently omitting the namespace.
// ─────────────────────────────────────────────────────────────────────────

const IDLE_TTL_MS = 15 * 60 * 1000

/**
 * Cache key for sessionless callers (CLI): one long-lived stdio process whose
 * external servers come from immutable startup flags.
 */
export const CLI_EXTERNAL_MCP_SESSION = 'cli'

/**
 * A connection-supplied MCP server with its tool list resolved.
 */
export interface ExternalMcpServer {
  config: ExternalMcpServerConfig
  tools: McpToolDefinition[]
  /**
   * `instructions` from the MCP handshake, used when the entry carries no
   * `description`.
   */
  instructions?: string
}

/**
 * An external server that could not be reached this run.
 */
export interface ExternalMcpFailure {
  name: string
  url: string
  reason: string
}

interface ExternalMcpSession {
  servers: Map<string, Promise<ExternalMcpServer>>
  timer?: ReturnType<typeof setTimeout>
}

const sessions = new Map<string, ExternalMcpSession>()

function configKey(config: ExternalMcpServerConfig): string {
  return JSON.stringify([config.name, config.url, config.token ?? '', config.headers ?? {}])
}

// Reset the idle clock: cached tool lists live 15 minutes past their last use.
function armIdleTimer(sessionKey: string): void {
  const session = sessions.get(sessionKey)
  if (!session)
    return
  if (session.timer)
    clearTimeout(session.timer)
  session.timer = setTimeout(() => evictExternalMcpSession(sessionKey, 'idle-timeout'), IDLE_TTL_MS)
  // Never let the eviction timer keep a process alive on its own.
  session.timer.unref?.()
}

async function listExternalTools(config: ExternalMcpServerConfig): Promise<ExternalMcpServer> {
  const client = new McpHttpClient({ url: config.url, fetch: createExternalMcpFetch(config) })
  try {
    const info = await client.initialize()
    const tools = await client.listTools()
    consola.info(`[external-mcp] "${config.name}" at ${config.url}: ${tools.length} tool(s)`)
    return { config, tools, instructions: info.instructions }
  } finally {
    await client.close()
  }
}

/**
 * Resolve every configured external MCP server for a session, using the cached
 * tool list where one exists. Servers whose handshake fails are reported in
 * `failures` and get no namespace — mirroring how a discovered service with a
 * failed spec download is skipped, except that these were explicitly requested
 * so the agent is told about them.
 * @param sessionKey MCP session id, or {@link CLI_EXTERNAL_MCP_SESSION} in CLI mode.
 * @param configs Parsed connection config.
 */
export async function resolveExternalMcpServers(
  sessionKey: string,
  configs: readonly ExternalMcpServerConfig[],
): Promise<{ servers: ExternalMcpServer[], failures: ExternalMcpFailure[] }> {
  if (configs.length === 0)
    return { servers: [], failures: [] }

  let session = sessions.get(sessionKey)
  if (!session) {
    session = { servers: new Map() }
    sessions.set(sessionKey, session)
  }
  armIdleTimer(sessionKey)

  type Settled = { ok: true, server: ExternalMcpServer } | { ok: false, failure: ExternalMcpFailure }

  const settled = await Promise.all(configs.map(async (config): Promise<Settled> => {
    const key = configKey(config)
    let pending = session!.servers.get(key)
    if (!pending) {
      pending = listExternalTools(config)
      session!.servers.set(key, pending)
      // A failed handshake must not stick: drop the entry so the next
      // codemode call retries it.
      pending.catch(() => {
        if (session!.servers.get(key) === pending)
          session!.servers.delete(key)
      })
    }
    try {
      return { ok: true, server: await pending }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      consola.warn(`[external-mcp] "${config.name}" at ${config.url} unavailable:`, reason)
      return { ok: false, failure: { name: config.name, url: config.url, reason } }
    }
  }))

  return {
    servers: settled.flatMap((r) => r.ok ? [r.server] : []),
    failures: settled.flatMap((r) => r.ok ? [] : [r.failure]),
  }
}

export type ExternalMcpEvictionReason = 'session-close' | 'idle-timeout' | 'shutdown'

/**
 * Drop a session's cached external tool lists and its timer.
 * @param sessionKey MCP session id (or the CLI key).
 * @param reason Why the entry is being dropped; included in the log line.
 */
export function evictExternalMcpSession(sessionKey: string, reason: ExternalMcpEvictionReason): void {
  const session = sessions.get(sessionKey)
  if (!session)
    return
  if (session.timer)
    clearTimeout(session.timer)
  sessions.delete(sessionKey)
  consola.info(`[external-mcp] dropped cached tool lists for session ${sessionKey} (reason: ${reason})`)
}

/**
 * Evict every session (process exit, test cleanup).
 */
export function disposeAllExternalMcpSessions(): void {
  for (const sessionKey of [...sessions.keys()])
    evictExternalMcpSession(sessionKey, 'shutdown')
}

/**
 * Live session count. Exported for tests (cache/eviction assertions).
 */
export function getExternalMcpSessionCount(): number {
  return sessions.size
}
