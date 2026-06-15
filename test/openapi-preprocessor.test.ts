import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DEFAULT_MINIFY_RULES, DEFAULT_PREPROCESS_OPTIONS, preprocessOpenApi } from '../src/utils/openapi-preprocessor'

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

// Deep clone so each test gets an independent fixture (preprocess mutates in place).
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value))
}

// ---------------------------------------------------------------------------
// Dereference stage
// ---------------------------------------------------------------------------

describe('preprocessOpenApi — dereference', () => {
  it('inlines internal $refs by default', async () => {
    const spec = {
      paths: {
        '/items': {
          get: {
            responses: {
              200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Item' } } } },
            },
          },
        },
      },
      components: { schemas: { Item: { type: 'object', properties: { id: { type: 'string' } } } } },
    }
    const out = await preprocessOpenApi(clone(spec), { minify: false })
    const schema = (out.paths['/items'].get.responses as any)[200].content['application/json'].schema
    expect(schema).toEqual({ type: 'object', properties: { id: { type: 'string' } } })
  })

  it('inlines refs to circular schemas (second-pass expansion)', async () => {
    // Asset is circular (subAssets → Asset). $RefParser leaves $ref: Asset
    // everywhere due to conservative detection. The second pass should inline
    // Asset into PaginatedList.items while leaving Asset.subAssets as $ref.
    const spec = {
      paths: {
        '/items': {
          get: {
            responses: {
              200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/PaginatedList' } } } },
            },
          },
        },
      },
      components: {
        schemas: {
          PaginatedList: { type: 'object', properties: { items: { type: 'array', items: { $ref: '#/components/schemas/Asset' } } } },
          Asset: { type: 'object', properties: { id: { type: 'string' }, children: { type: 'array', items: { $ref: '#/components/schemas/Asset' } } } },
        },
      },
    }
    const out = await preprocessOpenApi(clone(spec), { minify: false }) as any
    const responseSchema = out.paths['/items'].get.responses[200].content['application/json'].schema
    // PaginatedList inlined at the path level
    expect(responseSchema.type).toBe('object')
    expect(responseSchema.properties.items.items.type).toBe('object') // Asset inlined
    // The circular self-ref within the inlined Asset stays as $ref
    expect(responseSchema.properties.items.items.properties.children.items.$ref).toBe('#/components/schemas/Asset')
  })

  it('skips dereference when dereference: false', async () => {
    const spec = { paths: {}, components: { schemas: { A: { $ref: '#/components/schemas/B' } } } }
    const out = await preprocessOpenApi(clone(spec), { dereference: false, minify: false })
    expect(out.components.schemas.A).toEqual({ $ref: '#/components/schemas/B' })
  })
})

// ---------------------------------------------------------------------------
// Default minify rules
// ---------------------------------------------------------------------------

