import { describe, expect, it } from 'vitest'
import { buildSpecDocs } from '../src/codemode/spec-index'

// A representative tenant surface: core (info + tag + endpoint with params) plus
// one service spec. buildSpecDocs takes the two bindings (core, serviceSpecs)
// directly — the same shape the sandbox passes from its globals.
const SAMPLE = {
  core: {
    info: { title: 'Cumulocity', description: 'Core REST API' },
    tags: [{ name: 'Query language', description: 'OData $filter eq operator' }],
    paths: {
      '/inventory/managedObjects': {
        get: {
          operationId: 'getManagedObjectCollection',
          summary: 'Retrieve managed objects',
          description: 'List the inventory',
          tags: ['Inventory'],
          parameters: [{ name: 'query', in: 'query', description: 'Filter via $filter' }],
        },
      },
    },
  },
  specs: {
    dtm: {
      info: { title: 'Digital Twin Manager' },
      paths: { '/service/dtm/assets': { get: { summary: 'List assets' } } },
    },
  },
}

describe('buildSpecDocs — document structure', () => {
  it('transforms a spec set into uniform {id, header, text, kind, spec} documents', () => {
    const docs = buildSpecDocs(SAMPLE.core, SAMPLE.specs)

    // This is exactly what gets indexed, and (via header/text/kind/spec) what
    // the agent reads back off each search hit.
    expect(docs).toEqual([
      // ── core ──────────────────────────────────────────────────────────────
      {
        id: 'core::spec',
        header: 'coreSpec.info — Cumulocity',
        text: 'Cumulocity Core REST API',
        kind: 'spec',
        spec: 'core',
      },
      {
        id: 'core::tag::Query language',
        header: 'coreSpec.tags — Query language',
        text: 'Query language OData $filter eq operator',
        kind: 'tag',
        spec: 'core',
      },
      {
        id: 'core::op::get::/inventory/managedObjects',
        header: 'coreSpec.paths["/inventory/managedObjects"].get',
        text: 'GET /inventory/managedObjects getManagedObjectCollection Retrieve managed objects List the inventory Inventory query Filter via $filter',
        kind: 'endpoint',
        spec: 'core',
      },
      // ── dtm (service) ─────────────────────────────────────────────────────
      {
        id: 'dtm::spec',
        header: 'serviceSpecs["dtm"].info — Digital Twin Manager',
        text: 'Digital Twin Manager',
        kind: 'spec',
        spec: 'dtm',
      },
      {
        id: 'dtm::op::get::/service/dtm/assets',
        header: 'serviceSpecs["dtm"].paths["/service/dtm/assets"].get',
        text: 'GET /service/dtm/assets List assets',
        kind: 'endpoint',
        spec: 'dtm',
      },
    ])
  })

  it('skips spec docs with no info text and tags without a name', () => {
    const docs = buildSpecDocs(
      { tags: [{ description: 'no name, dropped' }, { name: 'Kept' }], paths: {} },
      {},
    )

    expect(docs.map((d) => d.id)).toEqual(['core::tag::Kept'])
  })
})
