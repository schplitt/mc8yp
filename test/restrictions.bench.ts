import { bench, describe } from 'vitest'
import { applyRestrictionsToOpenApiSpec } from '../src/codemode/openapi-restrictions'
import { evaluateRestrictions, parseRestrictionRule } from '../src/utils/restrictions'

const rules = [
  parseRestrictionRule('/inventory/**'),
  parseRestrictionRule('GET:/alarm/**'),
  parseRestrictionRule('POST:/devicecontrol/**'),
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
  bench('evaluateRestrictions hot path', () => {
    evaluateRestrictions(rules, 'GET', '/inventory/managedObjects/123?foo=bar')
  })

  bench('applyRestrictionsToOpenApiSpec one-pass rewrite', () => {
    applyRestrictionsToOpenApiSpec(spec, rules)
  })
})