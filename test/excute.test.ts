/* eslint-disable no-template-curly-in-string */
/* eslint-disable no-new-func */
import { matchesGlob } from 'node:path'
import { encode } from '@toon-format/toon'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildExecutePrelude, buildExecuteScript, execute } from '../src/codemode/execute'
import { parseRestrictionQuery, parseRestrictionRule } from '../src/utils/restrictions'
import type { RestrictionRule } from '../src/utils/restrictions'
import * as client from '../src/utils/client'

interface ExecuteHarnessResult {
  called: boolean
  method?: string
  pwned?: unknown
  result?: unknown
  url?: string
}

type TestGlobals = typeof globalThis & {
  __called?: boolean
  __done?: Promise<unknown>
  __method?: string
  __result?: unknown
  __url?: string
  pwned?: unknown
}

const testGlobals = globalThis as TestGlobals

const INVALID_RESTRICTION_QUERY_PAYLOADS = [
  '/inventory/managedObjects");globalThis.pwned=true;("',
  '/inventory/${globalThis.pwned=true}',
  '/inventory/managedObjects`);globalThis.pwned=true;//',
  '/inventory/*/..//*/**',
  '/inventory/managedObjects*/globalThis.pwned=true',
  '/inventory/managedObjects\u2028globalThis.pwned=true',
  '/inventory/managedObjects\u2029globalThis.pwned=true',
  'GET:/inventory/managedObjects");globalThis.pwned=true;("',
  'POST:/inventory/${globalThis.pwned=true}',
  '/inventory/managedObjects?x=1',
  '/inventory/managedObjects#frag',
  'BAD:/inventory/managedObjects',
  '/inventory/**evil',
  'POST:/inventory/**evil',
  'GET:inventory/managedObjects',
] as const

const OUT_OF_ORIGIN_REQUEST_PATHS = [
  {
    description: 'absolute URLs that point to a different origin',
    path: 'https://other.example.com/inventory/managedObjects',
  },
  {
    description: 'scheme-relative URLs that point to a different origin',
    path: '//other.example.com/inventory/managedObjects',
  },
] as const

function resetTestGlobals() {
  delete testGlobals.__called
  delete testGlobals.__done
  delete testGlobals.__method
  delete testGlobals.__result
  delete testGlobals.__url
  delete testGlobals.pwned
}

async function runGeneratedExecuteScript(
  sourceCode: string,
  restrictions: readonly RestrictionRule[] = [],
  headers: Record<string, string> = { Authorization: 'Bearer test' },
): Promise<ExecuteHarnessResult> {
  resetTestGlobals()

  // matchesGlob is injected as a parameter because the prelude references it
  // as a free variable (supplied by the ESM import in the real sandbox runtime).
  const run = new Function('matchesGlob', [
    buildExecutePrelude('https://tenant.example.com', headers, restrictions),
    `const __mc8ypExecute = (${sourceCode});`,
    'globalThis.__done = (async () => {',
    '  try {',
    '    if (typeof __mc8ypExecute !== "function") {',
    '      throw new TypeError("Execute code must evaluate to a function.");',
    '    }',
    '    globalThis.__result = {',
    '      status: "success",',
    '      result: await __mc8ypExecute(),',
    '    };',
    '  } catch (error) {',
    '    const message = error instanceof Error ? error.message : String(error);',
    '    globalThis.__result = {',
    '      status: message.startsWith("Request blocked by MCP connection policy.") ? "blocked" : "failed",',
    '      error: { message },',
    '    };',
    '  }',
    '})();',
    'if (typeof globalThis.__done === "undefined") {',
    '  globalThis.__done = Promise.resolve();',
    '}',
    'return Promise.resolve(globalThis.__done).then(() => ({',
    '  called: globalThis.__called === true,',
    '  method: globalThis.__method,',
    '  pwned: globalThis.pwned,',
    '  result: globalThis.__result,',
    '  url: globalThis.__url,',
    '}));',
  ].join('\n')) as (matchesGlob: typeof import('node:path').matchesGlob) => Promise<ExecuteHarnessResult>

  try {
    return await run(matchesGlob)
  } finally {
    resetTestGlobals()
  }
}

function installFetchTrap() {
  globalThis.fetch = async () => {
    ;(globalThis as TestGlobals).__called = true
    throw new Error('fetch should not be called')
  }
}

