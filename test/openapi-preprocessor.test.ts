import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DEFAULT_PREPROCESS_OPTIONS, preprocessOpenApi } from '../src/utils/openapi-preprocessor'

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value))
}

describe('preprocessOpenApi — dereference', () => {
  it('inlines internal $refs', async () => {
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
    const out = await preprocessOpenApi(clone(spec), { dereference: true })
    const schema = (out.paths['/items'].get.responses as any)[200].content['application/json'].schema
    expect(schema.type).toBe('object')
    expect(schema.properties.id).toEqual({ type: 'string' })
  })

  it('inlines refs through circular schemas, leaving only the self-cycle', async () => {
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
    const out = await preprocessOpenApi(clone(spec), { dereference: true }) as any
    const responseSchema = out.paths['/items'].get.responses[200].content['application/json'].schema
    expect(responseSchema.properties.items.items.type).toBe('object')
    expect(responseSchema.properties.items.items.properties.children.items.$ref).toBe('#/components/schemas/Asset')
  })
})

describe('preprocessOpenApi — minify passes', () => {
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
              200: {
                description: 'ok',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      example: { id: 1 },
                      examples: { sample: { value: { id: 1 } } },
                      $schema: 'http://json-schema.org/draft',
                    },
                  },
                },
              },
              400: { description: 'bad request' },
              404: { description: 'not found' },
              default: { description: 'error' },
            },
          },
        },
      },
    }
  }

  it('keeps only 2xx responses', async () => {
    const out = await preprocessOpenApi(fixture()) as any
    expect(Object.keys(out.paths['/items'].get.responses)).toEqual(['200'])
  })

  it('drops vendor extensions except x-codemode', async () => {
    const out = await preprocessOpenApi(fixture()) as any
    expect(out['x-stoplight']).toBeUndefined()
    expect(out.paths['/items'].get['x-internal']).toBeUndefined()
    expect(out['x-codemode']).toEqual([{ instruction: 'keep me' }])
  })

  it('drops $schema but keeps example and examples', async () => {
    const out = await preprocessOpenApi(fixture()) as any
    const schema = out.paths['/items'].get.responses['200'].content['application/json'].schema
    expect(schema.$schema).toBeUndefined()
    expect(schema.example).toEqual({ id: 1 })
    expect(schema.examples).toEqual({ sample: { value: { id: 1 } } })
  })

  it('drops tags and empty security at both levels', async () => {
    const out = await preprocessOpenApi(fixture()) as any
    expect(out.tags).toBeUndefined()
    expect(out.security).toBeUndefined()
    expect(out.paths['/items'].get.tags).toBeUndefined()
    expect(out.paths['/items'].get.security).toBeUndefined()
  })

  it('drops security with empty-scope requirement objects', async () => {
    const spec = {
      paths: { '/x': { get: { security: [{ Basic: [], SSO: [] }], responses: { 200: {} } } } },
    }
    const out = await preprocessOpenApi(spec) as any
    expect(out.paths['/x'].get.security).toBeUndefined()
  })

  it('preserves security with non-empty scopes', async () => {
    const spec = {
      paths: { '/x': { get: { security: [{ oauth2: ['read:items'] }], responses: { 200: {} } } } },
    }
    const out = await preprocessOpenApi(spec) as any
    expect(out.paths['/x'].get.security).toEqual([{ oauth2: ['read:items'] }])
  })

  it('keeps default response when no 2xx exists', async () => {
    const spec = { paths: { '/x': { get: { responses: { 400: { description: 'bad' }, default: { description: 'err' } } } } } }
    const out = await preprocessOpenApi(spec) as any
    expect(Object.keys(out.paths['/x'].get.responses)).toEqual(['default'])
  })

  it('preserves descriptions', async () => {
    const out = await preprocessOpenApi(fixture()) as any
    expect(out.paths['/items'].get.responses['200'].description).toBe('ok')
  })

  it('removes properties set to their implicit JSON Schema / OpenAPI defaults', async () => {
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
                      required: ['id'], // schema-array form must NOT be removed
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
    const out = await preprocessOpenApi(spec) as any
    const schema = out.paths['/x'].get.responses[200].content['application/json'].schema
    expect(schema.additionalProperties).toBeUndefined()
    expect(schema.uniqueItems).toBeUndefined()
    expect(schema.readOnly).toBeUndefined()
    expect(schema.nullable).toBeUndefined()
    expect(schema.deprecated).toBeUndefined()
    expect(schema.required).toEqual(['id'])
    expect(schema.properties.id.readOnly).toBeUndefined()
    expect(out.paths['/x'].get.parameters[0].required).toBeUndefined()
    expect(out.paths['/x'].get.parameters[0].name).toBe('q')
  })
})

