import { describe, expect, it } from 'vitest'
import type { DiscoveredApiSpec } from '../src/utils/api-discovery'
import { resolveSpecs } from '../src/utils/spec-resolution'

const EMPTY_INSTALLED = new Set<string>()

function makeDiscovered(contextPath: string, spec: object = { paths: {} }): DiscoveredApiSpec {
  return { contextPath, appLabel: contextPath, specLabel: contextPath, servicePrefix: `/service/${contextPath}`, spec }
}

// ---------------------------------------------------------------------------
// resolveSpecs — { core, specs } shape, "absent key = unavailable" semantics
// ---------------------------------------------------------------------------

describe('resolveSpecs — core', () => {
  it('core is always populated regardless of discovery results or specRemoval', () => {
    const a = resolveSpecs([], EMPTY_INSTALLED, true)
    const b = resolveSpecs([], EMPTY_INSTALLED, false)
    expect(a.core).toBeTruthy()
    expect(b.core).toBeTruthy()
    expect(a.core).toEqual(b.core)
  })
})

describe('resolveSpecs — service map (bundled + discovered)', () => {
  it('omits absent bundled services from the map when specRemoval=true', () => {
    const { specs } = resolveSpecs([], EMPTY_INSTALLED, true)
    expect(specs.dtm).toBeUndefined()
    expect(Object.hasOwn(specs, 'dtm')).toBe(false)
  })

  it('adds non-bundled discovered services as additional flat entries', () => {
    const discovered = [makeDiscovered('svcA'), makeDiscovered('svcB')]
    const { specs } = resolveSpecs(discovered, new Set(['svcA', 'svcB']), true)
    expect(specs.svcA).toBeTruthy()
    expect(specs.svcB).toBeTruthy()
    expect(Object.keys(specs).sort()).toEqual(['svcA', 'svcB'])
  })

  it('non-bundled service entry value is the spec object directly', () => {
    const spec = { paths: { '/items': {} } }
    const { specs } = resolveSpecs([makeDiscovered('myservice', spec)], new Set(['myservice']), true)
    expect(specs.myservice).toEqual(spec)
  })
})

describe('resolveSpecs — dtm (bundled service spec)', () => {
  it('absent when not installed and specRemoval=true', () => {
    const { specs } = resolveSpecs([], EMPTY_INSTALLED, true)
    expect(specs.dtm).toBeUndefined()
  })

  it('bundled spec present when not installed and specRemoval=false', () => {
    const { specs } = resolveSpecs([], EMPTY_INSTALLED, false)
    expect(specs.dtm).toBeTruthy()
  })

  it('live discovered spec wins when service is installed and a live spec was found', () => {
    const liveSpec = { paths: { '/service/dtm/assets': {} } }
    const { specs } = resolveSpecs([makeDiscovered('dtm', liveSpec)], new Set(['dtm']), true)
    expect(specs.dtm).toEqual(liveSpec)
  })

  it('bundled fallback when installed but no live spec', () => {
    const { specs } = resolveSpecs([], new Set(['dtm']), true)
    expect(specs.dtm).toBeTruthy()
  })

  it('dtm with live spec is not duplicated as a non-bundled entry', () => {
    const liveSpec = { paths: { '/service/dtm/assets': {} } }
    const { specs } = resolveSpecs([makeDiscovered('dtm', liveSpec)], new Set(['dtm']), true)
    expect(Object.keys(specs).filter((k) => k === 'dtm')).toHaveLength(1)
  })
})
