import { describe, expect, it } from 'vitest'
import type { DiscoveredApiSpec } from '../src/utils/capability-discovery'
import { getBundledOnlyCapabilities, resolveCapabilities } from '../src/utils/capability-resolution'

const EMPTY_INSTALLED = new Set<string>()

function makeDiscovered(contextPath: string, spec: object = { paths: {} }): DiscoveredApiSpec {
  return { contextPath, appLabel: contextPath, specLabel: contextPath, servicePrefix: `/service/${contextPath}`, spec }
}

// ---------------------------------------------------------------------------
// resolveCapabilities — { core, specs } shape, "absent key = unavailable" semantics.
// Spec removal is unconditional for an active tenant; there is no flag.
// ---------------------------------------------------------------------------

describe('resolveCapabilities — core', () => {
  it('core is always populated regardless of discovery results', () => {
    const a = resolveCapabilities([], EMPTY_INSTALLED)
    const b = resolveCapabilities([makeDiscovered('svcA')], new Set(['svcA']))
    expect(a.core).toBeTruthy()
    expect(b.core).toBeTruthy()
    expect(a.core).toEqual(b.core)
  })
})

describe('resolveCapabilities — service map (bundled + discovered)', () => {
  it('omits absent bundled services from the map', () => {
    const { specs } = resolveCapabilities([], EMPTY_INSTALLED)
    expect(specs.dtm).toBeUndefined()
    expect(Object.hasOwn(specs, 'dtm')).toBe(false)
  })

  it('adds non-bundled discovered services as additional flat entries', () => {
    const discovered = [makeDiscovered('svcA'), makeDiscovered('svcB')]
    const { specs } = resolveCapabilities(discovered, new Set(['svcA', 'svcB']))
    expect(specs.svcA).toBeTruthy()
    expect(specs.svcB).toBeTruthy()
    expect(Object.keys(specs).sort()).toEqual(['svcA', 'svcB'])
  })

  it('non-bundled service entry value is the spec object directly', () => {
    const spec = { paths: { '/items': {} } }
    const { specs } = resolveCapabilities([makeDiscovered('myservice', spec)], new Set(['myservice']))
    expect(specs.myservice).toEqual(spec)
  })
})

describe('resolveCapabilities — dtm (bundled service spec)', () => {
  it('absent when not installed on the tenant', () => {
    const { specs } = resolveCapabilities([], EMPTY_INSTALLED)
    expect(specs.dtm).toBeUndefined()
  })

  it('live discovered spec wins when service is installed and a live spec was found', () => {
    const liveSpec = { paths: { '/service/dtm/assets': {} } }
    const { specs } = resolveCapabilities([makeDiscovered('dtm', liveSpec)], new Set(['dtm']))
    expect(specs.dtm).toEqual(liveSpec)
  })

  it('bundled fallback when installed but no live spec', () => {
    const { specs } = resolveCapabilities([], new Set(['dtm']))
    expect(specs.dtm).toBeTruthy()
  })

  it('dtm with live spec is not duplicated as a non-bundled entry', () => {
    const liveSpec = { paths: { '/service/dtm/assets': {} } }
    const { specs } = resolveCapabilities([makeDiscovered('dtm', liveSpec)], new Set(['dtm']))
    expect(Object.keys(specs).filter((k) => k === 'dtm')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// getBundledOnlyCapabilities — explicit "browse the bundled surface" path used by
// the CLI when no tenant is active. No discovery, no removal.
// ---------------------------------------------------------------------------

describe('getBundledOnlyCapabilities', () => {
  it('returns every bundled service spec regardless of tenant installation state', () => {
    const { core, specs } = getBundledOnlyCapabilities()
    expect(core).toBeTruthy()
    expect(specs.dtm).toBeTruthy()
  })

  it('produces the same core spec as resolveCapabilities', () => {
    expect(getBundledOnlyCapabilities().core).toEqual(resolveCapabilities([], EMPTY_INSTALLED).core)
  })
})

describe('resolveCapabilities — identity memoization', () => {
  it('returns the same object for the same discovery inputs', () => {
    const discovered = [makeDiscovered('svcA')]
    const installed = new Set(['svcA'])
    expect(resolveCapabilities(discovered, installed)).toBe(resolveCapabilities(discovered, installed))
  })

  it('returns a fresh object when either input changes identity', () => {
    const discovered = [makeDiscovered('svcA')]
    const installed = new Set(['svcA'])
    const resolved = resolveCapabilities(discovered, installed)
    expect(resolveCapabilities([makeDiscovered('svcA')], installed)).not.toBe(resolved)
    expect(resolveCapabilities(discovered, new Set(['svcA']))).not.toBe(resolved)
  })
})
