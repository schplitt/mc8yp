import { describe, expect, it } from 'vitest'
import { buildSpecDocs, getDocsIndex, readDoc, searchDocs } from '../src/codemode/docs-index'
import type { DocsIndexEntry } from '../src/codemode/docs-index'

const CORE_SPEC = {
  info: { title: 'Cumulocity Core', description: 'The core REST API.' },
  tags: [
    { name: 'Alarms', description: 'Alarm handling. Query grammar: severity eq MAJOR, status eq ACTIVE.' },
    { name: 'Inventory', description: 'Managed objects. The query parameter accepts the Cumulocity query language, e.g. $filter=(type eq c8y_Device).' },
  ],
  paths: {
    '/alarm/alarms': {
      get: {
        operationId: 'getAlarmCollectionResource',
        summary: 'Retrieve all alarms',
        tags: ['Alarms'],
        parameters: [{ name: 'severity', description: 'Alarm severity filter', schema: { format: 'string' } }],
      },
    },
  },
}

function entries(): DocsIndexEntry[] {
  return [{ namespace: 'c8y', spec: CORE_SPEC }]
}

describe('buildSpecDocs', () => {
  it('creates only overview and topic docs — endpoints contribute nothing', () => {
    const docs = buildSpecDocs(entries())
    expect(docs.map((d) => d.id)).toEqual([
      'c8y::overview',
      'c8y::topic::Alarms',
      'c8y::topic::Inventory',
    ])
    expect(docs.every((d) => d.kind === 'overview' || d.kind === 'topic')).toBe(true)
  })

  it('skips specs without info blocks or tags entirely', () => {
    const docs = buildSpecDocs([{ namespace: 'svc', spec: { paths: { '/x': { get: { operationId: 'getX' } } } } }])
    expect(docs).toEqual([])
  })
})

describe('getDocsIndex / searchDocs / readDoc', () => {
  it('finds topic documentation by fuzzy keywords', () => {
    const index = getDocsIndex({}, entries)
    const hits = searchDocs(index, 'query language')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.id).toBe('c8y::topic::Inventory')
  })

  it('never returns endpoint prose — that lives in codemode.describe', () => {
    const index = getDocsIndex({}, entries)
    // "severity filter" only appears in the endpoint's parameter description,
    // which is not indexed; only the Alarms topic (whose text mentions
    // severity) may match.
    const hits = searchDocs(index, 'severity')
    expect(hits.map((h) => h.kind)).toEqual(['topic'])
    expect(hits[0]!.id).toBe('c8y::topic::Alarms')
  })

  it('truncates long texts in search hits and points at docs.read', () => {
    const longSpec = {
      tags: [{ name: 'Long', description: `query ${'x'.repeat(2000)}` }],
    }
    const index = getDocsIndex({}, () => [{ namespace: 'c8y', spec: longSpec }])
    const hits = searchDocs(index, 'query', { maxTextLength: 100 })
    expect(hits[0]!.truncated).toBe(true)
    expect(hits[0]!.text).toContain('TRUNCATED PREVIEW')
    expect(hits[0]!.text).toContain('docs.read("c8y::topic::Long")')

    const full = readDoc(index, 'c8y::topic::Long')
    expect(full!.text.length).toBeGreaterThan(2000)
    expect(full!.text).not.toContain('TRUNCATED')
  })

  it('caches the index by cache-key identity', () => {
    const key = {}
    expect(getDocsIndex(key, entries)).toBe(getDocsIndex(key, entries))
    expect(getDocsIndex({}, entries)).not.toBe(getDocsIndex({}, entries))
  })

  it('rejects empty queries and ids', () => {
    const index = getDocsIndex({}, entries)
    expect(() => searchDocs(index, ' ')).toThrow(TypeError)
    expect(() => readDoc(index, '')).toThrow(TypeError)
    expect(readDoc(index, 'c8y::topic::Nope')).toBeNull()
  })
})
