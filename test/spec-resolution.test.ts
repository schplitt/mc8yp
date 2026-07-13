import { describe, expect, it } from 'vitest'
import type { DiscoveredApiSpec } from '../src/utils/api-discovery'
import { getBundledOnlySpecs, resolveSpecs } from '../src/utils/spec-resolution'

const EMPTY_INSTALLED = new Set<string>()

function makeDiscovered(contextPath: string, spec: object = { paths: {} }): DiscoveredApiSpec {
  return { contextPath, appLabel: contextPath, specLabel: contextPath, servicePrefix: `/service/${contextPath}`, spec }
}

// ---------------------------------------------------------------------------
// resolveSpecs — { core, specs } shape, "absent key = unavailable" semantics.
// Spec removal is unconditional for an active tenant; there is no flag.
// ---------------------------------------------------------------------------

describe('resolveSpecs — core', () => {
  it('core is always populated regardless of discovery results', () => {
    const a = resolveSpecs([], EMPTY_INSTALLED)
    const b = resolveSpecs([makeDiscovered('svcA')], new Set(['svcA']))
    expect(a.core).toBeTruthy()
    expect(b.core).toBeTruthy()
    expect(a.core).toEqual(b.core)
  })
})

describe('resolveSpecs — service map (bundled + discovered)', () => {
  it('omits absent bundled services from the map', () => {
    const { specs } = resolveSpecs([], EMPTY_INSTALLED)
    expect(specs.dtm).toBeUndefined()
    expect(Object.hasOwn(specs, 'dtm')).toBe(false)
  })

  it('adds non-bundled discovered services as additional flat entries', () => {
    const discovered = [makeDiscovered('svcA'), makeDiscovered('svcB')]
    const { specs } = resolveSpecs(discovered, new Set(['svcA', 'svcB']))
    expect(specs.svcA).toBeTruthy()
    expect(specs.svcB).toBeTruthy()
    expect(Object.keys(specs).sort()).toEqual(['svcA', 'svcB'])
  })

  it('non-bundled service entry value is the spec object directly', () => {
    const spec = { paths: { '/items': {} } }
    const { specs } = resolveSpecs([makeDiscovered('myservice', spec)], new Set(['myservice']))
    expect(specs.myservice).toEqual(spec)
  })
})

describe('resolveSpecs — dtm (bundled service spec)', () => {
  it('absent when not installed on the tenant', () => {
    const { specs } = resolveSpecs([], EMPTY_INSTALLED)
    expect(specs.dtm).toBeUndefined()
  })

  it('live discovered spec wins when service is installed and a live spec was found', () => {
    const liveSpec = { paths: { '/service/dtm/assets': {} } }
    const { specs } = resolveSpecs([makeDiscovered('dtm', liveSpec)], new Set(['dtm']))
    expect(specs.dtm).toEqual(liveSpec)
  })

  it('bundled fallback when installed but no live spec', () => {
    const { specs } = resolveSpecs([], new Set(['dtm']))
    expect(specs.dtm).toBeTruthy()
  })

  it('dtm with live spec is not duplicated as a non-bundled entry', () => {
    const liveSpec = { paths: { '/service/dtm/assets': {} } }
    const { specs } = resolveSpecs([makeDiscovered('dtm', liveSpec)], new Set(['dtm']))
    expect(Object.keys(specs).filter((k) => k === 'dtm')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// getBundledOnlySpecs — explicit "browse the bundled surface" path used by
// the CLI when no tenant is active. No discovery, no removal.
// ---------------------------------------------------------------------------

describe('getBundledOnlySpecs', () => {
  it('returns every bundled service spec regardless of tenant installation state', () => {
    const { core, specs } = getBundledOnlySpecs()
    expect(core).toBeTruthy()
    expect(specs.dtm).toBeTruthy()
  })

  it('produces the same core spec as resolveSpecs', () => {
    expect(getBundledOnlySpecs().core).toEqual(resolveSpecs([], EMPTY_INSTALLED).core)
  })
})

describe('resolveSpecs — identity memoization', () => {
  it('returns the same object for the same discovery inputs', () => {
    const discovered = [makeDiscovered('svcA')]
    const installed = new Set(['svcA'])
    expect(resolveSpecs(discovered, installed)).toBe(resolveSpecs(discovered, installed))
  })

  it('returns a fresh object when either input changes identity', () => {
    const discovered = [makeDiscovered('svcA')]
    const installed = new Set(['svcA'])
    const resolved = resolveSpecs(discovered, installed)
    expect(resolveSpecs([makeDiscovered('svcA')], installed)).not.toBe(resolved)
    expect(resolveSpecs(discovered, new Set(['svcA']))).not.toBe(resolved)
  })
})
