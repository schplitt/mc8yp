import { describe, expect, it } from 'vitest'
import { jsonSchemaToType, renderMethodDeclaration } from '../src/codemode/type-render'

describe('jsonSchemaToType', () => {
  it('renders objects with optional markers and property JSDoc', () => {
    const rendered = jsonSchemaToType({
      type: 'object',
      properties: {
        type: { type: 'string', description: 'The alarm type.' },
        pageSize: { type: 'number' },
      },
      required: ['type'],
    }, 'Input')

    expect(rendered).toContain('/** The alarm type. */')
    expect(rendered).toContain('type: string;')
    expect(rendered).toContain('pageSize?: number;')
  })

  it('renders enums, nullable, arrays, and unions', () => {
    expect(jsonSchemaToType({ enum: ['A', 'B'] }, 'T')).toBe('type T = "A" | "B"')
    expect(jsonSchemaToType({ type: 'string', nullable: true }, 'T')).toBe('type T = string | null')
    expect(jsonSchemaToType({ type: 'array', items: { type: 'number' } }, 'T')).toBe('type T = number[]')
    expect(jsonSchemaToType({ anyOf: [{ type: 'string' }, { type: 'number' }] }, 'T')).toBe('type T = string | number')
    expect(jsonSchemaToType({ type: ['string', 'null'] }, 'T')).toBe('type T = string | null')
  })

  it('resolves internal $refs and degrades cycles to unknown', () => {
    const schema = {
      type: 'object',
      properties: { child: { $ref: '#/definitions/Node' } },
      definitions: { Node: { type: 'object', properties: { self: { $ref: '#/definitions/Node' } } } },
    } as Parameters<typeof jsonSchemaToType>[0]

    const rendered = jsonSchemaToType(schema, 'T')
    expect(rendered).toContain('child?:')
    expect(rendered).toContain('unknown')
  })

  it('renders bounds, example, and format as one compact JSDoc tag line', () => {
    const rendered = jsonSchemaToType({
      type: 'object',
      properties: {
        pageSize: { type: 'number', description: 'Entries per page.', minimum: 1, maximum: 2000, example: 10 },
        query: { type: 'string', format: 'c8y:query', example: '$filter=(owner+eq+\'manga\')' },
      },
    }, 'T')

    expect(rendered).toContain('* Entries per page.')
    expect(rendered).toContain('* @minimum 1 @maximum 2000 @example 10')
    expect(rendered).toContain('/** @example $filter=(owner+eq+\'manga\') @format c8y:query */')
    // Not opted in: no default tag.
    expect(rendered).not.toContain('@default')
  })

  it('quotes non-identifier property names', () => {
    const rendered = jsonSchemaToType({ type: 'object', properties: { 'X-Custom-Header': { type: 'string' } } }, 'T')
    expect(rendered).toContain('"X-Custom-Header"?: string;')
  })
})

describe('renderMethodDeclaration', () => {
  it('emits input/output aliases and a bare signature — docs live as JSDoc inside the types', () => {
    const { types, signature } = renderMethodDeclaration('c8y', 'getAlarm', {
      inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Alarm id' } }, required: ['id'] },
      outputSchema: { type: 'object', properties: { severity: { type: 'string' } } },
    })

    expect(types).toContain('type GetAlarmInput =')
    expect(types).toContain('/** Alarm id */')
    expect(types).toContain('type GetAlarmOutput =')
    expect(types).toContain('severity?: string;')
    expect(signature).toBe('c8y.getAlarm(input: GetAlarmInput): Promise<GetAlarmOutput>')
  })

  it('falls back to unknown output when no outputSchema exists', () => {
    const { types } = renderMethodDeclaration('c8y', 'getX', { inputSchema: { type: 'object' } })
    expect(types).toContain('type GetXOutput = unknown')
  })
})
