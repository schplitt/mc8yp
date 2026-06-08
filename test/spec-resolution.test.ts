import { describe, expect, it } from 'vitest'
import type { DiscoveredApiSpec } from '../src/utils/api-discovery'
import { resolveSpecs } from '../src/utils/spec-resolution'

const EMPTY_INSTALLED = new Set<string>()

function makeDiscovered(contextPath: string, spec: object = {}): DiscoveredApiSpec {
  return { contextPath, appLabel: contextPath, specLabel: contextPath, servicePrefix: `/service/${contextPath}`, spec }
}

// ---------------------------------------------------------------------------
// resolveSpecs — flat unified map (bundled + discovered services)
// ---------------------------------------------------------------------------

describe('resolveSpecs — core (always-available, no contextPath)', () => {
  it('always includes core regardless of discovery results or specRemoval', () => {
    const result = resolveSpecs([], EMPTY_INSTALLED, true)
    expect(result.core).not.toBeNull()
    expect(result.core).not.toBeUndefined()
    expect(result.core).toBeTruthy()
  })

  it('core is always true in specsEnabled (derived by buildQueryScript)', () => {
    const result = resolveSpecs([], EMPTY_INSTALLED, true)
    expect(result.core !== null).toBe(true)
  })
})

describe('resolveSpecs — output shape', () => {
  it('only bundled keys when no services discovered', () => {
    const result = resolveSpecs([], EMPTY_INSTALLED, true)
    expect(Object.keys(result)).toEqual(['core'])
  })

  it('adds non-bundled discovered services as additional flat entries', () => {
    const discovered = [makeDiscovered('svcA'), makeDiscovered('svcB')]
    const result = resolveSpecs(discovered, new Set(['svcA', 'svcB']), true)
    expect(Object.keys(result).sort()).toEqual(['core', 'svcA', 'svcB'])
    expect(result.svcA).not.toBeNull()
    expect(result.svcB).not.toBeNull()
  })

  it('non-bundled service entry value is the spec object directly', () => {
    const spec = { paths: { '/items': {} } }
    const discovered = [makeDiscovered('myservice', spec)]
    const result = resolveSpecs(discovered, new Set(['myservice']), true)
    expect(result.myservice).toEqual(spec)
  })

  it('core always present even with service discoveries', () => {
    const discovered = [makeDiscovered('svc')]
    const result = resolveSpecs(discovered, new Set(['svc']), true)
    expect(result.core).toBeTruthy()
  })
})

describe('resolveSpecs — service-backed bundled entries (e.g. dtm once added)', () => {
  it('specRemoval flag does not affect core (no contextPath = always present)', () => {
    const withRemoval = resolveSpecs([], EMPTY_INSTALLED, true)
    const withoutRemoval = resolveSpecs([], EMPTY_INSTALLED, false)
    expect(withRemoval.core).toEqual(withoutRemoval.core)
  })

  it('non-bundled discovered services are included regardless of specRemoval', () => {
    const discovered = [makeDiscovered('ext')]
    const result = resolveSpecs(discovered, new Set(['ext']), true)
    expect(result.ext).not.toBeNull()
  })
})
