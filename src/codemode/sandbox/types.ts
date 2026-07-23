// ─────────────────────────────────────────────────────────────────────────
// Sandbox adapter contract.
//
// Deliberately mirrors Flue's `SandboxApi` shape
// (https://flueframework.com/docs/api/sandbox-api/) so the concrete backend is
// swappable: today a `just-bash` in-memory shell, tomorrow a Vercel Sandbox, a
// remote provider, etc. An adapter wraps a provider into this interface and
// nothing more — lifecycle (create/reset/dispose) is owned by the caller
// (`src/codemode/sandbox/index.ts`), never by the adapter itself.
//
// This is a discovery/scratch-compute surface for agent code, exposed inside
// codemode as the `sandbox` global. It is intentionally isolated from the live
// Cumulocity request path: no network, no host filesystem — just an in-memory
// workspace plus shell utilities (grep/jq/awk/sed/sort/sqlite/…).
// ─────────────────────────────────────────────────────────────────────────

/**
 * The agent-facing `sandbox` surface as a TypeScript declaration string.
 * Single source of truth shared by the `code-mode-guide` prompt and
 * `codemode.describe("sandbox")`, so what the agent is told always matches what
 * it can actually call. `mtime` is epoch milliseconds (a `Date` cannot cross
 * the iso4 bridge), and `clear()` is the mc8yp-only reset (not part of Flue's
 * `SandboxApi`).
 */
export const SANDBOX_INTERFACE_TS = `declare const sandbox: {
  readFile: (path: string) => Promise<string>
  readFileBuffer: (path: string) => Promise<Uint8Array>
  writeFile: (path: string, content: string | Uint8Array) => Promise<void>
  stat: (path: string) => Promise<{ isFile: boolean, isDirectory: boolean, isSymbolicLink: boolean, size: number, mtime: number }>
  readdir: (path: string) => Promise<string[]>
  exists: (path: string) => Promise<boolean>
  mkdir: (path: string, options?: { recursive?: boolean }) => Promise<void>
  rm: (path: string, options?: { recursive?: boolean, force?: boolean }) => Promise<void>
  exec: (command: string, options?: { cwd?: string, env?: Record<string, string>, timeoutMs?: number }) => Promise<{ stdout: string, stderr: string, exitCode: number }>
  clear: () => Promise<void>  // mc8yp-only: wipe the filesystem and start fresh
}`

/**
 * File metadata, mirroring Flue's `FileStat`.
 */
export interface SandboxFileStat {
  isFile: boolean
  isDirectory: boolean
  isSymbolicLink: boolean
  size: number
  mtime: Date
}

/**
 * Result of a shell command execution.
 */
export interface SandboxExecResult {
  stdout: string
  stderr: string
  exitCode: number
}

/**
 * Options for {@link SandboxAdapter.exec}.
 */
export interface SandboxExecOptions {
  cwd?: string
  env?: Record<string, string>
  /**
   * Wall-clock cap for this single command. The adapter forwards it to the
   * provider (for `just-bash`, via an `AbortController`).
   */
  timeoutMs?: number
  /**
   * Cooperative cancellation. Populated host-side only — an `AbortSignal`
   * cannot cross the sandbox bridge, so agent code never supplies this.
   */
  signal?: AbortSignal
}

/**
 * The swappable backend contract. Kept intentionally identical to Flue's
 * `SandboxApi` so a future provider swap is a drop-in.
 */
export interface SandboxAdapter {
  readFile: (path: string) => Promise<string>
  readFileBuffer: (path: string) => Promise<Uint8Array>
  writeFile: (path: string, content: string | Uint8Array) => Promise<void>
  stat: (path: string) => Promise<SandboxFileStat>
  readdir: (path: string) => Promise<string[]>
  exists: (path: string) => Promise<boolean>
  mkdir: (path: string, options?: { recursive?: boolean }) => Promise<void>
  rm: (path: string, options?: { recursive?: boolean, force?: boolean }) => Promise<void>
  exec: (command: string, options?: SandboxExecOptions) => Promise<SandboxExecResult>
  /**
   * Release any provider resources. In-memory backends have nothing to free;
   * present so future providers (remote sandboxes) can clean up.
   */
  dispose?: () => void
}