describe('preprocessOpenApi — orphan schemas', () => {
  it('always drops orphan schemas, even with dereference off', async () => {
    const spec = {
      paths: { '/x': { get: { responses: { 200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Used' } } } } } } } },
      components: {
        schemas: { Used: { type: 'object' }, Unused: { type: 'string' } },
        instructions: { Setup: 'Do X then Y.' },
      },
    }
    const out = await preprocessOpenApi(spec) as any
    expect(out.components.schemas.Used).toBeTruthy()
    expect(out.components.schemas.Unused).toBeUndefined()
    expect(out.components.instructions).toEqual({ Setup: 'Do X then Y.' })
  })

  it('drops the components block when nothing is reachable and no custom sections remain', async () => {
    const spec = {
      paths: { '/x': { get: { responses: { 200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Used' } } } } } } } },
      components: { schemas: { Used: { type: 'object' }, Unused: { type: 'string' } } },
    }
    const out = await preprocessOpenApi(spec, { dereference: true }) as any
    expect(out.components).toBeUndefined()
  })

  it('keeps custom sections (instructions) when components.schemas is fully dropped', async () => {
    const spec = {
      paths: { '/x': { get: { responses: { 200: {} } } } },
      components: {
        schemas: { Unused: { type: 'string' } },
        instructions: { Setup: 'Do X then Y.' },
      },
    }
    const out = await preprocessOpenApi(spec) as any
    expect(out.components.schemas).toBeUndefined()
    expect(out.components.instructions).toEqual({ Setup: 'Do X then Y.' })
  })

  it('keeps circular schemas reachable through surviving $refs after dereference', async () => {
    const spec = {
      paths: { '/x': { get: { responses: { 200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Node' } } } } } } } },
      components: {
        schemas: {
          Node: { type: 'object', properties: { child: { $ref: '#/components/schemas/Node' } } },
          Orphan: { type: 'string' },
        },
      },
    }
    const out = await preprocessOpenApi(spec, { dereference: true }) as any
    expect(out.components.schemas.Node).toBeTruthy()
    expect(out.components.schemas.Orphan).toBeUndefined()
  })
})

describe('preprocessOpenApi — robustness', () => {
  it('handles a spec with no paths', async () => {
    const out = await preprocessOpenApi({ openapi: '3.0.0', info: { title: 't' } }) as any
    expect(out.info.title).toBe('t')
  })

  it('is idempotent', async () => {
    const spec = {
      paths: { '/x': { get: { 'tags': ['a'], 'responses': { 200: {}, 500: {} }, 'x-foo': 1 } } },
      tags: [{ name: 'a' }],
    }
    const once = await preprocessOpenApi(clone(spec))
    const twice = await preprocessOpenApi(clone(once))
    expect(twice).toEqual(once)
  })
})

describe('preprocessOpenApi — options', () => {
  it('leaves $refs intact when dereference is off', async () => {
    const spec = {
      paths: { '/x': { get: { responses: { 200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Item' } } } } } } } },
      components: { schemas: { Item: { type: 'object' } } },
    }
    const out = await preprocessOpenApi(spec, { dereference: false }) as any
    expect(out.paths['/x'].get.responses[200].content['application/json'].schema).toEqual({ $ref: '#/components/schemas/Item' })
  })

  it('respects individual rule overrides (dropTags: false)', async () => {
    const spec = { tags: [{ name: 'a' }], paths: { '/x': { get: { tags: ['a'], responses: { 200: {} } } } } }
    const out = await preprocessOpenApi(spec, { dropTags: false }) as any
    expect(out.tags).toEqual([{ name: 'a' }])
    expect(out.paths['/x'].get.tags).toEqual(['a'])
  })

  it('respects individual rule overrides (dropNon2xxResponses: false)', async () => {
    const spec = { paths: { '/x': { get: { responses: { 200: { description: 'ok' }, 404: { description: 'no' } } } } } }
    const out = await preprocessOpenApi(spec, { dropNon2xxResponses: false }) as any
    expect(Object.keys(out.paths['/x'].get.responses).sort()).toEqual(['200', '404'])
  })

  it('exposes DEFAULT_PREPROCESS_OPTIONS with the expected toggles', () => {
    expect(DEFAULT_PREPROCESS_OPTIONS).toEqual({
      dereference: false,
      dropNon2xxResponses: true,
      dropVendorExtensions: true,
      dropSchemaMeta: true,
      dropTags: false,
      dropEmptySecurity: true,
      dropSchemaDefaults: true,
      servicePrefix: '',
    })
  })
})

describe('preprocessOpenApi — servicePrefix', () => {
  it('prefixes paths that do not yet have the prefix', async () => {
    const spec = clone({ paths: { '/assets': {}, '/assets/{id}': {} } })
    const out = await preprocessOpenApi(spec, { servicePrefix: '/service/dtm' }) as any
    expect(Object.keys(out.paths).sort()).toEqual(['/service/dtm/assets', '/service/dtm/assets/{id}'])
  })

  it('leaves paths that already have the prefix unchanged (idempotent)', async () => {
    const spec = clone({ paths: { '/service/dtm/assets': {}, '/service/dtm/types': {} } })
    const out = await preprocessOpenApi(spec, { servicePrefix: '/service/dtm' }) as any
    expect(Object.keys(out.paths).sort()).toEqual(['/service/dtm/assets', '/service/dtm/types'])
  })

  it('is a no-op when servicePrefix is not provided', async () => {
    const spec = clone({ paths: { '/assets': {} } })
    const out = await preprocessOpenApi(spec) as any
    expect(Object.keys(out.paths)).toEqual(['/assets'])
  })

  it('is a no-op when servicePrefix is an empty string', async () => {
    const spec = clone({ paths: { '/assets': {} } })
    const out = await preprocessOpenApi(spec, { servicePrefix: '' }) as any
    expect(Object.keys(out.paths)).toEqual(['/assets'])
  })

  it('handles a mixed spec where some paths already carry the prefix', async () => {
    const spec = clone({ paths: { '/assets': {}, '/service/dtm/types': {} } })
    const out = await preprocessOpenApi(spec, { servicePrefix: '/service/dtm' }) as any
    expect(Object.keys(out.paths).sort()).toEqual(['/service/dtm/assets', '/service/dtm/types'])
  })

  it('strips servicePrefix from servers url when present', async () => {
    const spec = clone({
      paths: { '/assets': {} },
      servers: [{ url: 'https://<TENANT_DOMAIN>/service/dtm', description: 'DTM' }],
    })
    const out = await preprocessOpenApi(spec, { servicePrefix: '/service/dtm' }) as any
    expect(out.servers[0].url).toBe('https://<TENANT_DOMAIN>')
  })

  it('strips servicePrefix with trailing slash from servers url', async () => {
    const spec = clone({
      paths: { '/assets': {} },
      servers: [{ url: 'https://<TENANT_DOMAIN>/service/dtm/' }],
    })
    const out = await preprocessOpenApi(spec, { servicePrefix: '/service/dtm' }) as any
    expect(out.servers[0].url).toBe('https://<TENANT_DOMAIN>')
  })

  it('leaves servers url unchanged when it does not contain servicePrefix', async () => {
    const spec = clone({
      paths: { '/assets': {} },
      servers: [{ url: 'https://<TENANT_DOMAIN>' }],
    })
    const out = await preprocessOpenApi(spec, { servicePrefix: '/service/dtm' }) as any
    expect(out.servers[0].url).toBe('https://<TENANT_DOMAIN>')
  })
})


describe('preprocessOpenApi — real DTM spec', () => {
  const raw = readFileSync(path.join(rootDir, 'openapi', 'dtm', 'release.json'), 'utf8')

  it('minified output is smaller than the untouched input and stays valid JSON', async () => {
    const untouched = JSON.parse(raw)
    const minified = await preprocessOpenApi(JSON.parse(raw))

    const untouchedSize = JSON.stringify(untouched).length
    const minifiedSize = JSON.stringify(minified).length

    expect(() => JSON.parse(JSON.stringify(minified))).not.toThrow()
    expect(minifiedSize).toBeLessThan(untouchedSize * 0.95)
  })
})
