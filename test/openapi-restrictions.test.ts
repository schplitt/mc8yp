import { describe, expect, it } from 'vitest'
import { applyRestrictionsToOpenApiSpec } from '../src/codemode/openapi-restrictions'
import {
  RESTRICTED_OPERATION_FLAG,
  RESTRICTED_OPERATION_MESSAGE,
  RESTRICTED_OPERATION_RULES,
  RESTRICTED_OPERATION_TYPE,
  RESTRICTION_EXTENSION_KEY,
  parseAllowRule,
  parseRestrictionRule,
} from '../src/utils/restrictions'

function parseSingleRule(input: string) {
  const result = parseRestrictionRule([input])
  const rule = result.parsedRules[0]

  if (!rule || result.failedRules.length > 0) {
    throw new Error(`Expected a valid restriction rule: ${input}`)
  }

  return rule
}

function parseSingleAllowRule(input: string) {
  const result = parseAllowRule([input])
  const rule = result.parsedRules[0]

  if (!rule || result.failedRules.length > 0) {
    throw new Error(`Expected a valid allow rule: ${input}`)
  }

  return rule
}

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
    const restrictedSpec = applyRestrictionsToOpenApiSpec(spec, [parseSingleRule('GET:/inventory/**')])
    const restrictedOperation = restrictedSpec.paths['/inventory/managedObjects'].get

    expect(restrictedOperation.summary).toBe('List managed objects')
    expect(restrictedOperation.description).toBe('Returns the managed objects.')
    // @ts-expect-error - check for added metadata properties
    expect(restrictedOperation[RESTRICTED_OPERATION_FLAG]).toBe(true)
    // @ts-expect-error - check for added metadata properties
    expect(restrictedOperation[RESTRICTED_OPERATION_TYPE]).toBe('deny')
    // @ts-expect-error - check for added metadata properties
    expect(restrictedOperation[RESTRICTED_OPERATION_RULES]).toEqual(['GET:/inventory/**'])
    // @ts-expect-error - check for added metadata properties
    expect(restrictedOperation[RESTRICTED_OPERATION_MESSAGE]).toContain('blocked')
  })

  it('annotates operations outside the allow list as blocked', () => {
    const restrictedSpec = applyRestrictionsToOpenApiSpec(spec, [], [parseSingleAllowRule('GET:/inventory/**')])
    const blockedOperation = restrictedSpec.paths['/alarm/alarms'].get

    // @ts-expect-error - check for added metadata properties
    expect(blockedOperation[RESTRICTED_OPERATION_FLAG]).toBe(true)
    // @ts-expect-error - check for added metadata properties
    expect(blockedOperation[RESTRICTED_OPERATION_TYPE]).toBe('deny')
    // @ts-expect-error - check for added metadata properties
    expect(blockedOperation[RESTRICTED_OPERATION_RULES]).toEqual(['GET:/inventory/**'])
    // @ts-expect-error - check for added metadata properties
    expect(blockedOperation[RESTRICTED_OPERATION_MESSAGE]).toBe('This operation is blocked by the current MCP connection policy.')
  })

  it('lets restrictions take priority over matching allow rules', () => {
    const restrictedSpec = applyRestrictionsToOpenApiSpec(
      spec,
      [parseSingleRule('GET:/inventory/managedObjects')],
      [parseSingleAllowRule('GET:/inventory/**')],
    )
    const blockedOperation = restrictedSpec.paths['/inventory/managedObjects'].get

    // @ts-expect-error - check for added metadata properties
    expect(blockedOperation[RESTRICTED_OPERATION_TYPE]).toBe('deny')
    // @ts-expect-error - check for added metadata properties
    expect(blockedOperation[RESTRICTED_OPERATION_RULES]).toEqual(['GET:/inventory/managedObjects'])
  })

  it('leaves unrelated operations unchanged and adds top-level metadata', () => {
    const restrictedSpec = applyRestrictionsToOpenApiSpec(spec, [parseSingleRule('/inventory/**')])

    expect(restrictedSpec.paths['/alarm/alarms']).toBe(spec.paths['/alarm/alarms'])
    // @ts-expect-error - check for added metadata properties
    expect(restrictedSpec[RESTRICTION_EXTENSION_KEY]).toEqual({
      mode: 'deny',
      restrictions: ['/inventory/**'],
      allowed: [],
      message: 'Operations marked with x-mc8yp-restricted are intentionally blocked for the current MCP connection.',
    })
  })

  it('includes allow-list metadata when allow rules are configured', () => {
    const restrictedSpec = applyRestrictionsToOpenApiSpec(spec, [parseSingleRule('/inventory/managedObjects')], [parseSingleAllowRule('GET:/inventory/**')])

    // @ts-expect-error - check for added metadata properties
    expect(restrictedSpec[RESTRICTION_EXTENSION_KEY]).toEqual({
      mode: 'deny',
      restrictions: ['/inventory/managedObjects'],
      allowed: ['GET:/inventory/**'],
      message: 'Operations marked with x-mc8yp-restricted are intentionally blocked for the current MCP connection.',
    })
  })
})