function installEchoFetch() {
  globalThis.fetch = async (url, init) => {
    const globals = globalThis as TestGlobals
    globals.__called = true
    globals.__url = String(url)
    globals.__method = init?.method ?? 'GET'

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
}

afterEach(() => {
  resetTestGlobals()
})

function expectedBlockedResult(method: string, path: string): { status: 'blocked', error: { message: string } } {
  return {
    status: 'blocked',
    error: {
      message: `Request blocked by MCP connection policy.\n\nMethod: ${method}\nPath: ${path}`,
    },
  }
}

describe('buildExecuteScript', () => {
  it('embeds restriction enforcement in the generated request wrapper', () => {
    const script = buildExecuteScript('async () => null', 'https://tenant.example.com', { Authorization: 'Bearer test' }, [parseRestrictionRule('GET:/inventory/**')])

    expect(script).toContain('import { matchesGlob } from "node:path";')
    expect(script).toContain('matches(pathname, r.pathPattern)')
    expect(script).toContain('Request blocked by MCP connection policy.')
    expect(script).toContain('const __mc8ypExecute = (async () => null);')
    expect(script).toContain('status: "success"')
    expect(script).toContain('status: message.startsWith("Request blocked by MCP connection policy.") ? "blocked" : "failed"')
  })

  it('embeds tenant-origin enforcement in the generated request wrapper', () => {
    const script = buildExecuteScript('async () => null', 'https://tenant.example.com', { Authorization: 'Bearer test' })

    expect(script).toContain('if (resolved.origin !== tenantOrigin)')
    expect(script).toContain('Cumulocity requests must target the configured tenant origin.')
  })

  it('initializes the generated execute prelude without side effects for safe restrictions', () => {
    const prelude = buildExecutePrelude('https://tenant.example.com', { Authorization: 'Bearer test' }, [parseRestrictionRule('GET:/inventory/**')])
    const run = new Function(`${prelude}\nreturn globalThis.pwned;`) as () => unknown

    expect(run()).toBeUndefined()
  })

  it('blocks restricted requests before fetch is called when the generated code executes', async () => {
    const result = await runGeneratedExecuteScript([
      'async () => {',
      `${installFetchTrap.toString()}`,
      'installFetchTrap();',
      'return await cumulocity.request({',
      '  method: "GET",',
      '  path: "/inventory/managedObjects?pageSize=5",',
      '});',
      '}',
    ].join('\n'), [parseRestrictionRule('GET:/inventory/**')])

    expect(result.called).toBe(false)
    expect(result.result).toEqual(expectedBlockedResult('GET', '/inventory/managedObjects'))
  })

  it('allows safe requests when valid restrictions are present', async () => {
    const result = await runGeneratedExecuteScript([
      'async () => {',
      `${installEchoFetch.toString()}`,
      'installEchoFetch();',
      'return await cumulocity.request({',
      '  method: "POST",',
      '  path: "/event/events",',
      '});',
      '}',
    ].join('\n'), [parseRestrictionRule('GET:/inventory/**'), parseRestrictionRule('/alarm/*')])

    expect(result.called).toBe(true)
    expect(result.url).toBe('https://tenant.example.com/event/events')
    expect(result.method).toBe('POST')
    expect(result.pwned).toBeUndefined()
    expect(result.result).toEqual({
      status: 'success',
      result: { ok: true },
    })
  })

  it('blocks query-derived restrictions for same-origin absolute URLs before fetch is called', async () => {
    const restrictions = parseRestrictionQuery('https://example.test/mcp?restriction=GET%3A%2Finventory%2F**')
    const result = await runGeneratedExecuteScript([
      'async () => {',
      `${installFetchTrap.toString()}`,
      'installFetchTrap();',
      'return await cumulocity.request({',
      '  method: "GET",',
      '  path: "https://tenant.example.com/inventory/managedObjects?pageSize=5",',
      '});',
      '}',
    ].join('\n'), restrictions)

    expect(result.called).toBe(false)
    expect(result.result).toEqual(expectedBlockedResult('GET', '/inventory/managedObjects'))
  })

  it.each(OUT_OF_ORIGIN_REQUEST_PATHS)('rejects $description before fetch is called', async ({ path }) => {
    const result = await runGeneratedExecuteScript([
      'async () => {',
      `${installFetchTrap.toString()}`,
      'installFetchTrap();',
      'return await cumulocity.request({',
      '  method: "GET",',
      `  path: ${JSON.stringify(path)},`,
      '});',
      '}',
    ].join('\n'))

    expect(result.called).toBe(false)
    expect(result.result).toEqual({
      status: 'failed',
      error: {
        message: 'Cumulocity requests must target the configured tenant origin.',
      },
    })
  })

  it.each(INVALID_RESTRICTION_QUERY_PAYLOADS)('rejects invalid malicious restriction text from query params: %s', (payload) => {
    expect(() => parseRestrictionQuery(`https://example.test/mcp?restriction=${encodeURIComponent(payload)}`)).toThrow()
  })

  it('classifies non-function execute code as a failed envelope', async () => {
    const result = await runGeneratedExecuteScript('({ not: "a function" })')

    expect(result.result).toEqual({
      status: 'failed',
      error: {
        message: 'Execute code must evaluate to a function.',
      },
    })
  })
})

describe('execute', () => {
  it('returns only the successful function result encoded in Toon format', async () => {
    vi.spyOn(client, 'resolveC8yAuth').mockResolvedValueOnce({
      tenantUrl: 'https://tenant.example.com',
      authorizationHeader: 'Bearer test',
    })

    const result = await execute('async () => ({ ok: true, answer: 42 })')

    expect(result).toBe(encode({ ok: true, answer: 42 }))
  })

  it('returns blocked execution as plain text', async () => {
    vi.spyOn(client, 'resolveC8yAuth').mockResolvedValueOnce({
      tenantUrl: 'https://tenant.example.com',
      authorizationHeader: 'Bearer test',
    })

    const result = await execute('async () => { throw new Error("Request blocked by MCP connection policy.\\n\\nblocked") }')

    expect(result).toBe('Request blocked by MCP connection policy.\n\nblocked')
  })

  it('returns failed execution as plain text', async () => {
    vi.spyOn(client, 'resolveC8yAuth').mockResolvedValueOnce({
      tenantUrl: 'https://tenant.example.com',
      authorizationHeader: 'Bearer test',
    })

    const result = await execute('async () => { throw new Error("boom") }')

    expect(result).toBe('boom')
  })
})