describe('preprocessOpenApi — default rules', () => {
  function fixture() {
    return {
      'tags': [{ name: 'items' }],
      'security': [],
      'x-stoplight': { id: 'abc' },
      'x-codemode': [{ instruction: 'keep me' }],
      'paths': {
        '/items': {
          get: {
            'summary': 'List items',
            'tags': ['items'],
            'security': [],
            'x-internal': true,
            'responses': {
              200: { description: 'ok', content: { 'application/json': { schema: { type: 'object', example: { id: 1 }, $schema: 'http://json-schema.org/draft' } } } },
              400: { description: 'bad request' },
              404: { description: 'not found' },
              default: { description: 'error' },
            },
          },
        },
      },
    }
  }

  it('drops non-2xx responses, keeping only 2xx', async () => {
    const out = await preprocessOpenApi(fixture(), { minify: true })
    expect(Object.keys((out.paths['/items'].get as any).responses)).toEqual(['200'])
  })

  it('drops vendor extensions except x-codemode', async () => {
    const out = await preprocessOpenApi(fixture(), { minify: true }) as any
    expect(out['x-stoplight']).toBeUndefined()
    expect(out.paths['/items'].get['x-internal']).toBeUndefined()
    expect(out['x-codemode']).toEqual([{ instruction: 'keep me' }])
  })

  it('drops $schema and example schema meta', async () => {
    const out = await preprocessOpenApi(fixture(), { minify: true }) as any
    const schema = out.paths['/items'].get.responses['200'].content['application/json'].schema
    expect(schema.example).toBeUndefined()
    expect(schema.$schema).toBeUndefined()
    expect(schema.type).toBe('object')
  })

  it('drops tags (operation + top-level) and empty security', async () => {
    const out = await preprocessOpenApi(fixture(), { minify: true }) as any
    expect(out.tags).toBeUndefined()
    expect(out.security).toBeUndefined()
    expect(out.paths['/items'].get.tags).toBeUndefined()
    expect(out.paths['/items'].get.security).toBeUndefined()
  })

  it('dropEmptySecurity removes security with empty-scope requirement objects', async () => {
    const spec = {
      paths: {
        '/x': {
          get: {
            security: [{ 'Basic': [], 'SSO': [], 'OAI-Secure': [], 'JWT-IAM': [] }],
            responses: { 200: {} },
          },
        },
      },
    }
    const out = await preprocessOpenApi(spec, { minify: true }) as any
    expect(out.paths['/x'].get.security).toBeUndefined()
  })

  it('dropEmptySecurity preserves security with non-empty scopes', async () => {
    const spec = {
      paths: { '/x': { get: { security: [{ oauth2: ['read:items'] }], responses: { 200: {} } } } },
    }
    const out = await preprocessOpenApi(spec, { minify: true }) as any
    expect(out.paths['/x'].get.security).toBeDefined()
  })

  it('keeps default response when no 2xx exists', async () => {
    const spec = { paths: { '/x': { get: { responses: { 400: { description: 'bad' }, default: { description: 'err' } } } } } }
    const out = await preprocessOpenApi(spec, { minify: true }) as any
    expect(Object.keys(out.paths['/x'].get.responses)).toEqual(['default'])
  })

  it('preserves descriptions by default (lossy rules are opt-in)', async () => {
    const out = await preprocessOpenApi(fixture(), { minify: true }) as any
    expect(out.paths['/items'].get.responses['200'].description).toBe('ok')
  })
})

// ---------------------------------------------------------------------------
// Opt-in rules
// ---------------------------------------------------------------------------

