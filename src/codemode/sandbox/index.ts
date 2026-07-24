import consola from 'consola'
import { createJustBashAdapter } from './just-bash-adapter'
import type { HostModuleObject } from '@iso4/sandbox'
import type { SandboxAdapter, SandboxExecOptions } from './types'

export type { SandboxAdapter } from './types'

// ─────────────────────────────────────────────────────────────────────────
// Sandbox lifecycle + the `sandbox` host-module leaf.
//
// SERVER MODE ONLY. The `sandbox` global is a scratch workspace (in-memory
// filesystem + shell) offered to deployed microservice sessions. CLI mode does
// NOT expose it — local agent harnesses bring their own file I/O.
//
// One in-memory sandbox per MCP session, keyed by `ctx.sessionId`, so files
// persist across codemode calls within a session. Nothing touches disk.
// Eviction (each path logs the session id and reason):
//   • idle TTL — a per-session 15-minute timer, reset on every use. This is the
//     guarantee: sessions that go quiet (including ones whose client never
//     sends a clean DELETE) are dropped 15 minutes after their last call.
//   • clean close — the transport's session manager wrapper
//     (./session-eviction.ts) evicts immediately on client DELETE /mcp.
//   • process exit — disposeAllSandboxSessions() clears everything.
//
// Two type layers, on purpose:
//   • SandboxAdapter (./types) — the swappable backend contract (Flue shape).
//   • HostModuleObject (@iso4/sandbox) — the bridge-stub shape the runtime needs.
// ─────────────────────────────────────────────────────────────────────────

const IDLE_TTL_MS = 15 * 60 * 1000

interface SandboxSession {
  adapter: SandboxAdapter
  timer?: ReturnType<typeof setTimeout>
}

const sessions = new Map<string, SandboxSession>()

// Reset the idle clock: the sandbox lives 15 minutes past its last use.
function armIdleTimer(sessionId: string): void {
  const session = sessions.get(sessionId)
  if (!session)
    return
  if (session.timer)
    clearTimeout(session.timer)
  session.timer = setTimeout(() => evictSandboxSession(sessionId, 'idle-timeout'), IDLE_TTL_MS)
  // Never let the eviction timer keep a process alive on its own.
  session.timer.unref?.()
}

function getSessionAdapter(sessionId: string): SandboxAdapter {
  let session = sessions.get(sessionId)
  if (!session) {
    session = { adapter: createJustBashAdapter() }
    sessions.set(sessionId, session)
  }
  armIdleTimer(sessionId)
  return session.adapter
}

function resetSessionAdapter(sessionId: string): void {
  const session = sessions.get(sessionId)
  session?.adapter.dispose?.()
  if (session)
    session.adapter = createJustBashAdapter()
  armIdleTimer(sessionId)
}

export type SandboxEvictionReason = 'session-close' | 'idle-timeout' | 'shutdown'

/**
 * Drop a session's sandbox and its timer. Called by the clean-close (DELETE)
 * hook, the idle timer, and the process-exit teardown.
 * @param sessionId - MCP session id.
 * @param reason - Why the sandbox is being dropped; included in the eviction log line.
 */
export function evictSandboxSession(sessionId: string, reason: SandboxEvictionReason): void {
  const session = sessions.get(sessionId)
  if (!session)
    return
  if (session.timer)
    clearTimeout(session.timer)
  session.adapter.dispose?.()
  sessions.delete(sessionId)
  consola.info(`[sandbox] evicted workspace for session ${sessionId} (reason: ${reason})`)
}

/**
 * Evict every session (process exit, test cleanup).
 */
export function disposeAllSandboxSessions(): void {
  for (const sessionId of [...sessions.keys()])
    evictSandboxSession(sessionId, 'shutdown')
}

/**
 * Live session count. Exported for tests (eviction/isolation assertions).
 */
export function getSandboxSessionCount(): number {
  return sessions.size
}

/**
 * Build the `sandbox` host-module leaf for one codemode run: the full Flue
 * `SandboxApi` surface plus an mc8yp-only `clear()`, shaped as an iso4
 * {@link HostModuleObject} (function leaves become bridge stubs).
 *
 * Stubs resolve the session's adapter on every call (which also resets its idle
 * timer), so `clear()` swaps the instance and later calls see the fresh one.
 * @param sessionId - MCP session id; scopes and persists the workspace.
 */
export function buildSandboxApi(sessionId: string): HostModuleObject {
  const get = (): SandboxAdapter => getSessionAdapter(sessionId)

  const requirePath = (value: unknown, method: string): string => {
    if (typeof value !== 'string' || value.length === 0)
      throw new TypeError(`sandbox.${method}(path): path must be a non-empty string`)
    return value
  }

  return {
    readFile: (...args) => get().readFile(requirePath(args[0], 'readFile')),
    readFileBuffer: (...args) => get().readFileBuffer(requirePath(args[0], 'readFileBuffer')),
    writeFile: (...args) => {
      const content = args[1]
      if (typeof content !== 'string' && !(content instanceof Uint8Array))
        throw new TypeError('sandbox.writeFile(path, content): content must be a string or Uint8Array')
      return get().writeFile(requirePath(args[0], 'writeFile'), content)
    },
    stat: async (...args) => {
      const s = await get().stat(requirePath(args[0], 'stat'))
      // iso4's wire codec rejects Date across the bridge (would throw at
      // registration), so expose mtime as epoch milliseconds instead.
      return { ...s, mtime: s.mtime instanceof Date ? s.mtime.getTime() : s.mtime }
    },
    readdir: (...args) => get().readdir(requirePath(args[0], 'readdir')),
    exists: (...args) => get().exists(requirePath(args[0], 'exists')),
    mkdir: (...args) => get().mkdir(
      requirePath(args[0], 'mkdir'),
      args[1] && typeof args[1] === 'object' ? args[1] as { recursive?: boolean } : undefined,
    ),
    rm: (...args) => get().rm(
      requirePath(args[0], 'rm'),
      args[1] && typeof args[1] === 'object' ? args[1] as { recursive?: boolean, force?: boolean } : undefined,
    ),
    exec: (...args) => {
      const command = args[0]
      if (typeof command !== 'string' || command.trim().length === 0)
        throw new TypeError('sandbox.exec(command): command must be a non-empty string')
      const raw = args[1] && typeof args[1] === 'object' ? args[1] as Record<string, unknown> : {}
      // Only forward host-safe options; `signal` cannot cross the bridge.
      const options: SandboxExecOptions = {
        cwd: typeof raw.cwd === 'string' ? raw.cwd : undefined,
        env: raw.env && typeof raw.env === 'object' ? raw.env as Record<string, string> : undefined,
        timeoutMs: typeof raw.timeoutMs === 'number' ? raw.timeoutMs : undefined,
      }
      return get().exec(command, options)
    },
    clear: async () => {
      resetSessionAdapter(sessionId)
    },
  }
}
