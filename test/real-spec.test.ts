/**
 * Derivation and type rendering against the REAL bundled core spec, pushed
 * through the same preprocessing the runtime applies (default options — no
 * dereferencing). This is the coverage that catches structural-$ref gaps the
 * synthetic fixtures cannot: in the raw spec, parameter entries and response
 * objects are `$ref`s into `components`, and derivation must resolve them
 * itself or every core method silently loses its inputs and output types.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import rawCoreSpec from '../openapi/core/release.json' with { type: 'json' }
import rawDtmSpec from '../openapi/dtm/release.json' with { type: 'json' }
import { deriveOperations } from '../src/codemode/derive-operations'
import type { DerivedOperation } from '../src/codemode/derive-operations'
import { getDocsIndex, readDoc, searchDocs } from '../src/codemode/docs-index'
import { getMethodIndex, searchMethods } from '../src/codemode/method-search'
import type { DocsIndex } from '../src/codemode/docs-index'
import { renderMethodDeclaration } from '../src/codemode/type-render'
import { preprocessOpenApi } from '../src/utils/openapi-preprocessor'
import type { Spec } from '../src/utils/capability-resolution'

let ops: DerivedOperation[]
let dtmOps: DerivedOperation[]
let docsIndex: DocsIndex

beforeAll(async () => {
  // The preprocessor mutates in place and the JSON modules are cached per
  // run — clone so other tests never see a preprocessed spec.
  const spec = await preprocessOpenApi(structuredClone(rawCoreSpec) as unknown as Spec)
  ops = deriveOperations(spec)
  // DTM runs through the same servicePrefix rewrite the bundled-services
  // build plugin and live discovery apply.
  const dtmSpec = await preprocessOpenApi(structuredClone(rawDtmSpec) as unknown as Spec, { servicePrefix: '/service/dtm' })
  dtmOps = deriveOperations(dtmSpec)
  docsIndex = getDocsIndex({}, () => [{ namespace: 'c8y', spec }, { namespace: 'dtm', spec: dtmSpec }])
})

describe('deriveOperations on the real core spec', () => {
  it('derives every operation with a unique operationId-based name', () => {
    expect(ops.length).toBeGreaterThan(200)
    expect(new Set(ops.map((o) => o.name)).size).toBe(ops.length)
    expect(ops.every((o) => /^[a-z_$][\w$]*$/i.test(o.name))).toBe(true)
  })

  it('derives the alarm collection endpoint with resolved $ref parameters', () => {
    const op = ops.find((o) => o.name === 'getAlarmCollectionResource')!
    expect(op.method).toBe('GET')
    expect(op.path).toBe('/alarm/alarms')
    expect(op.summary).toBe('Retrieve all alarms')
    expect(op.tags).toContain('Alarms')

    // In the raw spec these parameters are `$ref`s into components.parameters
    // — an unresolved ref would leave the input schema empty.
    const props = op.inputSchema.properties!
    expect(Object.keys(props).length).toBeGreaterThan(5)
    expect(props).toHaveProperty('severity')
    expect(props).toHaveProperty('pageSize')
    expect((props.severity as { description?: string }).description).toBeTruthy()
  })

  it('derives output schemas from $ref-ed 2xx responses', () => {
    const op = ops.find((o) => o.name === 'getAlarmCollectionResource')!
    expect(op.outputSchema).toBeDefined()
    expect(JSON.stringify(op.outputSchema)).toContain('alarms')
  })

  it('derives request bodies with required flags', () => {
    const op = ops.find((o) => o.name === 'postAlarmCollectionResource')!
    expect(op.inputSchema.properties).toHaveProperty('body')
    expect(op.inputSchema.required).toContain('body')
  })

  it('distinguishes HTTP methods on the same path via operationIds', () => {
    const alarmOps = ops.filter((o) => o.path === '/alarm/alarms')
    const byMethod = new Map(alarmOps.map((o) => [o.method, o.name]))
    expect(byMethod.get('GET')).toBe('getAlarmCollectionResource')
    expect(byMethod.get('POST')).toBe('postAlarmCollectionResource')
    expect(byMethod.get('PUT')).toBe('putAlarmCollectionResource')
    expect(byMethod.get('DELETE')).toBe('deleteAlarmCollectionResource')
  })

  it('resolves path-parameter operations', () => {
    const op = ops.find((o) => o.name === 'getAlarmResource')!
    expect(op.path).toBe('/alarm/alarms/{id}')
    expect(op.parameters.some((p) => p.name === 'id' && p.in === 'path')).toBe(true)
    expect(op.inputSchema.required).toContain('id')
  })
})

describe('renderMethodDeclaration on the real core spec', () => {
  it('renders a full typed declaration for the alarm collection endpoint', () => {
    const op = ops.find((o) => o.name === 'getAlarmCollectionResource')!
    const { types, signature } = renderMethodDeclaration('c8y', op.name, {
      inputSchema: op.inputSchema,
      outputSchema: op.outputSchema,
    })

    expect(signature).toBe('c8y.getAlarmCollectionResource(input: GetAlarmCollectionResourceInput): Promise<GetAlarmCollectionResourceOutput>')
    expect(types).toContain('type GetAlarmCollectionResourceInput =')
    expect(types).toContain('severity?:')
    expect(types).toContain('pageSize?: number;')
    expect(types).toContain('@minimum 1 @maximum 2000 @example 10')
    expect(types).toContain('type GetAlarmCollectionResourceOutput =')
    expect(types).toContain('alarms?:')
    // Property JSDoc from the real parameter descriptions must survive.
    expect(types).toMatch(/\/\*\*[\s\S]*severity/)
  })
})

describe('method search on the real specs', () => {
  it('finds the collection method for the queries that failed in live usage', () => {
    const items = [
      ...ops.map((o) => ({ target: `c8y.${o.name}`, namespace: 'c8y', method: o.name, httpMethod: o.method, apiPath: o.path, summary: o.summary })),
      ...dtmOps.map((o) => ({ target: `dtm.${o.name}`, namespace: 'dtm', method: o.name, httpMethod: o.method, apiPath: o.path, summary: o.summary })),
    ]
    const index = getMethodIndex({}, () => items)
    // "dtm asset" buried getAssets at #10 with the old token scorer; the
    // fuzzy engine must keep it in the visible results.
    expect(searchMethods(index, 'dtm asset').results.map((entry) => entry.target)).toContain('dtm.getAssets')
    // "list assets" returned unrelated noise with the old full-coverage rule.
    expect(searchMethods(index, 'list assets').results.map((entry) => entry.target)).toContain('dtm.getAssets')
    // Multi-phrasing union in one call.
    const multi = searchMethods(index, ['list assets', 'retrieve assets'])
    expect(multi.results.map((entry) => entry.target)).toContain('dtm.getAssets')
  })
})

describe('docs flow on the real specs', () => {
  it('the query-language pointer in a param description leads to the grammar via docs.search', () => {
    // Core's `query` parameter description only says "Details … can be found
    // in [Query language]" — the agent is expected to turn that phrase into a
    // docs.search. The topic must outrank the many endpoint docs whose param
    // prose also mentions "query language".
    const hits = searchDocs(docsIndex, 'query language')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.id).toBe('c8y::topic::Query language')
    expect(hits[0]!.kind).toBe('topic')

    const doc = readDoc(docsIndex, hits[0]!.id)!
    expect(doc.text.length).toBeGreaterThan(4000)
    expect(doc.text).toContain('$filter')
  })
})

describe('deriveOperations on the real DTM spec', () => {
  it('derives service-prefixed paths with hand-authored operationId names', () => {
    const op = dtmOps.find((o) => o.path === '/service/dtm/assets' && o.method === 'GET')!
    expect(op.name).toBe('getAssets')
    expect(dtmOps.every((o) => o.path.startsWith('/service/dtm/'))).toBe(true)
  })

  it('renders the DTM query parameter with its c8y:query format marker', () => {
    const op = dtmOps.find((o) => o.path === '/service/dtm/assets' && o.method === 'GET')!
    const { types } = renderMethodDeclaration('dtm', op.name, {
      inputSchema: op.inputSchema,
      outputSchema: op.outputSchema,
    })
    // The preprocessor stamps `format: "c8y:query"` on Cumulocity Query
    // Language parameters ($filter grammar); the renderer surfaces it as an
    // @format JSDoc tag — the hook that should send an agent to docs.search
    // for the grammar.
    expect(types).toContain('@format c8y:query')
  })
})
