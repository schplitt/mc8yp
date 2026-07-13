import { describe, expect, it } from 'vitest'
import { describeTarget } from '../src/codemode/describe'
import { getMethodIndex } from '../src/codemode/method-search'
import { buildNamespaces, toSearchableMethods } from '../src/codemode/namespaces'
import { parseRestrictionRule } from '../src/utils/restrictions'
import type { ResolvedSpecs, Spec } from '../src/utils/spec-resolution'

const CORE_SPEC = {
  info: { title: 'Cumulocity Core', description: 'The core REST surface: inventory, alarms, events.' },
  tags: [{ name: 'Alarms', description: 'Alarm domain docs.' }],
  paths: {
    '/alarm/alarms': {
      get: {
        operationId: 'getAlarmCollectionResource',
        summary: 'Retrieve all alarms',
        tags: ['Alarms'],
        parameters: [{ name: 'severity', in: 'query', schema: { type: 'string' }, description: 'Severity filter' }],
        responses: { 200: { content: { 'application/json': { schema: { type: 'object', properties: { alarms: { type: 'array', items: { type: 'object' } } } } } } } },
      },
    },
    '/alarm/alarms/{id}': {
      delete: { operationId: 'deleteAlarmResource', summary: 'Delete an alarm' },
    },
  },
} as unknown as Spec

const DTM_SPEC = {
  paths: {
    '/service/dtm/assets': {
      get: { operationId: 'getAssets', summary: 'List assets' },
    },
  },
} as unknown as Spec

function resolved(): ResolvedSpecs {
  return { core: CORE_SPEC, specs: { dtm: DTM_SPEC } }
}

describe('buildNamespaces', () => {
  it('names core c8y and services by sanitized contextPath', () => {
    const namespaces = buildNamespaces(resolved())
    expect(namespaces.map((ns) => ns.name)).toEqual(['c8y', 'dtm'])
    expect(namespaces[0]!.operations.map((o) => o.name)).toEqual(['getAlarmCollectionResource', 'deleteAlarmResource'])
  })

  it('skips services that collide with reserved namespaces', () => {
    const withReserved: ResolvedSpecs = { core: CORE_SPEC, specs: { codemode: DTM_SPEC, docs: DTM_SPEC } }
    expect(buildNamespaces(withReserved).map((ns) => ns.name)).toEqual(['c8y'])
  })

  it('omits policy-blocked operations from namespaces', () => {
    const { parsedRules } = parseRestrictionRule(['DELETE:/alarm/**'])
    const namespaces = buildNamespaces(resolved(), parsedRules)
    expect(namespaces[0]!.operations.map((o) => o.name)).toEqual(['getAlarmCollectionResource'])
  })

  it('honours allow lists', () => {
    const allow = parseRestrictionRule(['GET:/service/dtm/**'])
    const namespaces = buildNamespaces(resolved(), [], allow.parsedRules)
    expect(namespaces.find((ns) => ns.name === 'c8y')!.operations).toHaveLength(0)
    expect(namespaces.find((ns) => ns.name === 'dtm')!.operations).toHaveLength(1)
  })
})

describe('describeTarget', () => {
  const namespaces = buildNamespaces(resolved())
  const methodIndex = getMethodIndex({}, () => toSearchableMethods(namespaces))

  it('renders an overview when no target is given', () => {
    const output = describeTarget(namespaces, methodIndex)
    expect(output.kind).toBe('overview')
    expect(output.content).toContain('c8y — Cumulocity Core (2 methods): The core REST surface: inventory, alarms, events.')
    expect(output.content).toContain('dtm')
    expect(output.content).toContain('codemode.search')
  })

  it('rejects namespace-only targets and redirects to search', () => {
    const output = describeTarget(namespaces, methodIndex, 'c8y')
    expect(output.kind).toBe('method')
    expect(output.content).toContain('not a method target')
    expect(output.content).toContain('codemode.search')
    // No method dump — the listing must not leak through the redirect.
    expect(output.content).not.toContain('Retrieve all alarms')
  })

  it('renders lean types with JSDoc and doc pointers for a method target', () => {
    const output = describeTarget(namespaces, methodIndex, 'c8y.getAlarmCollectionResource')
    expect(output.kind).toBe('method')
    expect(output.content).toContain('GET /alarm/alarms — Retrieve all alarms')
    expect(output.content).toContain('c8y.getAlarmCollectionResource(input: GetAlarmCollectionResourceInput): Promise<GetAlarmCollectionResourceOutput>')
    expect(output.content).toContain('type GetAlarmCollectionResourceInput =')
    expect(output.content).toContain('/** Severity filter */')
    expect(output.content).toContain('type GetAlarmCollectionResourceOutput =')
    expect(output.content).toContain('docs.read("c8y::topic::Alarms")')
    // Lean output: no declare-const wrapper, no @param duplication.
    expect(output.content).not.toContain('declare const')
    expect(output.content).not.toContain('@param')
  })

  it('resolves bare method names across namespaces', () => {
    const output = describeTarget(namespaces, methodIndex, 'getAssets')
    expect(output.target).toBe('dtm.getAssets')
    expect(output.kind).toBe('method')
  })

  it('suggests close matches for unknown targets', () => {
    const output = describeTarget(namespaces, methodIndex, 'c8y.getAlarmCollection')
    expect(output.content).toContain('not a method target')
    expect(output.content).toContain('c8y.getAlarmCollectionResource')
  })
})
