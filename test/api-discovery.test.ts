import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DISCOVERY_REFRESH_INTERVAL_MS,
  bustApiSpecCache,
  discoverApiSpecs,
  refreshApiSpecs,
  setCachedApiSpecs,
  startDiscovery,
} from '../src/utils/api-discovery'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TENANT = 'https://test.cumulocity.com'
const AUTH = { Authorization: 'Bearer test-token' }

function makeUserResponse(id = 'user1') {
  return { id }
}

function makeAppsResponse(apps: object[]) {
  return { applications: apps }
}

function makeApp(overrides: {
  id?: string
  name?: string
  contextPath?: string
  openApiSpec?: string | Array<{ label: string, path: string }>
}) {
  return {
    id: overrides.id ?? 'app1',
    name: overrides.name ?? 'My Service',
    contextPath: overrides.contextPath ?? 'myservice',
    manifest: overrides.openApiSpec != null ? { openApiSpec: overrides.openApiSpec } : {},
  }
}

function makeSpec(paths: Record<string, object> = {}) {
  return {
    openapi: '3.0.0',
    info: { title: 'Test Spec', version: '1.0.0' },
    servers: [{ url: 'https://test.cumulocity.com', description: 'Test service' }],
    paths,
  }
}

interface FetchMockResponse { ok: boolean, status?: number, statusText?: string, json: () => Promise<unknown> }

function stubFetch(responses: Record<string, FetchMockResponse>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = typeof input === 'string' ? input : (input as Request).url
    const match = responses[url]
    if (!match) {
      return Promise.resolve({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: () => Promise.resolve({ error: 'not found' }),
      } as unknown as Response)
    }
    return Promise.resolve(match as unknown as Response)
  })
}

function ok(body: unknown): FetchMockResponse {
  return { ok: true, status: 200, statusText: 'OK', json: () => Promise.resolve(body) }
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

describe('spec cache', () => {
  beforeEach(() => bustApiSpecCache())
  afterEach(() => bustApiSpecCache())

  it('stores and retrieves a DiscoveryResult by awaiting the cached promise', async () => {
    const specs = [{ contextPath: 'svc', appLabel: 'Svc', specLabel: 'Svc', servicePrefix: '/service/svc', spec: {} }]
    setCachedApiSpecs(TENANT, specs)
    const result = await startDiscovery(TENANT, AUTH)
    expect(result.specs).toEqual(specs)
  })

  it('normalizes trailing slash in tenant URL', async () => {
    const specs = [{ contextPath: 'svc', appLabel: 'Svc', specLabel: 'Svc', servicePrefix: '/service/svc', spec: {} }]
    setCachedApiSpecs(`${TENANT}/`, specs)
    const result = await startDiscovery(TENANT, AUTH)
    expect(result.specs).toEqual(specs)
  })

  it('busts a specific tenant cache — startDiscovery triggers fresh network call after bust', async () => {
    setCachedApiSpecs(TENANT, [])
    bustApiSpecCache(TENANT)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: () => Promise.resolve({}),
    } as unknown as Response)
    await startDiscovery(TENANT, AUTH)
    expect(fetchSpy).toHaveBeenCalled()
    vi.restoreAllMocks()
  })

  it('busts all caches when called without arguments', async () => {
    setCachedApiSpecs(TENANT, [])
    setCachedApiSpecs('https://other.cumulocity.com', [])
    bustApiSpecCache()
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: () => Promise.resolve({}),
    } as unknown as Response)
    await Promise.all([
      startDiscovery(TENANT, AUTH),
      startDiscovery('https://other.cumulocity.com', AUTH),
    ])
    expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(2)
    vi.restoreAllMocks()
  })
})

// ---------------------------------------------------------------------------
// discoverApiSpecs
// ---------------------------------------------------------------------------

