import { describe, expect, it } from 'vitest'
import { getMethodIndex, searchMethods } from '../src/codemode/method-search'
import type { SearchableMethod } from '../src/codemode/method-search'

const ITEMS: SearchableMethod[] = [
  { target: 'c8y.getAlarmCollectionResource', namespace: 'c8y', method: 'getAlarmCollectionResource', httpMethod: 'GET', apiPath: '/alarm/alarms', summary: 'Retrieve all alarms' },
  { target: 'c8y.postAlarmCollectionResource', namespace: 'c8y', method: 'postAlarmCollectionResource', httpMethod: 'POST', apiPath: '/alarm/alarms', summary: 'Create an alarm' },
  { target: 'c8y.getManagedObjectCollectionResource', namespace: 'c8y', method: 'getManagedObjectCollectionResource', httpMethod: 'GET', apiPath: '/inventory/managedObjects', summary: 'Retrieve all managed objects' },
  { target: 'dtm.getAssets', namespace: 'dtm', method: 'getAssets', httpMethod: 'GET', apiPath: '/service/dtm/assets', summary: 'Retrieve assets' },
  { target: 'dtm.getAsset', namespace: 'dtm', method: 'getAsset', httpMethod: 'GET', apiPath: '/service/dtm/assets/{assetId}', summary: 'Retrieve an existing asset' },
]

function index() {
  return getMethodIndex({}, () => ITEMS)
}

describe('searchMethods', () => {
  it('ranks exact method-name matches first', () => {
    const { results } = searchMethods(index(), 'getAssets')
    expect(results[0]!.target).toBe('dtm.getAssets')
  })

  it('tokenizes camelCase and matches across singular/plural via fuzziness', () => {
    const { results } = searchMethods(index(), 'dtm asset')
    const targets = results.map((r) => r.target)
    expect(targets).toContain('dtm.getAssets')
    expect(targets).toContain('dtm.getAsset')
  })

  it('keeps recall when one query word has no counterpart in the spec vocabulary', () => {
    // "list" appears nowhere; OR-combination still ranks the assets methods.
    const { results } = searchMethods(index(), 'list assets')
    expect(results.some((r) => r.target === 'dtm.getAssets')).toBe(true)
  })

  it('unions multiple query phrasings, deduped by best score', () => {
    const single = searchMethods(index(), 'managed objects')
    const multi = searchMethods(index(), ['managed objects', 'alarms'])
    expect(multi.results.map((r) => r.target)).toContain('c8y.getManagedObjectCollectionResource')
    expect(multi.results.map((r) => r.target)).toContain('c8y.getAlarmCollectionResource')
    expect(multi.total).toBeGreaterThanOrEqual(single.total)
  })

  it('filters hidden methods at query time', () => {
    const { results } = searchMethods(index(), 'alarms', (target) => target !== 'c8y.postAlarmCollectionResource')
    expect(results.some((r) => r.target === 'c8y.postAlarmCollectionResource')).toBe(false)
    expect(results.some((r) => r.target === 'c8y.getAlarmCollectionResource')).toBe(true)
  })

  it('returns empty output for empty queries', () => {
    expect(searchMethods(index(), '')).toEqual({ results: [], total: 0, truncated: false })
    expect(searchMethods(index(), ['   ', ''])).toEqual({ results: [], total: 0, truncated: false })
  })

  it('caps results at 20 and reports truncation', () => {
    const many: SearchableMethod[] = Array.from({ length: 60 }, (_, i) => ({
      target: `c8y.getAlarmThing${i}`,
      namespace: 'c8y',
      method: `getAlarmThing${i}`,
      httpMethod: 'GET',
      apiPath: `/alarm/things/${i}`,
      summary: 'Alarm thing',
    }))
    const output = searchMethods(getMethodIndex({}, () => many), 'alarm thing')
    expect(output.results).toHaveLength(20)
    expect(output.total).toBe(60)
    expect(output.truncated).toBe(true)
  })

  it('caches the index by cache-key identity', () => {
    const key = {}
    expect(getMethodIndex(key, () => ITEMS)).toBe(getMethodIndex(key, () => ITEMS))
    expect(getMethodIndex({}, () => ITEMS)).not.toBe(getMethodIndex({}, () => ITEMS))
  })
})
