import { Bash } from 'just-bash'
import type { SandboxAdapter } from './types'

// ─────────────────────────────────────────────────────────────────────────
// just-bash adapter — the first (and only, for now) `SandboxAdapter` backend.
//
// Core shell only: `network`, `python`, and `javascript` all default to off in
// just-bash, so a bare `new Bash()` is a pure-JS in-memory shell with no host
// filesystem access and no network surface. That is exactly the isolation we
// want — all live network stays on the Cumulocity safeFetch path, never here.
//
// Filesystem operations map onto the `Bash.fs` (IFileSystem) object 1:1;
// `exec` maps onto `Bash.exec`. Nothing here manages lifecycle — the store in
// `./index.ts` owns creation/reset.
// ─────────────────────────────────────────────────────────────────────────

// Per-command wall-clock cap applied when the caller passes no explicit
// timeoutMs. just-bash's built-in limits (10k loop iterations, 10 MB output,
// etc.) bound most runaway work; this backstops the rest host-side via an
// AbortController, independent of the outer iso4 isolate limits.
const DEFAULT_EXEC_TIMEOUT_MS = 30_000

/**
 * Create a fresh in-memory just-bash sandbox exposed through the neutral
 * {@link SandboxAdapter} contract. Each call yields an independent virtual
 * filesystem.
 */
export function createJustBashAdapter(): SandboxAdapter {
  // cwd: '/' so relative paths resolve identically in the fs methods and the
  // shell. just-bash defaults the shell cwd to '/home/user' but resolves
  // `fs.writeFile('foo')` against '/', so a relative `writeFile` then
  // `exec('cat foo')` would silently miss each other — the shell would look in
  // /home/user while the file sits at /. Rooting the shell at '/' aligns them.
  const bash = new Bash({ cwd: '/' })
  const fs = bash.fs

  return {
    readFile: (path) => fs.readFile(path),
    readFileBuffer: (path) => fs.readFileBuffer(path),
    writeFile: (path, content) => fs.writeFile(path, content),
    exists: (path) => fs.exists(path),
    readdir: (path) => fs.readdir(path),
    mkdir: (path, options) => fs.mkdir(path, options),
    rm: (path, options) => fs.rm(path, options),
    stat: async (path) => {
      const s = await fs.stat(path)
      return {
        isFile: s.isFile,
        isDirectory: s.isDirectory,
        isSymbolicLink: s.isSymbolicLink,
        size: s.size,
        mtime: s.mtime,
      }
    },
    exec: async (command, options) => {
      // `timeoutMs` is honoured host-side via an AbortController. An
      // agent-supplied `AbortSignal` cannot cross the bridge, so `signal` is
      // only ever set by host callers; both are merged when present.
      const timeoutMs = options?.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      const signal = options?.signal
        ? AbortSignal.any([options.signal, controller.signal])
        : controller.signal
      try {
        const result = await bash.exec(command, {
          cwd: options?.cwd,
          env: options?.env,
          signal,
        })
        return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