describe('discoverApiSpecs', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    bustApiSpecCache()
  })

  it('returns empty specs when no apps have openApiSpec in manifest, but the app is in installedContextPaths', async () => {
    stubFetch({
      [`${TENANT}/user/currentUser`]: ok(makeUserResponse()),
      [`${TENANT}/application/applicationsByUser/user1?pageSize=2000`]: ok(makeAppsResponse([
        makeApp({ openApiSpec: undefined }),
      ])),
    })
    const result = await discoverApiSpecs(TENANT, AUTH)
    expect(result.specs).toEqual([])
    expect(result.installedContextPaths.has('myservice')).toBe(true)
  })

  it('downloads and path-prefixes a spec for a string openApiSpec entry', async () => {
    const rawSpec = makeSpec({ '/things': { get: { summary: 'List things' } } })
    stubFetch({
      [`${TENANT}/user/currentUser`]: ok(makeUserResponse()),
      [`${TENANT}/application/applicationsByUser/user1?pageSize=2000`]: ok(makeAppsResponse([
        makeApp({ contextPath: 'myservice', openApiSpec: 'openapi.json' }),
      ])),
      [`${TENANT}/service/myservice/openapi.json`]: ok(rawSpec),
    })

    const result = await discoverApiSpecs(TENANT, AUTH)
    expect(result.specs).toHaveLength(1)
    const spec = result.specs[0]!
    expect(spec.contextPath).toBe('myservice')
    expect(spec.servicePrefix).toBe('/service/myservice')
    expect(spec.specLabel).toBe('My Service')
    const paths = (spec.spec as { paths: Record<string, unknown> }).paths
    expect(paths['/service/myservice/things']).toBeDefined()
    expect(paths['/things']).toBeUndefined()
  })

  it('handles array openApiSpec manifest entries producing multiple spec entries', async () => {
    const specA = makeSpec({ '/alpha': { get: {} } })
    const specB = makeSpec({ '/beta': { post: {} } })
    stubFetch({
      [`${TENANT}/user/currentUser`]: ok(makeUserResponse()),
      [`${TENANT}/application/applicationsByUser/user1?pageSize=2000`]: ok(makeAppsResponse([
        makeApp({
          contextPath: 'multi',
          openApiSpec: [
            { label: 'Alpha API', path: 'alpha.json' },
            { label: 'Beta API', path: 'beta.json' },
          ],
        }),
      ])),
      [`${TENANT}/service/multi/alpha.json`]: ok(specA),
      [`${TENANT}/service/multi/beta.json`]: ok(specB),
    })

    const result = await discoverApiSpecs(TENANT, AUTH)
    expect(result.specs).toHaveLength(2)
    expect(result.specs.map((s) => s.specLabel)).toEqual(['Alpha API', 'Beta API'])
    expect(result.specs.every((s) => s.contextPath === 'multi')).toBe(true)
  })

  it('strips leading slash from manifest spec path before building URL', async () => {
    const rawSpec = makeSpec({ '/items': { get: {} } })
    stubFetch({
      [`${TENANT}/user/currentUser`]: ok(makeUserResponse()),
      [`${TENANT}/application/applicationsByUser/user1?pageSize=2000`]: ok(makeAppsResponse([
        makeApp({ contextPath: 'svc', openApiSpec: '/spec.json' }),
      ])),
      [`${TENANT}/service/svc/spec.json`]: ok(rawSpec),
    })

    const result = await discoverApiSpecs(TENANT, AUTH)
    expect(result.specs).toHaveLength(1)
    expect((result.specs[0]!.spec as { paths: Record<string, unknown> }).paths['/service/svc/items']).toBeDefined()
  })

  it('skips apps without a contextPath — they do not appear in installedContextPaths', async () => {
    stubFetch({
      [`${TENANT}/user/currentUser`]: ok(makeUserResponse()),
      [`${TENANT}/application/applicationsByUser/user1?pageSize=2000`]: ok(makeAppsResponse([
        { id: 'x', name: 'No Context', manifest: { openApiSpec: 'spec.json' } },
      ])),
    })
    const result = await discoverApiSpecs(TENANT, AUTH)
    expect(result.specs).toEqual([])
    expect(result.installedContextPaths.size).toBe(0)
  })

  it('skips a spec when the download request fails with a non-ok status', async () => {
    stubFetch({
      [`${TENANT}/user/currentUser`]: ok(makeUserResponse()),
      [`${TENANT}/application/applicationsByUser/user1?pageSize=2000`]: ok(makeAppsResponse([
        makeApp({ contextPath: 'broken', openApiSpec: 'spec.json' }),
      ])),
      [`${TENANT}/service/broken/spec.json`]: { ok: false, status: 503, statusText: 'Service Unavailable', json: () => Promise.resolve({}) },
    })
    const result = await discoverApiSpecs(TENANT, AUTH)
    expect(result.specs).toHaveLength(0)
    expect(result.installedContextPaths.has('broken')).toBe(true)
  })

  it('skips a spec when the download throws a network error', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      if (url.includes('/service/')) {
        return Promise.reject(new Error('Network error'))
      }
      if (url.includes('/user/currentUser')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(makeUserResponse()) } as unknown as Response)
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(makeAppsResponse([makeApp({ contextPath: 'neterr', openApiSpec: 'spec.json' })])) } as unknown as Response)
    })
    const result = await discoverApiSpecs(TENANT, AUTH)
    expect(result.specs).toHaveLength(0)
    expect(result.installedContextPaths.has('neterr')).toBe(true)
  })

  it('throws when two different apps share the same contextPath', async () => {
    stubFetch({
      [`${TENANT}/user/currentUser`]: ok(makeUserResponse()),
      [`${TENANT}/application/applicationsByUser/user1?pageSize=2000`]: ok(makeAppsResponse([
        makeApp({ id: 'app1', name: 'Service One', contextPath: 'shared', openApiSpec: 'spec.json' }),
        makeApp({ id: 'app2', name: 'Service Two', contextPath: 'shared', openApiSpec: 'spec.json' }),
      ])),
    })
    await expect(discoverApiSpecs(TENANT, AUTH)).rejects.toThrow(
      'Two subscribed applications share context path "shared": "Service One" and "Service Two"',
    )
  })

  it('does not throw when the same app appears twice in the list (same name, same contextPath)', async () => {
    const rawSpec = makeSpec({ '/a': { get: {} } })
    const app = makeApp({ contextPath: 'dup', openApiSpec: 'spec.json' })
    stubFetch({
      [`${TENANT}/user/currentUser`]: ok(makeUserResponse()),
      [`${TENANT}/application/applicationsByUser/user1?pageSize=2000`]: ok(makeAppsResponse([app, app])),
      [`${TENANT}/service/dup/spec.json`]: ok(rawSpec),
    })
    // Should not throw — same app, same contextPath
    const result = await discoverApiSpecs(TENANT, AUTH)
    expect(result.specs).toHaveLength(1)
  })

  it('throws when fetching current user fails', async () => {
    stubFetch({
      [`${TENANT}/user/currentUser`]: { ok: false, status: 401, statusText: 'Unauthorized', json: () => Promise.resolve({}) },
    })
    await expect(discoverApiSpecs(TENANT, AUTH)).rejects.toThrow('Failed to fetch current user: 401')
  })

  it('throws when fetching the application list fails', async () => {
    stubFetch({
      [`${TENANT}/user/currentUser`]: ok(makeUserResponse()),
      [`${TENANT}/application/applicationsByUser/user1?pageSize=2000`]: { ok: false, status: 500, statusText: 'Internal Server Error', json: () => Promise.resolve({}) },
    })
    await expect(discoverApiSpecs(TENANT, AUTH)).rejects.toThrow('Failed to fetch applications: 500')
  })
})