describe('preprocessOpenApi — opt-in rules', () => {
  it('shortenDescriptions truncates to the first sentence', async () => {
    const spec = { paths: { '/x': { get: { description: 'First sentence. Second sentence. Third.' } } } }
    const out = await preprocessOpenApi(spec, { minify: { shortenDescriptions: true } }) as any
    expect(out.paths['/x'].get.description).toBe('First sentence.')
  })

  it('dropDescriptions removes description values and overrides shorten', async () => {
    const spec = { paths: { '/x': { get: { summary: 'keep', description: 'Drop me. Please.' } } } }
    const out = await preprocessOpenApi(spec, { minify: { shortenDescriptions: true, dropDescriptions: true } }) as any
    expect(out.paths['/x'].get.description).toBeUndefined()
    expect(out.paths['/x'].get.summary).toBe('keep')
  })

  it('jsonMediaTypeOnly keeps application/json when present', async () => {
    const spec = {
      paths: {
        '/x': {
          post: {
            requestBody: { content: { 'application/json': { schema: {} }, 'text/csv': { schema: {} } } },
            responses: { 200: { content: { 'application/json': {}, 'application/xml': {} } } },
          },
        },
      },
    }
    const out = await preprocessOpenApi(spec, { minify: { jsonMediaTypeOnly: true } }) as any
    expect(Object.keys(out.paths['/x'].post.requestBody.content)).toEqual(['application/json'])
    expect(Object.keys(out.paths['/x'].post.responses['200'].content)).toEqual(['application/json'])
  })

  it('jsonMediaTypeOnly leaves vendor-only content untouched', async () => {
    const spec = {
      paths: {
        '/x': {
          post: {
            requestBody: { content: { 'application/vnd.com.nsn.cumulocity.managedObject+json': { schema: {} } } },
          },
        },
      },
    }
    const out = await preprocessOpenApi(spec, { minify: { jsonMediaTypeOnly: true } }) as any
    expect(Object.keys(out.paths['/x'].post.requestBody.content)).toEqual(['application/vnd.com.nsn.cumulocity.managedObject+json'])
  })

  it('dropSecurity removes all security fields and scheme definitions', async () => {
    const spec = {
      security: [{ Basic: [] }],
      paths: {
        '/x': { get: { security: [{ oauth2: ['read:items'] }], responses: { 200: {} } } },
        '/y': { post: { security: [], responses: { 201: {} } } },
      },
      components: {
        securitySchemes: { Basic: { type: 'http', scheme: 'basic' }, oauth2: { type: 'oauth2' } },
        schemas: { Item: { type: 'object' } },
      },
      securityDefinitions: { ApiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' } },
    }
    const out = await preprocessOpenApi(spec, { dereference: false, minify: { dropSecurity: true } }) as any
    expect(out.security).toBeUndefined()
    expect(out.paths['/x'].get.security).toBeUndefined()
    expect(out.paths['/y'].post.security).toBeUndefined()
    expect(out.components.securitySchemes).toBeUndefined()
    expect(out.securityDefinitions).toBeUndefined()
    expect(out.components.schemas).toBeDefined()
  })

  it('dropSchemaDefaults removes properties set to their implicit default values', async () => {
    const spec = {
      paths: {
        '/x': {
          get: {
            parameters: [{ name: 'q', in: 'query', required: false, schema: { type: 'string' } }],
            responses: {
              200: {
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      additionalProperties: true,
                      uniqueItems: false,
                      readOnly: false,
                      nullable: false,
                      deprecated: false,
                      required: ['id'], // array form — must NOT be removed
                      properties: { id: { type: 'string', readOnly: false } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    }
    const out = await preprocessOpenApi(spec, { dereference: false, minify: { dropSchemaDefaults: true } }) as any
    const schema = out.paths['/x'].get.responses[200].content['application/json'].schema
    expect(schema.additionalProperties).toBeUndefined()
    expect(schema.uniqueItems).toBeUndefined()
    expect(schema.readOnly).toBeUndefined()
    expect(schema.nullable).toBeUndefined()
    expect(schema.deprecated).toBeUndefined()
    expect(schema.required).toEqual(['id']) // array form preserved
    expect(schema.properties.id.readOnly).toBeUndefined()
    expect(out.paths['/x'].get.parameters[0].required).toBeUndefined() // boolean false removed
    expect(out.paths['/x'].get.parameters[0].name).toBe('q') // rest intact
  })

  it('dropSchemaDefaults is on by default', async () => {
    const spec = { paths: { '/x': { get: { parameters: [{ name: 'q', in: 'query', required: false }], responses: { 200: {} } } } } }
    const out = await preprocessOpenApi(spec, { dereference: false, minify: true }) as any
    expect(out.paths['/x'].get.parameters[0].required).toBeUndefined()
  })

  it('dropDeprecated removes deprecated operations and emptied paths', async () => {
    const spec = {
      paths: {
        '/old': { get: { deprecated: true, responses: {} } },
        '/mixed': { get: { deprecated: true, responses: {} }, post: { responses: { 200: {} } } },
      },
    }
    const out = await preprocessOpenApi(spec, { minify: { dropDeprecated: true } }) as any
    expect(out.paths['/old']).toBeUndefined()
    expect(out.paths['/mixed'].get).toBeUndefined()
    expect(out.paths['/mixed'].post).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// Ref-aware component pruning
// ---------------------------------------------------------------------------

describe('preprocessOpenApi — pruneComponents', () => {
  it('drops components when no $ref survives (fully dereferenced)', async () => {
    const spec = {
      paths: { '/x': { get: { responses: { 200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Used' } } } } } } } },
      components: { schemas: { Used: { type: 'object' }, Unused: { type: 'string' } } },
    }
    // dereference inlines Used, leaving zero surviving refs → whole block goes.
    const out = await preprocessOpenApi(spec, { minify: { pruneComponents: true } }) as any
    expect(out.components).toBeUndefined()
  })

  it('keeps only components reachable through surviving (circular) refs', async () => {
    // A self-referential schema is left as $ref by resolve-refs (circular: ignore).
    const spec = {
      paths: { '/x': { get: { responses: { 200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Node' } } } } } } } },
      components: {
        schemas: {
          Node: { type: 'object', properties: { child: { $ref: '#/components/schemas/Node' } } },
          Orphan: { type: 'string' },
        },
      },
    }
    const out = await preprocessOpenApi(spec, { minify: { pruneComponents: true } }) as any
    expect(out.components.schemas.Node).toBeTruthy()
    expect(out.components.schemas.Orphan).toBeUndefined()
  })

  it('follows transitive refs across component entries (pruning in isolation)', async () => {
    // dereference: false so the refs survive and we exercise the closure walk
    // directly — with dereference on, non-circular entries get inlined away.
    const spec = {
      paths: { '/x': { get: { responses: { 200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/A' } } } } } } } },
      components: {
        schemas: {
          A: { properties: { b: { $ref: '#/components/schemas/B' } } },
          B: { properties: { c: { $ref: '#/components/schemas/C' } } },
          C: { type: 'string' },
          D: { type: 'number' },
        },
      },
    }
    const out = await preprocessOpenApi(spec, { dereference: false, minify: { pruneComponents: true } }) as any
    expect(Object.keys(out.components.schemas).sort()).toEqual(['A', 'B', 'C'])
  })
})

// ---------------------------------------------------------------------------
// Robustness
// ---------------------------------------------------------------------------

describe('preprocessOpenApi — robustness', () => {
  it('is a no-op-ish on a spec with no paths', async () => {
    const out = await preprocessOpenApi({ openapi: '3.0.0', info: { title: 't' } }, { minify: true }) as any
    expect(out.info.title).toBe('t')
  })

  it('is idempotent', async () => {
    const spec = {
      paths: { '/x': { get: { 'tags': ['a'], 'responses': { 200: {}, 500: {} }, 'x-foo': 1 } } },
      tags: [{ name: 'a' }],
    }
    const once = await preprocessOpenApi(clone(spec), DEFAULT_PREPROCESS_OPTIONS)
    const twice = await preprocessOpenApi(clone(once), DEFAULT_PREPROCESS_OPTIONS)
    expect(twice).toEqual(once)
  })
})

// ---------------------------------------------------------------------------
// Real spec — size reduction sanity check
// ---------------------------------------------------------------------------

describe('preprocessOpenApi — real DTM spec', () => {
  const raw = readFileSync(path.join(rootDir, 'openapi', 'dtm', 'release.json'), 'utf8')

  it('minified output is substantially smaller than dereference-only and stays valid JSON', async () => {
    const dereferenceOnly = await preprocessOpenApi(JSON.parse(raw), { minify: false })
    const minified = await preprocessOpenApi(JSON.parse(raw), DEFAULT_PREPROCESS_OPTIONS)

    const dereferencedStr = JSON.stringify(dereferenceOnly)
    const dereferencedSize = dereferencedStr.length
    const minifiedStr = JSON.stringify(minified)
    const minifiedSize = minifiedStr.length

    // write minifiedStr to file
    // writeFileSync(path.join(rootDir, 'openapi', 'dtm', 'release.min.json'), JSON.stringify(minified, null, 2), 'utf8')

    // Round-trips cleanly (JSON-serialisable invariant for the sandbox).
    expect(() => JSON.parse(JSON.stringify(minified))).not.toThrow()
    expect(minifiedSize).toBeLessThan(dereferencedSize)
    // Defaults + pruneComponents should buy a meaningful cut; keep the bar low
    // so the assertion is robust to spec changes but still catches a regression
    // where minification silently does nothing.
    expect(minifiedSize).toBeLessThan(dereferencedSize * 0.95)
  })
})

describe('DEFAULT_MINIFY_RULES', () => {
  it('enables the five lossless passes and leaves lossy/structural ones off', () => {
    expect(DEFAULT_MINIFY_RULES).toMatchObject({
      dropNon2xxResponses: true,
      dropVendorExtensions: true,
      dropSchemaMeta: true,
      dropTags: true,
      dropEmptySecurity: true,
      shortenDescriptions: false,
      dropDescriptions: false,
      jsonMediaTypeOnly: false,
      pruneComponents: false,
      dropDeprecated: false,
    })
  })
})
