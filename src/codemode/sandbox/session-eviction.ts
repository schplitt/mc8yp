import { InMemoryInfoSessionManager } from '@tmcp/session-manager'
import { evictSandboxSession } from './index'

// ─────────────────────────────────────────────────────────────────────────
// Clean-close eviction hook (server mode).
//
// The HTTP transport calls `sessionManager.info.delete(id)` when a client ends
// its session cleanly (HTTP DELETE /mcp). We wrap the default in-memory manager
// so that same signal also drops the session's sandbox workspace immediately,
// instead of waiting out the 15-minute idle TTL. The TTL remains the backstop
// for sessions that never send DELETE (crashes, dropped connections, clients
// that skip it).
//
// Composition, not subclassing: `@tmcp/session-manager`'s type declaration
// leaves `InMemoryInfoSessionManager`'s members abstract, so extending it and
// calling `super.delete` fails typechecking even though the JS implements them.
// Patching `delete` on an instance sidesteps that cleanly.
//
// Imported only by the server entrypoint (`src/index.ts`), so
// `@tmcp/session-manager` never enters the CLI bundle.
// ─────────────────────────────────────────────────────────────────────────

export function createSandboxEvictingInfoSessionManager(): InMemoryInfoSessionManager {
  const manager = new InMemoryInfoSessionManager()
  const inner = manager.delete.bind(manager)
  manager.delete = (id: string): void => {
    evictSandboxSession(id, 'session-close')
    inner(id)
  }
  return manager
}