// ---------------------------------------------------------------------------
// createOpenApiPartRestrictionRules with discovered specs
// ---------------------------------------------------------------------------
// startDiscovery
// ---------------------------------------------------------------------------

describe('startDiscovery', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    bustApiSpecCache()
  })

  it('returns a promise that resolves with a DiscoveryResult', async () => {
    const rawSpec = makeSpec({ '/things': { get: {} } })
    stubFetch({
      [`${TENANT}/user/currentUser`]: ok(makeUserResponse()),
      [`${TENANT}/application/applicationsByUser/user1?pageSize=2000`]: ok(makeAppsResponse([
        makeApp({ contextPath: 'svc', openApiSpec: 'spec.json' }),
      ])),
      [`${TENANT}/service/svc/spec.json`]: ok(rawSpec),
    })

    const promise = startDiscovery(TENANT, AUTH)
    expect(promise).toBeInstanceOf(Promise)
    const result = await promise
    expect(result.specs).toHaveLength(1)
    expect(result.specs[0]!.contextPath).toBe('svc')
    expect(result.installedContextPaths.has('svc')).toBe(true)
  })

  it('is idempotent — returns the same in-flight promise on concurrent calls', () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: () => new Promise(() => { /* never resolves */ }),
    } as unknown as Response)

    const p1 = startDiscovery(TENANT, AUTH)
    const p2 = startDiscovery(TENANT, AUTH)
    expect(p1).toBe(p2)
  })

  it('returns a resolved promise immediately when cache is already ready', async () => {
    setCachedApiSpecs(TENANT, [])
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const result = await startDiscovery(TENANT, AUTH)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(result.specs).toEqual([])
  })

  it('stores an empty ready entry on discovery failure so retries do not spam requests', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: () => Promise.resolve({}),
    } as unknown as Response)

    const result = await startDiscovery(TENANT, AUTH)
    expect(result.specs).toEqual([])

    // Second startDiscovery must NOT trigger another fetch — cache is ready
    const callsBefore = fetchSpy.mock.calls.length
    await startDiscovery(TENANT, AUTH)
    expect(fetchSpy.mock.calls.length).toBe(callsBefore)
  })

  it('resolved DiscoveryResult contains installedContextPaths for apps without a spec URL', async () => {
    stubFetch({
      [`${TENANT}/user/currentUser`]: ok(makeUserResponse()),
      [`${TENANT}/application/applicationsByUser/user1?pageSize=2000`]: ok(makeAppsResponse([
        makeApp({ contextPath: 'svc-no-spec', openApiSpec: undefined }),
      ])),
    })
    const result = await startDiscovery(TENANT, AUTH)
    expect(result.specs).toEqual([])
    expect(result.installedContextPaths.has('svc-no-spec')).toBe(true)
  })
})

