import { describe, expect, it } from 'vitest'
import { applyRestrictionsToOpenApiSpec } from '../src/codemode/openapi-restrictions'
import {
  RESTRICTED_OPERATION_FLAG,
  RESTRICTED_OPERATION_MESSAGE,
  RESTRICTED_OPERATION_RULES,
  RESTRICTION_EXTENSION_KEY,
  parseRestrictionRule,
} from '../src/utils/restrictions'

describe('applyRestrictionsToOpenApiSpec', () => {
  const spec = {
    openapi: '3.0.0',
    paths: {
      '/inventory/managedObjects': {
        get: {
          summary: 'List managed objects',
          description: 'Returns the managed objects.',
        },
        post: {
          summary: 'Create managed object',
          description: 'Creates a new managed object.',
        },
      },
      '/alarm/alarms': {
        get: {
          summary: 'List alarms',
          description: 'Returns alarms.',
        },
      },
    },
  }

  it('preserves summary and description while annotating restricted operations', () => {
    const restrictedSpec = applyRestrictionsToOpenApiSpec(spec, [parseRestrictionRule('GET:/inventory/**')])
    const restrictedOperation = restrictedSpec.paths['/inventory/managedObjects'].get

    expect(restrictedOperation.summary).toBe('List managed objects')
    expect(restrictedOperation.description).toBe('Returns the managed objects.')
    // @ts-expect-error - check for added metadata properties
    expect(restrictedOperation[RESTRICTED_OPERATION_FLAG]).toBe(true)
    // @ts-expect-error - check for added metadata properties
    expect(restrictedOperation[RESTRICTED_OPERATION_RULES]).toEqual(['GET:/inventory/**'])
    // @ts-expect-error - check for added metadata properties
    expect(restrictedOperation[RESTRICTED_OPERATION_MESSAGE]).toContain('blocked')
  })

  it('leaves unrelated operations unchanged and adds top-level metadata', () => {
    const restrictedSpec = applyRestrictionsToOpenApiSpec(spec, [parseRestrictionRule('/inventory/**')])

    expect(restrictedSpec.paths['/alarm/alarms']).toBe(spec.paths['/alarm/alarms'])
    // @ts-expect-error - check for added metadata properties
    expect(restrictedSpec[RESTRICTION_EXTENSION_KEY]).toEqual({
      mode: 'deny',
      rules: ['/inventory/**'],
      message: 'Operations marked with x-mc8yp-restricted are intentionally blocked for the current MCP connection.',
    })
  })
})