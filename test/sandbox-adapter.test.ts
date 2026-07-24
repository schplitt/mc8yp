import { afterEach, describe, expect, it, vi } from 'vitest'
import { createJustBashAdapter } from '../src/codemode/sandbox/just-bash-adapter'
import { buildSandboxApi, disposeAllSandboxSessions, evictSandboxSession, getSandboxSessionCount } from '../src/codemode/sandbox'
import { createSandboxEvictingInfoSessionManager } from '../src/codemode/sandbox/session-eviction'

type SandboxApi = Record<string, (...args: unknown[]) => Promise<any>>

// ─────────────────────────────────────────────────────────────────────────
// just-bash adapter — verifies the SandboxApi surface maps onto just-bash and
// that the in-memory shell is genuinely isolated (no network, no host FS).
// ─────────────────────────────────────────────────────────────────────────

describe('just-bash sandbox adapter', () => {
  it('round-trips files through the virtual filesystem', async () => {
    const fs = createJustBashAdapter()
    await fs.writeFile('/data/hello.txt', 'hello world\n')
    expect(await fs.exists('/data/hello.txt')).toBe(true)
    expect(await fs.readFile('/data/hello.txt')).toBe('hello world\n')
    const stat = await fs.stat('/data/hello.txt')
    expect(stat.isFile).toBe(true)
    expect(stat.isDirectory).toBe(false)
    expect(stat.size).toBeGreaterThan(0)
  })

  it('creates and lists directories, and removes recursively', async () => {
    const fs = createJustBashAdapter()
    await fs.mkdir('/work/nested', { recursive: true })
    await fs.writeFile('/work/a.txt', 'a')
    await fs.writeFile('/work/b.txt', 'b')
    const entries = await fs.readdir('/work')
    expect(entries.sort()).toEqual(['a.txt', 'b.txt', 'nested'])
    await fs.rm('/work', { recursive: true, force: true })
    expect(await fs.exists('/work')).toBe(false)
  })

  it('runs shell pipelines over written data', async () => {
    const fs = createJustBashAdapter()
    await fs.writeFile('/nums.txt', '3\n1\n2\n1\n')
    const { stdout, exitCode } = await fs.exec('sort -n /nums.txt | uniq -c | tr -s " "')
    expect(exitCode).toBe(0)
    expect(stdout).toContain('2 1')
    expect(stdout).toContain('1 2')
    expect(stdout).toContain('1 3')
  })

  it('processes JSON with jq', async () => {
    const fs = createJustBashAdapter()
    await fs.writeFile('/data.json', JSON.stringify([{ severity: 'MAJOR' }, { severity: 'MAJOR' }, { severity: 'MINOR' }]))
    const { stdout } = await fs.exec('jq "length" /data.json')
    expect(stdout.trim()).toBe('3')
  })

  it('reports non-zero exit codes without throwing', async () => {
    const fs = createJustBashAdapter()
    const { exitCode, stderr } = await fs.exec('cat /nope.txt')
    expect(exitCode).not.toBe(0)
    expect(stderr.length).toBeGreaterThan(0)
  })

  it('has no curl/network surface (core shell only)', async () => {
    const fs = createJustBashAdapter()
    const { exitCode } = await fs.exec('curl https://example.com')
    // curl is unavailable without network config → command not found (non-zero).
    expect(exitCode).not.toBe(0)
  })

  it('resolves relative paths the same for fs methods and the shell', async () => {
    const fs = createJustBashAdapter()
    // Write via the fs API with a RELATIVE path...
    await fs.writeFile('report.md', '# hi\nBorkum\n')
    // ...and read it back through the shell with the same relative path.
    const cat = await fs.exec('cat report.md')
    expect(cat.exitCode).toBe(0)
    expect(cat.stdout).toContain('Borkum')
    const ls = await fs.exec('ls')
    expect(ls.stdout).toContain('report.md')
    const grep = await fs.exec('grep -c Borkum report.md')
    expect(grep.stdout.trim()).toBe('1')
  })

  it('gives each adapter instance an independent filesystem', async () => {
    const a = createJustBashAdapter()
    const b = createJustBashAdapter()
    await a.writeFile('/only-in-a.txt', 'x')
    expect(await a.exists('/only-in-a.txt')).toBe(true)
    expect(await b.exists('/only-in-a.txt')).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Per-session store: idle eviction, timer reset, isolation.
// ─────────────────────────────────────────────────────────────────────────

const IDLE_MS = 15 * 60 * 1000

describe('sandbox session store', () => {
  afterEach(() => {
    disposeAllSandboxSessions()
    vi.useRealTimers()
  })

  it('evicts a session after 15 minutes idle', async () => {
    vi.useFakeTimers()
    const api = buildSandboxApi('sess-1') as SandboxApi
    await api.writeFile('/x.txt', 'hi') // first use creates + arms the timer
    expect(getSandboxSessionCount()).toBe(1)
    vi.advanceTimersByTime(IDLE_MS + 1)
    expect(getSandboxSessionCount()).toBe(0)
  })

  it('resets the idle timer on every use', async () => {
    vi.useFakeTimers()
    const api = buildSandboxApi('sess-2') as SandboxApi
    await api.writeFile('/x.txt', '1')
    vi.advanceTimersByTime(IDLE_MS - 60_000) // 14 min
    await api.readFile('/x.txt') // use → timer reset
    vi.advanceTimersByTime(IDLE_MS - 60_000) // another 14 min (28 total)
    expect(getSandboxSessionCount()).toBe(1) // still alive: reset at 14 min
    vi.advanceTimersByTime(60_000 + 1)
    expect(getSandboxSessionCount()).toBe(0)
  })

  it('evicts one session without touching others', async () => {
    const a = buildSandboxApi('A') as SandboxApi
    const b = buildSandboxApi('B') as SandboxApi
    await a.writeFile('/f', '1')
    await b.writeFile('/f', '2')
    expect(getSandboxSessionCount()).toBe(2)
    evictSandboxSession('A', 'session-close')
    expect(getSandboxSessionCount()).toBe(1)
  })

  it('evicts the sandbox on clean session close (transport DELETE → info.delete)', async () => {
    // The HTTP transport calls sessionManager.info.delete(id) on a clean
    // client DELETE. Drive that method directly to prove the hook fires.
    const manager = createSandboxEvictingInfoSessionManager()
    const api = buildSandboxApi('sess-del') as SandboxApi
    await api.writeFile('/x.txt', '1')
    expect(getSandboxSessionCount()).toBe(1)
    manager.delete('sess-del')
    expect(getSandboxSessionCount()).toBe(0)
  })
})