describe('awaiting startDiscovery', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    bustApiSpecCache()
  })

  it('awaiting startDiscovery returns empty DiscoveryResult when discovery finds nothing', async () => {
    stubFetch({
      [`${TENANT}/user/currentUser`]: ok(makeUserResponse()),
      [`${TENANT}/application/applicationsByUser/user1?pageSize=2000`]: ok(makeAppsResponse([])),
    })
    const result = await startDiscovery(TENANT, AUTH)
    expect(result.specs).toEqual([])
    expect(result.installedContextPaths.size).toBe(0)
  })

  it('awaiting an in-flight startDiscovery promise returns the same DiscoveryResult', async () => {
    const rawSpec = makeSpec({ '/a': { get: {} } })
    stubFetch({
      [`${TENANT}/user/currentUser`]: ok(makeUserResponse()),
      [`${TENANT}/application/applicationsByUser/user1?pageSize=2000`]: ok(makeAppsResponse([
        makeApp({ contextPath: 'svc', openApiSpec: 'spec.json' }),
      ])),
      [`${TENANT}/service/svc/spec.json`]: ok(rawSpec),
    })
    const [a, b] = await Promise.all([startDiscovery(TENANT, AUTH), startDiscovery(TENANT, AUTH)])
    expect(a).toEqual(b)
    expect(a.specs).toHaveLength(1)
  })

  it('two concurrent startDiscovery calls return the same promise (idempotent)', async () => {
    stubFetch({
      [`${TENANT}/user/currentUser`]: ok(makeUserResponse()),
      [`${TENANT}/application/applicationsByUser/user1?pageSize=2000`]: ok(makeAppsResponse([])),
    })
    const p1 = startDiscovery(TENANT, AUTH)
    const p2 = startDiscovery(TENANT, AUTH)
    expect(p1).toBe(p2)
    const [a, b] = await Promise.all([p1, p2])
    expect(a).toEqual(b)
  })
})

describe('refreshApiSpecs', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    bustApiSpecCache()
  })

  it('clears the existing cache and restarts discovery', async () => {
    // Seed a ready cache entry
    setCachedApiSpecs(TENANT, [{ contextPath: 'old', appLabel: 'Old', specLabel: 'Old', servicePrefix: '/service/old', spec: {} }])

    const rawSpec = makeSpec({ '/new': { get: {} } })
    stubFetch({
      [`${TENANT}/user/currentUser`]: ok(makeUserResponse()),
      [`${TENANT}/application/applicationsByUser/user1?pageSize=2000`]: ok(makeAppsResponse([
        makeApp({ contextPath: 'new', openApiSpec: 'spec.json' }),
      ])),
      [`${TENANT}/service/new/spec.json`]: ok(rawSpec),
    })

    const result = await refreshApiSpecs(TENANT, AUTH)
    expect(result.specs.map((s) => s.contextPath)).toEqual(['new'])
  })
})

describe('auto-refresh timer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    bustApiSpecCache()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    bustApiSpecCache()
  })

  it('clears the cache and restarts discovery after DISCOVERY_REFRESH_INTERVAL_MS', async () => {
    stubFetch({
      [`${TENANT}/user/currentUser`]: ok(makeUserResponse()),
      [`${TENANT}/application/applicationsByUser/user1?pageSize=2000`]: ok(makeAppsResponse([])),
    })

    // Initial discovery
    await startDiscovery(TENANT, AUTH)

    // Advance past the refresh interval
    await vi.advanceTimersByTimeAsync(DISCOVERY_REFRESH_INTERVAL_MS + 1)

    // Discovery should have restarted; while it's pending the sync cache is null
    // OR it has already resolved (since our stub resolves immediately).
    // Either way the fetch must have been called a second time.
    const fetchMock = vi.mocked(globalThis.fetch)
    // Called at least twice: once for initial, once for the scheduled refresh
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(4) // 2 requests × 2 discoveries
  })
})
