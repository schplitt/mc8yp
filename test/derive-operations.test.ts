import { describe, expect, it } from 'vitest'
import { deriveOperations, toRequest } from '../src/codemode/derive-operations'
import type { Spec } from '../src/utils/capability-resolution'

function specOf(paths: Record<string, Record<string, unknown>>): Spec {
  return { paths } as unknown as Spec
}

describe('deriveOperations', () => {
  it('derives one operation per method with the sanitized operationId as name', () => {
    const spec = specOf({
      '/alarm/alarms': {
        get: { operationId: 'getAlarmCollectionResource', summary: 'Retrieve all alarms' },
        post: { operationId: 'postAlarmCollectionResource', summary: 'Create an alarm' },
      },
    })

    const ops = deriveOperations(spec)
    expect(ops.map((o) => o.name)).toEqual(['getAlarmCollectionResource', 'postAlarmCollectionResource'])
    expect(ops[0]!.method).toBe('GET')
    expect(ops[0]!.path).toBe('/alarm/alarms')
    expect(ops[0]!.summary).toBe('Retrieve all alarms')
  })

  it('falls back to method_path naming when operationId is missing', () => {
    const spec = specOf({ '/service/x/items': { get: { summary: 'List' } } })
    expect(deriveOperations(spec)[0]!.name).toBe('getServiceXItems')
  })

  it('flattens path/query params and body into one input schema', () => {
    const spec = specOf({
      '/alarm/alarms/{id}': {
        put: {
          operationId: 'putAlarmResource',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Alarm id' },
            { name: 'withTotal', in: 'query', schema: { type: 'boolean' } },
          ],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { severity: { type: 'string' } } } } } },
        },
      },
    })

    const op = deriveOperations(spec)[0]!
    expect(Object.keys(op.inputSchema.properties!)).toEqual(['id', 'withTotal', 'body'])
    expect(op.inputSchema.required).toEqual(['id', 'body'])
    expect((op.inputSchema.properties!.id as { description?: string }).description).toBe('Alarm id')
  })

  it('derives the output schema from the first 2xx application/json response', () => {
    const spec = specOf({
      '/x': {
        get: {
          operationId: 'getX',
          responses: {
            401: { content: { 'application/json': { schema: { type: 'string' } } } },
            200: { content: { 'application/json': { schema: { type: 'object', properties: { total: { type: 'number' } } } } } },
          },
        },
        post: { operationId: 'postX', responses: { 204: {} } },
      },
    })

    const [get, post] = deriveOperations(spec)
    expect(get!.outputSchema).toEqual({ type: 'object', properties: { total: { type: 'number' } } })
    expect(post!.outputSchema).toBeUndefined()
  })

  it('skips operations annotated with x-mc8yp-exclude', () => {
    const spec = specOf({
      '/x': {
        get: { operationId: 'getX' },
        delete: { 'operationId': 'deleteX', 'x-mc8yp-exclude': true },
      },
    })
    expect(deriveOperations(spec).map((o) => o.name)).toEqual(['getX'])
  })

  it('skips duplicate method names', () => {
    const spec = specOf({
      '/b': { get: { operationId: 'getThing' } },
      '/c': { get: { operationId: 'getThing' } },
    })
    expect(deriveOperations(spec).map((o) => o.name)).toEqual(['getThing'])
  })

  it('inlines local $refs in input schemas', () => {
    const spec = {
      paths: {
        '/x': {
          post: {
            operationId: 'postX',
            requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Thing' } } } },
          },
        },
      },
      components: { schemas: { Thing: { type: 'object', properties: { name: { type: 'string' } } } } },
    } as unknown as Spec

    const op = deriveOperations(spec)[0]!
    expect(op.inputSchema.properties!.body).toEqual({ type: 'object', properties: { name: { type: 'string' } } })
  })

  it('caches derivation by spec object identity', () => {
    const spec = specOf({ '/x': { get: { operationId: 'getX' } } })
    expect(deriveOperations(spec)).toBe(deriveOperations(spec))
  })
})

describe('deriveOperations after real preprocessing', () => {
  it('x-mc8yp-exclude survives preprocessing and still hides the operation', async () => {
    const { preprocessOpenApi } = await import('../src/utils/openapi-preprocessor')
    const spec = await preprocessOpenApi({
      paths: {
        '/visible': { get: { operationId: 'getVisible' } },
        '/hidden': { get: { 'operationId': 'getHidden', 'x-mc8yp-exclude': true } },
      },
    } as unknown as Spec)
    // The preprocessor drops vendor extensions by default — x-mc8yp-exclude
    // must be on its preserved list or exclusion silently dies at runtime.
    expect(deriveOperations(spec).map((o) => o.name)).toEqual(['getVisible'])
  })

  it('accepts 2XX range response keys for the output schema', () => {
    const spec = specOf({
      '/x': {
        get: {
          operationId: 'getX',
          responses: { '2XX': { content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' } } } } } } },
        },
      },
    })
    expect(deriveOperations(spec)[0]!.outputSchema).toEqual({ type: 'object', properties: { ok: { type: 'boolean' } } })
  })
})

describe('toRequest', () => {
  const spec = specOf({
    '/alarm/alarms/{id}': {
      put: {
        operationId: 'putAlarmResource',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'withTotal', in: 'query', schema: { type: 'boolean' } },
          { name: 'X-Custom', in: 'header', schema: { type: 'string' } },
        ],
        requestBody: { content: { 'application/json': { schema: { type: 'object' } } } },
      },
    },
  })

  it('substitutes path params and splits query/header/body', () => {
    const op = deriveOperations(spec)[0]!
    const request = toRequest(op, { 'id': 'my id', 'withTotal': true, 'X-Custom': 'v', 'body': { severity: 'MAJOR' } })

    expect(request.method).toBe('PUT')
    expect(request.path).toBe('/alarm/alarms/my%20id')
    expect(request.query).toEqual({ withTotal: true })
    expect(request.headers).toEqual({ 'X-Custom': 'v' })
    expect(request.body).toEqual({ severity: 'MAJOR' })
  })

  it('serializes explode:false array params as one comma-joined value', () => {
    const explodeSpec = specOf({
      '/alarm/alarms': {
        get: {
          operationId: 'getAlarms',
          parameters: [
            { name: 'severity', in: 'query', explode: false, schema: { type: 'array', items: { type: 'string' } } },
            { name: 'series', in: 'query', explode: true, schema: { type: 'array', items: { type: 'string' } } },
            { name: 'tags', in: 'query', schema: { type: 'array', items: { type: 'string' } } },
          ],
        },
      },
    })
    const op = deriveOperations(explodeSpec)[0]!
    const request = toRequest(op, { severity: ['MAJOR', 'MINOR'], series: ['a', 'b'], tags: ['x', 'y'] })
    expect(request.query.severity).toBe('MAJOR,MINOR')
    // explode true and the OpenAPI default stay arrays → repeated keys.
    expect(request.query.series).toEqual(['a', 'b'])
    expect(request.query.tags).toEqual(['x', 'y'])
  })

  it('omits undefined params and body entirely', () => {
    const op = deriveOperations(spec)[0]!
    const request = toRequest(op, { id: '1' })
    expect(request.query).toEqual({})
    expect('body' in request).toBe(false)
  })
})
