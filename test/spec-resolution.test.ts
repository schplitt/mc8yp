import { describe, expect, it } from 'vitest'
import type { DiscoveredApiSpec } from '../src/utils/api-discovery'
import { resolveSpecs } from '../src/utils/spec-resolution'

const EMPTY_INSTALLED = new Set<string>()

function makeDiscovered(contextPath: string, spec: object = {}): DiscoveredApiSpec {
  return { contextPath, appLabel: contextPath, specLabel: contextPath, servicePrefix: `/service/${contextPath}`, spec }
}

// ---------------------------------------------------------------------------
// resolveSpecs — returns { specs, specsEnabled }
// ---------------------------------------------------------------------------

describe('resolveSpecs — core (always-available)', () => {
  it('always includes core regardless of discovery results or specRemoval', () => {
    const { specs, specsEnabled } = resolveSpecs([], EMPTY_INSTALLED, true)
    expect(specs.core).toBeTruthy()
    expect(specsEnabled.core).toBe(true)
  })

  it('core never depends on specRemoval', () => {
    const a = resolveSpecs([], EMPTY_INSTALLED, true)
    const b = resolveSpecs([], EMPTY_INSTALLED, false)
    expect(a.specs.core).toEqual(b.specs.core)
    expect(a.specsEnabled.core).toBe(true)
    expect(b.specsEnabled.core).toBe(true)
  })
})

describe('resolveSpecs — bundled service-backed entries (currently dtm)', () => {
  it('A: live discovered dtm spec → uses the live spec', () => {
    const liveSpec = { paths: { '/service/dtm/live': {} } }
    const discovered = [makeDiscovered('dtm', liveSpec)]
    const { specs, specsEnabled } = resolveSpecs(discovered, new Set(['dtm']), true)
    expect(specs.dtm).toEqual(liveSpec)
    expect(specsEnabled.dtm).toBe(true)
  })

  it('B: dtm installed but no live spec → uses bundled fallback', () => {
    const { specs, specsEnabled } = resolveSpecs([], new Set(['dtm']), true)
    expect(specs.dtm).not.toBeNull()
    expect(specs.dtm).toBeTruthy()
    expect(specsEnabled.dtm).toBe(true)
  })

  it('C: dtm not installed + specRemoval=true → null', () => {
    const { specs, specsEnabled } = resolveSpecs([], EMPTY_INSTALLED, true)
    expect(specs.dtm).toBeNull()
    expect(specsEnabled.dtm).toBe(false)
  })

  it('C: dtm not installed + specRemoval=false → bundled spec kept for reference', () => {
    const { specs, specsEnabled } = resolveSpecs([], EMPTY_INSTALLED, false)
    expect(specs.dtm).not.toBeNull()
    expect(specs.dtm).toBeTruthy()
    // specsEnabled still false: the spec is visible but the service is absent
    expect(specsEnabled.dtm).toBe(false)
  })

  it('dtm appears exactly once even when both bundled and live exist', () => {
    const liveSpec = { paths: { '/service/dtm/live': {} } }
    const discovered = [makeDiscovered('dtm', liveSpec)]
    const { specs } = resolveSpecs(discovered, new Set(['dtm']), true)
    // dtm key is present once; bundled fallback is not duplicated under any other key
    expect(specs.dtm).toEqual(liveSpec)
    expect(Object.keys(specs).filter((k) => k === 'dtm')).toHaveLength(1)
  })
})

describe('resolveSpecs — non-bundled discovered services', () => {
  it('adds non-bundled discovered services as additional flat entries', () => {
    const discovered = [makeDiscovered('svcA'), makeDiscovered('svcB')]
    const { specs } = resolveSpecs(discovered, new Set(['svcA', 'svcB']), true)
    expect(Object.keys(specs).sort()).toEqual(['core', 'dtm', 'svcA', 'svcB'])
    expect(specs.svcA).not.toBeNull()
    expect(specs.svcB).not.toBeNull()
  })

  it('non-bundled service value is the spec object directly', () => {
    const spec = { paths: { '/items': {} } }
    const discovered = [makeDiscovered('myservice', spec)]
    const { specs } = resolveSpecs(discovered, new Set(['myservice']), true)
    expect(specs.myservice).toEqual(spec)
  })

  it('non-bundled services are included regardless of specRemoval', () => {
    const discovered = [makeDiscovered('ext')]
    const a = resolveSpecs(discovered, new Set(['ext']), true)
    const b = resolveSpecs(discovered, new Set(['ext']), false)
    expect(a.specs.ext).not.toBeNull()
    expect(b.specs.ext).not.toBeNull()
  })

  it('specsEnabled does NOT include non-bundled services', () => {
    // specsEnabled is a fixed-key map of known bundled services; unknown
    // services have to be checked via Object.hasOwn(serviceSpecs, key) instead.
    const discovered = [makeDiscovered('arbitrary')]
    const { specsEnabled } = resolveSpecs(discovered, new Set(['arbitrary']), true)
    expect(Object.keys(specsEnabled).sort()).toEqual(['core', 'dtm'])
  })
})
