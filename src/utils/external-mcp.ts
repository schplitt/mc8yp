import { RESERVED_NAMESPACES } from '../codemode/namespaces'
import type { McpFetch } from './mcp-client'

// ─────────────────────────────────────────────────────────────────────────
// Connection-supplied external MCP servers.
//
// Unlike the MCP servers found by tenant discovery (`exposeMcpServers` in a
// microservice manifest, tenant-relative URL, tenant auth), these are declared
// by whoever opens the MCP connection: one `mc8yp-mcp-server` header per
// server (or a JSON array in a single header), carrying an ABSOLUTE url plus
// its own optional credentials. They become codemode namespaces exactly like
// discovered servers do, scoped to that connection/session only.
//
// Header-only on purpose (plus the CLI's `--mcp-server` flag): the value can
// carry a bearer token, and query strings end up in access logs, proxy traces,
// and browser history in a way headers do not. There is deliberately no
// `?mcpServer=` query equivalent even though every other connection option has
// one.
//
// Egress: the URL is used as given — any host, http or https, no allowlist and
// no private-range blocking. The header is part of the connection's trusted
// configuration (same trust level as the restriction/allow headers) and the
// sandbox cannot set it. Note the consequence: whoever can set headers on the
// deployed microservice can make it issue requests to any address it can
// reach, including tenant-internal ones. Front the deployment accordingly.
//
// Tenant auth is NEVER forwarded to these servers — only the credentials given
// in the entry itself. A tenant Authorization header must not leak to a
// third-party host.
// ─────────────────────────────────────────────────────────────────────────

export const EXTERNAL_MCP_HEADER = 'mc8yp-mcp-server'

/**
 * One connection-supplied MCP server.
 */
export interface ExternalMcpServerConfig {
  /**
   * Sandbox namespace name. Used verbatim (validated as a JS identifier), so
   * the agent-visible global is exactly what was configured.
   */
  name: string
  /**
   * Absolute MCP endpoint URL, used as given.
   */
  url: string
  /**
   * Shorthand credential: sent as `Authorization: Bearer <token>`.
   */
  token?: string
  /**
   * Extra request headers, applied after `token` so an explicit
   * `authorization` entry can replace the bearer shorthand.
   */
  headers?: Record<string, string>
  /**
   * Shown in the codemode namespace overview. Falls back to the server's own
   * `instructions` from the MCP handshake.
   */
  description?: string
}

export interface InvalidExternalMcpEntry {
  entry: string
  reason: string
}

export interface ExternalMcpParseResult {
  servers: ExternalMcpServerConfig[]
  failedEntries: InvalidExternalMcpEntry[]
}

const NAMESPACE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Collect raw `mc8yp-mcp-server` header values. Repeated headers arrive joined
 * by `, ` per RFC 9110, which would corrupt JSON, so `Headers.getSetCookie`-style
 * splitting is not possible — callers send one header per server and the
 * combined value is split back apart on `}` / `{` boundaries below.
 * @param headers Incoming request headers.
 */
export function collectServerExternalMcpSources(headers: Headers): string[] {
  const value = headers.get(EXTERNAL_MCP_HEADER)
  if (!value)
    return []
  return splitJsonEntries(value)
}

/**
 * Split a possibly-joined header value into individual JSON documents.
 * A single object, a JSON array, and several objects joined by the comma the
 * HTTP layer inserts for repeated headers all reduce to a list of JSON texts.
 * Splitting tracks string/escape state so a comma inside a token or URL never
 * becomes a boundary.
 * @param value Raw header value.
 */
function splitJsonEntries(value: string): string[] {
  const entries: string[] = []
  let depth = 0
  let inString = false
  let escaped = false
  let start = -1

  for (let i = 0; i < value.length; i++) {
    const char = value[i]!
    if (start === -1) {
      if (char === '{' || char === '[') {
        start = i
        depth = 1
      }
      continue
    }
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (char === '"') {
      inString = !inString
      continue
    }
    if (inString)
      continue
    if (char === '{' || char === '[') {
      depth++
    } else if (char === '}' || char === ']') {
      depth--
      if (depth === 0) {
        entries.push(value.slice(start, i + 1))
        start = -1
      }
    }
  }

  // Unterminated remainder: keep it so JSON.parse reports the real problem.
  if (start !== -1)
    entries.push(value.slice(start))
  // No JSON structure at all (e.g. a bare word): surface it as one bad entry.
  if (entries.length === 0 && value.trim() !== '')
    entries.push(value.trim())
  return entries
}

