import { afterEach, describe, expect, it } from 'vitest'
import { buildExecutePrelude, buildExecuteScript } from '../src/codemode/excute'
import { parseRestrictionQuery, parseRestrictionRule, type RestrictionRule } from '../src/utils/restrictions'

type ExecuteHarnessResult = {
  called: boolean
  errorMessage?: string
  method?: string
  pwned?: unknown
  url?: string
}

type TestGlobals = typeof globalThis & {
  __called?: boolean
  __done?: Promise<unknown>
  __errorMessage?: string
  __method?: string
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

function resetTestGlobals() {
  delete testGlobals.__called
  delete testGlobals.__done
  delete testGlobals.__errorMessage
  delete testGlobals.__method
  delete testGlobals.__url
  delete testGlobals.pwned
}

async function runGeneratedExecuteScript(
  sourceCode: string,
  restrictions: readonly RestrictionRule[] = [],
  headers: Record<string, string> = { Authorization: 'Bearer test' },
): Promise<ExecuteHarnessResult> {
  resetTestGlobals()

  const run = new Function([
    buildExecutePrelude('https://tenant.example.com', headers, restrictions),
    sourceCode,
    'if (typeof globalThis.__done === "undefined") {',
    '  globalThis.__done = Promise.resolve();',
    '}',
    'return Promise.resolve(globalThis.__done).then(() => ({',
    '  called: globalThis.__called === true,',
    '  errorMessage: globalThis.__errorMessage,',
    '  method: globalThis.__method,',
    '  pwned: globalThis.pwned,',
    '  url: globalThis.__url,',
    '}));',
  ].join('\n')) as () => Promise<ExecuteHarnessResult>

  try {
    return await run()
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

describe('buildExecuteScript', () => {
  it('embeds restriction enforcement in the generated request wrapper', () => {
    const script = buildExecuteScript('void 0;', 'https://tenant.example.com', { Authorization: 'Bearer test' }, [parseRestrictionRule('GET:/inventory/**')])

    expect(script).toContain('const compiledRestrictions = compileRestrictionSources(restrictionSources);')
    expect(script).toContain('const blockedRules = getBlockedCompiledRestrictions(compiledRestrictions, init.method, resolvedUrl.pathname);')
    expect(script).toContain('Cumulocity request blocked by MCP restrictions: ')
  })

  it('embeds tenant-origin enforcement in the generated request wrapper', () => {
    const script = buildExecuteScript('void 0;', 'https://tenant.example.com', { Authorization: 'Bearer test' })

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
      `${installFetchTrap.toString()}`,
      'installFetchTrap();',
      'globalThis.__done = (async () => {',
      '  try {',
      '    await cumulocity.request({',
      '      method: "GET",',
      '      path: "/inventory/managedObjects?pageSize=5",',
      '    });',
      '  } catch (error) {',
      '    globalThis.__errorMessage = error instanceof Error ? error.message : String(error);',
      '  }',
      '})();',
    ].join('\n'), [parseRestrictionRule('GET:/inventory/**')])

    expect(result.called).toBe(false)
    expect(result.errorMessage).toContain('Cumulocity request blocked by MCP restrictions: GET:/inventory/**')
  })

  it('allows safe requests when valid restrictions are present', async () => {
    const restrictions = parseRestrictionQuery('https://example.test/mcp?restriction=GET%3A%2Finventory%2F**&restriction=%2Falarm%2F*')
    const result = await runGeneratedExecuteScript([
      `${installEchoFetch.toString()}`,
      'installEchoFetch();',
      'globalThis.__done = cumulocity.request({',
      '  method: "POST",',
      '  path: "/event/events",',
      '});',
    ].join('\n'), restrictions)

    expect(result.called).toBe(true)
    expect(result.url).toBe('https://tenant.example.com/event/events')
    expect(result.method).toBe('POST')
    expect(result.pwned).toBeUndefined()
  })

  it('rejects invalid handcrafted restriction objects before prelude generation', () => {
    const maliciousRule: RestrictionRule = {
      method: '*',
      pathPattern: '/inventory/managedObjects',
      source: '/inventory/managedObjects");globalThis.pwned=true;("',
    }

    expect(() => buildExecutePrelude('https://tenant.example.com', { Authorization: 'Bearer test' }, [maliciousRule])).toThrow()
  })

  it.each(INVALID_RESTRICTION_QUERY_PAYLOADS)('rejects invalid malicious restriction text from query params: %s', (payload) => {
    expect(() => parseRestrictionQuery(`https://example.test/mcp?restriction=${encodeURIComponent(payload)}`)).toThrow()
  })
})