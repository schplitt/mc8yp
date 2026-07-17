import { afterEach, describe, expect, it } from 'vitest'
import type { Client } from '@c8y/client'
import {
  bustCapabilityCache,
  discoverTenantCapabilities,
  refreshCapabilities,
  setCachedCapabilities,
  startDiscovery,
} from '../src/utils/capability-discovery'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TENANT_ID = 't12345'

interface MockApp {
  id?: string
  name?: string
  contextPath?: string
  manifest?: { openApiSpec?: string | Array<{ label: string, path: string }> }
}

interface MockResponses {
  /**
   * Applications subscribed to the tenant, or an error shape.
   */
  apps?: MockApp[] | { status: number, statusText: string }
  /**
   * Map of (path-from-baseUrl) -> response for `client.core.fetch(path)`.
   */
  coreFetch?: Record<string, { ok: boolean, status?: number, statusText?: string, json?: () => Promise<unknown> } | Error>
}

function makeApp(overrides: Partial<MockApp> & {
  openApiSpec?: MockApp['manifest'] extends infer M ? (M extends { openApiSpec?: infer O } ? O : never) : never
} = {}): MockApp {
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

interface ListFilter {
  tenant?: string
  type?: string
  pageSize: number
  currentPage: number
}

/**
 * Build a fake Cumulocity client surface. discoverTenantCapabilities only touches
 * `client.application.list(filter)` and `client.core.fetch(path)` — a minimal
 * shape covering those two is enough. `apps` is the full applications set;
 * the mock slices it by the filter's pageSize/currentPage so the production
 * pagination loop is exercised for real.
 * @param responses - Per-call response specification (apps, coreFetch)
 * @param listCalls - When provided, every `application.list` filter is pushed
 *   here so tests can assert query params and page count
 */
function mockClient(responses: MockResponses, listCalls?: ListFilter[]): Client {
  const isErrorShape = (v: unknown): v is { status: number, statusText: string } =>
    !!v && typeof v === 'object' && 'status' in v && 'statusText' in v

  return {
    application: {
      list: (filter: ListFilter) => {
        listCalls?.push(filter)
        const a = responses.apps
        if (isErrorShape(a)) {
          // eslint-disable-next-line prefer-promise-reject-errors -- mimics @c8y/client's `{ res, data }` reject shape
          return Promise.reject({ res: { status: a.status, statusText: a.statusText } })
        }
        const start = (filter.currentPage - 1) * filter.pageSize
        return Promise.resolve({ data: (a ?? []).slice(start, start + filter.pageSize) })
      },
    },
    core: {
      fetch: (path: string) => {
        const entry = responses.coreFetch?.[path]
        if (entry instanceof Error)
          return Promise.reject(entry)
        if (!entry)
          return Promise.resolve({ ok: false, status: 404, statusText: 'Not Found', json: () => Promise.resolve({}) } as unknown as Response)
        return Promise.resolve({
          ok: entry.ok,
          status: entry.status ?? (entry.ok ? 200 : 500),
          statusText: entry.statusText ?? (entry.ok ? 'OK' : 'Error'),
          json: entry.json ?? (() => Promise.resolve({})),
        } as unknown as Response)
      },
    },
  } as unknown as Client
}

function specOk(body: unknown) {
  return { ok: true, status: 200, statusText: 'OK', json: () => Promise.resolve(body) }
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

describe('spec cache', () => {
  afterEach(() => bustCapabilityCache())

  it('stores and retrieves a DiscoveryResult by awaiting the cached promise', async () => {
    const specs = [{ contextPath: 'svc', appLabel: 'Svc', specLabel: 'Svc', servicePrefix: '/service/svc', spec: {} }]
    setCachedCapabilities(TENANT_ID, specs)
    const result = await startDiscovery(TENANT_ID, mockClient({}))
    expect(result.specs).toEqual(specs)
  })

  it('busts a specific tenant cache — startDiscovery triggers fresh discovery after bust', async () => {
    const seeded = [{ contextPath: 'svc', appLabel: 'Svc', specLabel: 'Svc', servicePrefix: '/service/svc', spec: {} }]
    setCachedCapabilities(TENANT_ID, seeded)
    bustCapabilityCache(TENANT_ID)
    // After bust, the cache is empty — the next startDiscovery must run
    // real discovery against the client, which now returns no apps.
    const result = await startDiscovery(TENANT_ID, mockClient({}))
    expect(result.specs).toEqual([])
  })

  it('busts all caches when called without arguments', async () => {
    setCachedCapabilities(TENANT_ID, [])
    setCachedCapabilities('t99999', [])
    bustCapabilityCache()
    // Both entries must be gone — re-seed and verify both promises are fresh
    setCachedCapabilities(TENANT_ID, [])
    setCachedCapabilities('t99999', [])
    expect(await startDiscovery(TENANT_ID, mockClient({}))).toEqual({ specs: [], mcpServers: [], installedContextPaths: new Set() })
    expect(await startDiscovery('t99999', mockClient({}))).toEqual({ specs: [], mcpServers: [], installedContextPaths: new Set() })
  })
})

// ---------------------------------------------------------------------------
// discoverTenantCapabilities
// ---------------------------------------------------------------------------

describe('discoverTenantCapabilities', () => {
  afterEach(() => bustCapabilityCache())

  it('returns empty specs when no apps have openApiSpec in manifest, but the app is in installedContextPaths', async () => {
    const result = await discoverTenantCapabilities(mockClient({
      apps: [makeApp({ openApiSpec: undefined })],
    }), TENANT_ID)
    expect(result.specs).toEqual([])
    expect(result.installedContextPaths.has('myservice')).toBe(true)
  })

  it('downloads and path-prefixes a spec for a string openApiSpec entry', async () => {
    const rawSpec = makeSpec({ '/things': { get: { summary: 'List things' } } })
    const result = await discoverTenantCapabilities(mockClient({
      apps: [makeApp({ contextPath: 'myservice', openApiSpec: 'openapi.json' })],
      coreFetch: { '/service/myservice/openapi.json': specOk(rawSpec) },
    }), TENANT_ID)
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
    const result = await discoverTenantCapabilities(mockClient({
      apps: [makeApp({
        contextPath: 'multi',
        openApiSpec: [
          { label: 'Alpha API', path: 'alpha.json' },
          { label: 'Beta API', path: 'beta.json' },
        ],
      })],
      coreFetch: {
        '/service/multi/alpha.json': specOk(specA),
        '/service/multi/beta.json': specOk(specB),
      },
    }), TENANT_ID)
    expect(result.specs).toHaveLength(2)
    expect(result.specs.map((s) => s.specLabel)).toEqual(['Alpha API', 'Beta API'])
    expect(result.specs.every((s) => s.contextPath === 'multi')).toBe(true)
  })

  it('strips leading slash from manifest spec path before building URL', async () => {
    const rawSpec = makeSpec({ '/items': { get: {} } })
    const result = await discoverTenantCapabilities(mockClient({
      apps: [makeApp({ contextPath: 'svc', openApiSpec: '/spec.json' })],
      coreFetch: { '/service/svc/spec.json': specOk(rawSpec) },
    }), TENANT_ID)
    expect(result.specs).toHaveLength(1)
    expect((result.specs[0]!.spec as { paths: Record<string, unknown> }).paths['/service/svc/items']).toBeDefined()
  })

  it('skips apps without a contextPath — they do not appear in installedContextPaths', async () => {
    const result = await discoverTenantCapabilities(mockClient({
      apps: [{ id: 'x', name: 'No Context', manifest: { openApiSpec: 'spec.json' } }],
    }), TENANT_ID)
    expect(result.specs).toEqual([])
    expect(result.installedContextPaths.size).toBe(0)
  })

  it('skips a spec when the download request fails with a non-ok status', async () => {
    const result = await discoverTenantCapabilities(mockClient({
      apps: [makeApp({ contextPath: 'broken', openApiSpec: 'spec.json' })],
      coreFetch: { '/service/broken/spec.json': { ok: false, status: 503, statusText: 'Service Unavailable' } },
    }), TENANT_ID)
    expect(result.specs).toHaveLength(0)
    expect(result.installedContextPaths.has('broken')).toBe(true)
  })

  it('skips a spec when the download throws a network error', async () => {
    const result = await discoverTenantCapabilities(mockClient({
      apps: [makeApp({ contextPath: 'neterr', openApiSpec: 'spec.json' })],
      coreFetch: { '/service/neterr/spec.json': new Error('Network error') },
    }), TENANT_ID)
    expect(result.specs).toHaveLength(0)
    expect(result.installedContextPaths.has('neterr')).toBe(true)
  })

  it('throws when two different apps share the same contextPath', async () => {
    await expect(discoverTenantCapabilities(mockClient({
      apps: [
        makeApp({ id: 'app1', name: 'Service One', contextPath: 'shared', openApiSpec: 'spec.json' }),
        makeApp({ id: 'app2', name: 'Service Two', contextPath: 'shared', openApiSpec: 'spec.json' }),
      ],
    }), TENANT_ID)).rejects.toThrow(
      'Two subscribed applications share context path "shared": "Service One" and "Service Two"',
    )
  })

  it('does not throw when the same app appears twice in the list (same name, same contextPath)', async () => {
    const rawSpec = makeSpec({ '/a': { get: {} } })
    const app = makeApp({ contextPath: 'dup', openApiSpec: 'spec.json' })
    const result = await discoverTenantCapabilities(mockClient({
      apps: [app, app],
      coreFetch: { '/service/dup/spec.json': specOk(rawSpec) },
    }), TENANT_ID)
    expect(result.specs).toHaveLength(1)
  })

  it('throws when fetching the application list fails', async () => {
    await expect(discoverTenantCapabilities(mockClient({
      apps: { status: 500, statusText: 'Internal Server Error' },
    }), TENANT_ID)).rejects.toThrow('Failed to fetch applications: 500')
  })

  it('queries the applications endpoint filtered by tenant and type MICROSERVICE', async () => {
    const listCalls: ListFilter[] = []
    await discoverTenantCapabilities(mockClient({ apps: [makeApp()] }, listCalls), TENANT_ID)
    expect(listCalls).toHaveLength(1)
    expect(listCalls[0]).toMatchObject({
      tenant: TENANT_ID,
      type: 'MICROSERVICE',
      currentPage: 1,
    })
  })

  it('aggregates all pages when the applications listing spans multiple pages', async () => {
    const listCalls: ListFilter[] = []
    // 100-per-page production page size → 250 apps means 3 pages, the last one short.
    const apps = Array.from({ length: 250 }, (_, i) =>
      makeApp({ id: `app${i}`, name: `Service ${i}`, contextPath: `svc${i}`, openApiSpec: undefined }))
    const result = await discoverTenantCapabilities(mockClient({ apps }, listCalls), TENANT_ID)
    expect(listCalls.map((c) => c.currentPage)).toEqual([1, 2, 3])
    expect(result.installedContextPaths.size).toBe(250)
  })

  it('stops paginating after the first short page', async () => {
    const listCalls: ListFilter[] = []
    await discoverTenantCapabilities(mockClient({ apps: [makeApp(), makeApp({ id: 'app2', name: 'Other', contextPath: 'other' })] }, listCalls), TENANT_ID)
    expect(listCalls).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// startDiscovery
// ---------------------------------------------------------------------------

describe('startDiscovery', () => {
  afterEach(() => bustCapabilityCache())

  it('returns a promise that resolves with a DiscoveryResult', async () => {
    const rawSpec = makeSpec({ '/things': { get: {} } })
    const promise = startDiscovery(TENANT_ID, mockClient({
      apps: [makeApp({ contextPath: 'svc', openApiSpec: 'spec.json' })],
      coreFetch: { '/service/svc/spec.json': specOk(rawSpec) },
    }))
    expect(promise).toBeInstanceOf(Promise)
    const result = await promise
    expect(result.specs).toHaveLength(1)
    expect(result.specs[0]!.contextPath).toBe('svc')
    expect(result.installedContextPaths.has('svc')).toBe(true)
  })

  it('is idempotent — returns the same in-flight promise on concurrent calls', () => {
    // A never-resolving client keeps the discovery promise pending forever.
    const stuck = { application: { list: () => new Promise(() => {}) } } as unknown as Client
    const p1 = startDiscovery(TENANT_ID, stuck)
    const p2 = startDiscovery(TENANT_ID, stuck)
    expect(p1).toBe(p2)
  })

  it('returns a resolved promise immediately when cache is already ready', async () => {
    setCachedCapabilities(TENANT_ID, [])
    // A client whose methods would throw if called proves the cache short-circuited.
    const boom = {
      application: {
        list: () => {
          throw new Error('should not be called')
        },
      },
    } as unknown as Client
    const result = await startDiscovery(TENANT_ID, boom)
    expect(result.specs).toEqual([])
  })

  it('propagates the failure and removes the in-flight entry so the next call retries', async () => {
    let calls = 0
    const failing = {
      application: {
        list: () => {
          calls += 1
          // eslint-disable-next-line prefer-promise-reject-errors -- mimics @c8y/client's `{ res, data }` reject shape
          return Promise.reject({ res: { status: 403, statusText: 'Forbidden' } })
        },
      },
    } as unknown as Client

    await expect(startDiscovery(TENANT_ID, failing)).rejects.toThrow('Failed to fetch applications: 403')
    // A failed discovery must NOT poison the cache; the next call retries.
    await expect(startDiscovery(TENANT_ID, failing)).rejects.toThrow('Failed to fetch applications: 403')
    expect(calls).toBe(2)
  })

  it('keeps a prior cached result if it exists — a failed discovery does not overwrite it', async () => {
    const goodSpecs = [{ contextPath: 'svc', appLabel: 'Svc', specLabel: 'Svc', servicePrefix: '/service/svc', spec: {} }]
    setCachedCapabilities(TENANT_ID, goodSpecs)
    // A client that would reject if called: cache hit short-circuits it.
    const wouldFail = {
      application: { list: () => Promise.reject(new Error('should not be called')) },
    } as unknown as Client
    const result = await startDiscovery(TENANT_ID, wouldFail)
    expect(result.specs).toEqual(goodSpecs)
  })

  it('resolved DiscoveryResult contains installedContextPaths for apps without a spec URL', async () => {
    const result = await startDiscovery(TENANT_ID, mockClient({
      apps: [makeApp({ contextPath: 'svc-no-spec', openApiSpec: undefined })],
    }))
    expect(result.specs).toEqual([])
    expect(result.installedContextPaths.has('svc-no-spec')).toBe(true)
  })
})

describe('awaiting startDiscovery', () => {
  afterEach(() => bustCapabilityCache())

  it('returns empty DiscoveryResult when discovery finds nothing', async () => {
    const result = await startDiscovery(TENANT_ID, mockClient({}))
    expect(result.specs).toEqual([])
    expect(result.installedContextPaths.size).toBe(0)
  })

  it('two concurrent startDiscovery calls return the same promise (idempotent)', async () => {
    const client = mockClient({})
    const p1 = startDiscovery(TENANT_ID, client)
    const p2 = startDiscovery(TENANT_ID, client)
    expect(p1).toBe(p2)
    const [a, b] = await Promise.all([p1, p2])
    expect(a).toEqual(b)
  })
})

describe('refreshCapabilities', () => {
  afterEach(() => bustCapabilityCache())

  it('clears the existing cache and restarts discovery', async () => {
    setCachedCapabilities(TENANT_ID, [{ contextPath: 'old', appLabel: 'Old', specLabel: 'Old', servicePrefix: '/service/old', spec: {} }])

    const rawSpec = makeSpec({ '/new': { get: {} } })
    const result = await refreshCapabilities(TENANT_ID, mockClient({
      apps: [makeApp({ contextPath: 'new', openApiSpec: 'spec.json' })],
      coreFetch: { '/service/new/spec.json': specOk(rawSpec) },
    }))
    expect(result.specs.map((s) => s.contextPath)).toEqual(['new'])
  })
})