/**
 * Parse external MCP server entries from header values or CLI flags. Every
 * entry is a JSON object `{ name, url, token?, headers?, description? }`, or a
 * JSON array of them.
 *
 * Validation is strict and fail-loud rather than skip-and-continue: a
 * malformed entry means the operator intended a server the agent would
 * otherwise silently not have, so callers turn `failedEntries` into a 400
 * (server mode) or a startup error (CLI).
 * @param sources Raw JSON texts, one per entry.
 */
export function parseExternalMcpServers(sources: readonly string[]): ExternalMcpParseResult {
  const servers: ExternalMcpServerConfig[] = []
  const failedEntries: InvalidExternalMcpEntry[] = []
  const usedNames = new Set<string>()

  for (const source of sources) {
    let parsed: unknown
    try {
      parsed = JSON.parse(source)
    } catch (err) {
      failedEntries.push({
        entry: source,
        reason: `Not valid JSON (${err instanceof Error ? err.message : String(err)}). Expected {"name":"…","url":"https://…","token":"…"}.`,
      })
      continue
    }

    for (const candidate of Array.isArray(parsed) ? parsed : [parsed]) {
      const result = validateEntry(candidate, usedNames)
      if ('reason' in result) {
        failedEntries.push({ entry: typeof candidate === 'object' ? JSON.stringify(candidate) : String(candidate), reason: result.reason })
        continue
      }
      usedNames.add(result.config.name)
      servers.push(result.config)
    }
  }

  return { servers, failedEntries }
}

function validateEntry(candidate: unknown, usedNames: ReadonlySet<string>): { config: ExternalMcpServerConfig } | { reason: string } {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate))
    return { reason: 'Entry must be a JSON object with "name" and "url".' }

  const entry = candidate as Record<string, unknown>

  if (typeof entry.name !== 'string' || entry.name === '')
    return { reason: '"name" is required and must be a non-empty string — it becomes the sandbox namespace.' }
  if (!NAMESPACE_PATTERN.test(entry.name))
    return { reason: `"name" must be a valid JavaScript identifier (letters, digits, underscore; not starting with a digit), got "${entry.name}".` }
  if (RESERVED_NAMESPACES.has(entry.name))
    return { reason: `"name" must not be a reserved namespace (${[...RESERVED_NAMESPACES].join(', ')}), got "${entry.name}".` }
  if (usedNames.has(entry.name))
    return { reason: `Duplicate namespace "${entry.name}" — each external MCP server needs its own name.` }

  if (typeof entry.url !== 'string' || entry.url === '')
    return { reason: `"url" is required and must be a non-empty string (server "${entry.name}").` }
  let url: URL
  try {
    url = new URL(entry.url)
  } catch {
    return { reason: `"url" must be an absolute URL, got "${entry.url}" (server "${entry.name}").` }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return { reason: `"url" must use http or https, got "${url.protocol}" (server "${entry.name}").` }

  if (entry.token !== undefined && (typeof entry.token !== 'string' || entry.token === ''))
    return { reason: `"token" must be a non-empty string when present (server "${entry.name}").` }
  if (entry.description !== undefined && typeof entry.description !== 'string')
    return { reason: `"description" must be a string when present (server "${entry.name}").` }

  let headers: Record<string, string> | undefined
  if (entry.headers !== undefined) {
    if (typeof entry.headers !== 'object' || entry.headers === null || Array.isArray(entry.headers))
      return { reason: `"headers" must be an object of string values when present (server "${entry.name}").` }
    headers = {}
    for (const [key, value] of Object.entries(entry.headers as Record<string, unknown>)) {
      if (typeof value !== 'string')
        return { reason: `"headers.${key}" must be a string (server "${entry.name}").` }
      headers[key] = value
    }
  }

  return {
    config: {
      name: entry.name,
      url: entry.url,
      ...(typeof entry.token === 'string' ? { token: entry.token } : {}),
      ...(headers ? { headers } : {}),
      ...(typeof entry.description === 'string' ? { description: entry.description } : {}),
    },
  }
}

/**
 * Request headers for one external server: the `token` bearer shorthand,
 * then the explicit `headers` map so it can override.
 * @param config External server config.
 */
export function externalMcpHeaders(config: ExternalMcpServerConfig): Record<string, string> {
  return {
    ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
    ...config.headers,
  }
}

/**
 * Transport for an external MCP server: plain `fetch` against the absolute
 * URL with the entry's own credentials attached. No tenant auth, no safeFetch
 * host pinning — the target is an arbitrary operator-chosen host, not the
 * tenant.
 * @param config External server config.
 */
export function createExternalMcpFetch(config: ExternalMcpServerConfig): McpFetch {
  const authHeaders = externalMcpHeaders(config)
  return (url, init) => fetch(url, {
    ...init,
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      ...authHeaders,
    },
  })
}
