import consola from 'consola'

// ─────────────────────────────────────────────────────────────────────────
// Minimal MCP client over streamable HTTP — tools only.
//
// Deliberately hand-rolled instead of pulling in an SDK: mc8yp needs exactly
// initialize → tools/list → tools/call against Cumulocity-hosted MCP
// microservices, POST-only JSON-RPC with session-id handling and SSE-framed
// response parsing. No elicitation, no sampling, no roots — the client
// advertises an EMPTY capability set, so spec-compliant servers never send
// server→client requests. If one arrives anyway it is declined with an
// explicit error response so the downstream server fails fast instead of
// hanging.
//
// Transport injection: callers provide the fetch implementation, which is
// where auth and base-URL policy live (discovery passes the @c8y/client
// fetcher, the codemode runtime passes a tenant-bound fetch with the end
// user's Authorization header).
// ─────────────────────────────────────────────────────────────────────────

export const MCP_PROTOCOL_VERSION = '2025-06-18'

const REQUEST_TIMEOUT_MS = 30_000

/**
 * Tool definition as returned by `tools/list`.
 */
export interface McpToolDefinition {
  name: string
  title?: string
  description?: string
  inputSchema?: Record<string, unknown>
  outputSchema?: Record<string, unknown>
}

export interface McpInitializeInfo {
  serverName?: string
  serverVersion?: string
  instructions?: string
}

interface JsonRpcMessage {
  jsonrpc: '2.0'
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number, message: string, data?: unknown }
}

export type McpFetch = (path: string, init: globalThis.RequestInit) => Promise<Response>

export interface McpClientOptions {
  /**
   * Path or URL of the MCP endpoint, passed verbatim to `fetch`.
   */
  url: string
  /**
   * Transport with auth/base-URL policy baked in.
   */
  fetch: McpFetch
  /**
   * Per-request timeout. Defaults to 30 s.
   */
  timeoutMs?: number
}

export class McpHttpClient {
  #url: string
  #fetch: McpFetch
  #timeoutMs: number
  #sessionId: string | undefined
  #nextId = 1
  #initialized: Promise<McpInitializeInfo> | undefined

  constructor(options: McpClientOptions) {
    this.#url = options.url
    this.#fetch = options.fetch
    this.#timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS
  }

  /**
   * Initialize the session (idempotent — concurrent callers share one
   * handshake). Advertises no client capabilities: no elicitation, no
   * sampling, no roots.
   */
  initialize(): Promise<McpInitializeInfo> {
    this.#initialized ??= this.#doInitialize()
    return this.#initialized
  }

  async #doInitialize(): Promise<McpInitializeInfo> {
    const result = await this.#request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'mc8yp', version: '0.0.0' },
    }) as { serverInfo?: { name?: string, version?: string }, instructions?: string } | undefined
    await this.#notify('notifications/initialized')
    return {
      serverName: result?.serverInfo?.name,
      serverVersion: result?.serverInfo?.version,
      instructions: result?.instructions,
    }
  }

  /**
   * List every tool, following pagination cursors.
   */
  async listTools(): Promise<McpToolDefinition[]> {
    await this.initialize()
    const tools: McpToolDefinition[] = []
    let cursor: string | undefined
    do {
      const result = await this.#request('tools/list', cursor ? { cursor } : {}) as {
        tools?: McpToolDefinition[]
        nextCursor?: string
      } | undefined
      tools.push(...(result?.tools ?? []))
      cursor = result?.nextCursor
    } while (cursor)
    return tools
  }

  /**
   * Call a tool and unwrap the result: structured content when present,
   * otherwise joined text content (JSON-parsed when possible). `isError`
   * results throw with the server's message.
   * @param name
   * @param args
   */
  async callTool(name: string, args: unknown): Promise<unknown> {
    await this.initialize()
    const result = await this.#request('tools/call', {
      name,
      arguments: args && typeof args === 'object' ? args : {},
    }) as {
      content?: Array<{ type: string, text?: string }>
      structuredContent?: unknown
      isError?: boolean
    } | undefined

    if (!result || typeof result !== 'object')
      return result
    if (result.isError) {
      const message = (result.content ?? [])
        .filter((c) => c.type === 'text')
        .map((c) => c.text ?? '')
        .join('\n') || `MCP tool "${name}" failed`
      throw new Error(message)
    }
    if (result.structuredContent != null)
      return result.structuredContent
    const content = result.content ?? []
    if (content.length === 0 || !content.every((c) => c.type === 'text'))
      return result
    const text = content.map((c) => c.text ?? '').join('\n')
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }

  /**
   * Best-effort session teardown. Never throws.
   */
  async close(): Promise<void> {
    if (!this.#sessionId)
      return
    try {
      await this.#fetch(this.#url, {
        method: 'DELETE',
        headers: { 'mcp-session-id': this.#sessionId },
      })
    } catch { /* session cleanup is best-effort */ }
    this.#sessionId = undefined
    this.#initialized = undefined
  }

  async #notify(method: string): Promise<void> {
    await this.#post({ jsonrpc: '2.0', method })
  }

  async #request(method: string, params: unknown): Promise<unknown> {
    const id = this.#nextId++
    const response = await this.#post({ jsonrpc: '2.0', id, method, params })
    const message = await this.#readResponse(response, id)
    if (message.error)
      throw new Error(`MCP ${method} failed: ${message.error.message}`)
    return message.result
  }

  async #post(payload: JsonRpcMessage): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs)
    try {
      const response = await this.#fetch(this.#url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'accept': 'application/json, text/event-stream',
          ...(this.#sessionId ? { 'mcp-session-id': this.#sessionId } : {}),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
      this.#sessionId ??= response.headers.get('mcp-session-id') ?? undefined
      if (!response.ok && response.status !== 202) {
        throw new Error(`MCP endpoint responded with ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`)
      }
      return response
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Read the JSON-RPC response for `id` from a plain-JSON or SSE-framed
   * response body. Server→client requests encountered on the stream are
   * declined immediately (fire-and-forget error response) — mc8yp does not
   * forward elicitation or sampling.
   * @param response
   * @param id
   */
  async #readResponse(response: Response, id: number): Promise<JsonRpcMessage> {
    const contentType = response.headers.get('content-type') ?? ''
    const text = await response.text()

    const messages: JsonRpcMessage[] = contentType.includes('text/event-stream')
      ? text
          .split(/\n\n/)
          .flatMap((event) => event.split('\n').filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)))
          .filter(Boolean)
          .map((data) => JSON.parse(data) as JsonRpcMessage)
      : text.trim()
        ? [JSON.parse(text) as JsonRpcMessage]
        : []

    for (const message of messages) {
      // A server-initiated request (has method AND id) — decline it.
      if (message.method && message.id !== undefined) {
        this.#declineServerRequest(message).catch(() => undefined)
        continue
      }
      if (message.id === id)
        return message
    }
    throw new Error(`MCP endpoint returned no response for request ${id}`)
  }

  async #declineServerRequest(request: JsonRpcMessage): Promise<void> {
    consola.warn(`[mcp-client] declining server-initiated request "${request.method}" — mc8yp does not forward elicitation or sampling.`)
    try {
      await this.#post({
        jsonrpc: '2.0',
        id: request.id,
        error: {
          code: -32601,
          message: `mc8yp does not forward ${request.method === 'elicitation/create' ? 'elicitation' : request.method === 'sampling/createMessage' ? 'sampling' : 'server-initiated'} requests. The tool cannot interact with the user through this connection.`,
        },
      } as JsonRpcMessage)
    } catch { /* decline is best-effort */ }
  }
}
