import { describe, expect, it } from 'vitest'
import type { DiscoveredApiSpec, DiscoveredMcpServer } from '../src/utils/capability-discovery'
import { getCoreOnlyCapabilities, resolveCapabilities } from '../src/utils/capability-resolution'

function makeDiscovered(contextPath: string, spec: object = { paths: {} }): DiscoveredApiSpec {
  return { contextPath, appLabel: contextPath, specLabel: contextPath, servicePrefix: `/service/${contextPath}`, spec }
}

// ---------------------------------------------------------------------------
// resolveCapabilities — core is bundled, every service comes from discovery.
// ---------------------------------------------------------------------------

describe('resolveCapabilities — core', () => {
  it('core is always populated regardless of discovery results', () => {
    const a = resolveCapabilities([])
    const b = resolveCapabilities([makeDiscovered('svcA')])
    expect(a.core).toBeTruthy()
    expect(b.core).toBeTruthy()
    expect(a.core).toEqual(b.core)
  })
})

describe('resolveCapabilities — service map', () => {
  it('is empty when discovery found nothing', () => {
    expect(resolveCapabilities([]).specs).toEqual({})
  })

  it('has one entry per discovered service, keyed by contextPath', () => {
    const { specs } = resolveCapabilities([makeDiscovered('svcA'), makeDiscovered('svcB')])
    expect(Object.keys(specs).sort()).toEqual(['svcA', 'svcB'])
  })

  it('entry value is the discovered spec object directly', () => {
    const spec = { paths: { '/items': {} } }
    const { specs } = resolveCapabilities([makeDiscovered('myservice', spec)])
    expect(specs.myservice).toEqual(spec)
  })

  it('bundles no service specs: a service without a live spec gets no entry', () => {
    // dtm used to ship as a bundled fallback; it is discovery-only now.
    expect(Object.hasOwn(resolveCapabilities([]).specs, 'dtm')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// getCoreOnlyCapabilities — the CLI's no-tenant fallback.
// ---------------------------------------------------------------------------

describe('getCoreOnlyCapabilities', () => {
  it('returns core and no service specs or MCP servers', () => {
    const { core, specs, mcpServers } = getCoreOnlyCapabilities()
    expect(core).toBeTruthy()
    expect(specs).toEqual({})
    expect(mcpServers).toEqual({})
  })

  it('produces the same core spec as resolveCapabilities', () => {
    expect(getCoreOnlyCapabilities().core).toEqual(resolveCapabilities([]).core)
  })
})

describe('resolveCapabilities — identity memoization', () => {
  it('returns the same object for the same discovery inputs', () => {
    const discovered = [makeDiscovered('svcA')]
    const mcp: DiscoveredMcpServer[] = []
    expect(resolveCapabilities(discovered, mcp)).toBe(resolveCapabilities(discovered, mcp))
  })

  it('returns the same object when MCP servers are omitted', () => {
    const discovered = [makeDiscovered('svcA')]
    expect(resolveCapabilities(discovered)).toBe(resolveCapabilities(discovered))
  })

  it('returns a fresh object when either input changes identity', () => {
    const discovered = [makeDiscovered('svcA')]
    const mcp: DiscoveredMcpServer[] = []
    const resolved = resolveCapabilities(discovered, mcp)
    expect(resolveCapabilities([makeDiscovered('svcA')], mcp)).not.toBe(resolved)
    expect(resolveCapabilities(discovered, [])).not.toBe(resolved)
  })
})
