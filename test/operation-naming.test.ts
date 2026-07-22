import { describe, expect, it } from 'vitest'
import { operationName, sanitizeToolName, toPascalCase } from '../src/codemode/operation-naming'

describe('sanitizeToolName', () => {
  it('replaces separators, strips invalid chars, guards digits and reserved words', () => {
    expect(sanitizeToolName('my-tool')).toBe('my_tool')
    expect(sanitizeToolName('a.b c')).toBe('a_b_c')
    expect(sanitizeToolName('3d-render')).toBe('_3d_render')
    expect(sanitizeToolName('delete')).toBe('delete_')
    expect(sanitizeToolName('')).toBe('_')
    expect(sanitizeToolName('///')).toBe('_')
  })
})

describe('toPascalCase', () => {
  it('converts snake_case and camelCase identifiers', () => {
    expect(toPascalCase('get_alarm')).toBe('GetAlarm')
    expect(toPascalCase('getAlarm')).toBe('GetAlarm')
    expect(toPascalCase('managed_objects')).toBe('ManagedObjects')
  })
})

describe('operationName', () => {
  it('prefers the sanitized operationId when present', () => {
    expect(operationName('get', '/alarm/alarms', 'getAlarmCollectionResource')).toBe('getAlarmCollectionResource')
    expect(operationName('post', '/x', 'create-thing')).toBe('create_thing')
  })

  it('synthesizes readable camelCase names from method and path', () => {
    expect(operationName('get', '/alarm/alarms')).toBe('getAlarmAlarms')
    expect(operationName('post', '/alarm/alarms')).toBe('postAlarmAlarms')
    expect(operationName('get', '/service/dtm/assets')).toBe('getServiceDtmAssets')
  })

  it('renders path params as By<Param>', () => {
    expect(operationName('get', '/alarm/alarms/{id}')).toBe('getAlarmAlarmsById')
    expect(operationName('delete', '/inventory/managedObjects/{id}/childAssets/{childId}'))
      .toBe('deleteInventoryManagedObjectsByIdChildAssetsByChildId')
  })

  it('keeps different HTTP methods on the same path distinct', () => {
    const path = '/alarm/alarms'
    const names = ['get', 'post', 'put', 'delete'].map((m) => operationName(m, path))
    expect(new Set(names).size).toBe(names.length)
  })

  it('handles dashed segments and the root path', () => {
    expect(operationName('get', '/managed-objects')).toBe('getManagedObjects')
    expect(operationName('get', '/')).toBe('get')
  })
})
