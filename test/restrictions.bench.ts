import { bench, describe } from 'vitest'
import { evaluateAccessPolicy, findBlockingRestrictions } from '../src/utils/restriction-matcher'
import { parseAllowRule, parseRestrictionRule } from '../src/utils/restrictions'

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

const rules = [
  parseSingleRule('/inventory/**'),
  parseSingleRule('GET:/alarm/**'),
  parseSingleRule('POST:/devicecontrol/**'),
]

const allowRules = [
  parseSingleAllowRule('/inventory/**'),
  parseSingleAllowRule('GET:/alarm/**'),
]

describe('restriction performance', () => {
  bench('findBlockingRestrictions hot path', () => {
    findBlockingRestrictions(rules, 'GET', '/inventory/managedObjects/123')
  })

  bench('evaluateAccessPolicy hot path', () => {
    evaluateAccessPolicy(rules, allowRules, 'GET', '/inventory/managedObjects/123')
  })
})
