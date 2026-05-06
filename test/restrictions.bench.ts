import { bench, describe } from 'vitest'
import { applyRestrictionsToOpenApiSpec } from '../src/codemode/openapi-restrictions'
import { findBlockingRestrictions } from '../src/utils/restriction-matcher'
import { parseRestrictionRule } from '../src/utils/restrictions'

function parseSingleRule(input: string) {
  const result = parseRestrictionRule([input])
  const rule = result.parsedRules[0]

  if (!rule || result.failedRules.length > 0) {
    throw new Error(`Expected a valid restriction rule: ${input}`)
  }

  return rule
}

const rules = [
  parseSingleRule('/inventory/**'),
  parseSingleRule('GET:/alarm/**'),
  parseSingleRule('POST:/devicecontrol/**'),
]

const spec = {
  openapi: '3.0.0',
  paths: Object.fromEntries(
    Array.from({ length: 250 }, (_, index) => {
      const path = index % 2 === 0
        ? `/inventory/managedObjects/${index}`
        : `/alarm/alarms/${index}`

      return [path, {
        get: {
          summary: `Summary ${index}`,
          description: `Description ${index}`,
        },
        post: {
          summary: `Post summary ${index}`,
          description: `Post description ${index}`,
        },
      }]
    }),
  ),
}

describe('restriction performance', () => {
  bench('findBlockingRestrictions hot path', () => {
    findBlockingRestrictions(rules, 'GET', '/inventory/managedObjects/123')
  })

  bench('applyRestrictionsToOpenApiSpec one-pass rewrite', () => {
    applyRestrictionsToOpenApiSpec(spec, rules)
  })
})
