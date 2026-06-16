import { describe, expect, it } from 'vitest'
import { resolveCodeModeExtension } from '../src/utils/resolve-xcodemode'
import type { Spec } from '../src/utils/spec-resolution'

const PROP_PATH_ITEM = {
  get: { summary: 'List property definitions' },
  post: { summary: 'Create property definition', requestBody: { required: true, content: {} } },
}

function makeSpec(overrides: Partial<Spec['paths']> = {}): Spec {
  return {
    paths: {
      '/definitions/properties': PROP_PATH_ITEM,
      '/definitions/assets': {
        post: {
          'summary': 'Create asset definition',
          'x-codemode': [
            {
              instruction: 'Ensure property definitions exist before creating an asset definition.',
              include: '/definitions/properties',
            },
          ],
        },
      },
      ...overrides,
    },
  }
}

describe('resolveCodeModeExtension — include mode', () => {
  it('embeds the referenced PathItem as includedSpec', () => {
    const spec = makeSpec()
    resolveCodeModeExtension(spec, '/service/dtm')
    const hints = (spec.paths['/definitions/assets']?.post as Record<string, unknown>)?.['x-codemode'] as { includedSpec?: unknown }[]
    expect(hints[0]?.includedSpec).toEqual(PROP_PATH_ITEM)
  })

  it('sets includedPath to servicePrefix + include', () => {
    const spec = makeSpec()
    resolveCodeModeExtension(spec, '/service/dtm')
    const hints = (spec.paths['/definitions/assets']?.post as Record<string, unknown>)?.['x-codemode'] as { includedPath?: string }[]
    expect(hints[0]?.includedPath).toBe('/service/dtm/definitions/properties')
  })

  it('works without a servicePrefix', () => {
    const spec = makeSpec()
    resolveCodeModeExtension(spec)
    const hints = (spec.paths['/definitions/assets']?.post as Record<string, unknown>)?.['x-codemode'] as { includedPath?: string, includedSpec?: unknown }[]
    expect(hints[0]?.includedPath).toBe('/definitions/properties')
    expect(hints[0]?.includedSpec).toEqual(PROP_PATH_ITEM)
  })

  it('leaves includedSpec unset when include target path is absent', () => {
    const spec: Spec = {
      paths: {
        '/definitions/assets': {
          post: {
            'x-codemode': [{ instruction: 'hint', include: '/does/not/exist' }],
          },
        },
      },
    }
    resolveCodeModeExtension(spec, '/service/dtm')
    const hints = (spec.paths['/definitions/assets']?.post as Record<string, unknown>)?.['x-codemode'] as { includedSpec?: unknown, includedPath?: string }[]
    expect(hints[0]?.includedSpec).toBeUndefined()
    expect(hints[0]?.includedPath).toBe('/service/dtm/does/not/exist')
  })
})

describe('resolveCodeModeExtension — query mode', () => {
  it('sets queryPath to servicePrefix + query', () => {
    const spec: Spec = {
      paths: {
        '/definitions/properties': PROP_PATH_ITEM,
        '/definitions/assets': {
          post: {
            'x-codemode': [
              {
                instruction: 'Check property definitions if needed.',
                query: '/definitions/properties',
              },
            ],
          },
        },
      },
    }
    resolveCodeModeExtension(spec, '/service/dtm')
    const hints = (spec.paths['/definitions/assets']?.post as Record<string, unknown>)?.['x-codemode'] as { queryPath?: string, includedSpec?: unknown }[]
    expect(hints[0]?.queryPath).toBe('/service/dtm/definitions/properties')
    expect(hints[0]?.includedSpec).toBeUndefined()
  })
})

describe('resolveCodeModeExtension — instruction-only', () => {
  it('leaves instruction-only items unchanged', () => {
    const spec: Spec = {
      paths: {
        '/things': {
          post: {
            'x-codemode': [{ instruction: 'Use X-Upsert-Mode for idempotency.' }],
          },
        },
      },
    }
    resolveCodeModeExtension(spec, '/service/dtm')
    const hints = (spec.paths['/things']?.post as Record<string, unknown>)?.['x-codemode'] as Record<string, unknown>[]
    expect(hints[0]).toEqual({ instruction: 'Use X-Upsert-Mode for idempotency.' })
  })
})

describe('resolveCodeModeExtension — multiple items', () => {
  it('processes all items in the array independently', () => {
    const spec: Spec = {
      paths: {
        '/definitions/properties': PROP_PATH_ITEM,
        '/definitions/assets': {
          post: {
            'x-codemode': [
              { instruction: 'Instruction only.' },
              { instruction: 'Embed this.', include: '/definitions/properties' },
              { instruction: 'Hint this.', query: '/definitions/properties' },
            ],
          },
        },
      },
    }
    resolveCodeModeExtension(spec, '/service/dtm')
    const hints = (spec.paths['/definitions/assets']?.post as Record<string, unknown>)?.['x-codemode'] as Record<string, unknown>[]
    expect(hints[0]).toEqual({ instruction: 'Instruction only.' })
    expect(hints[1]?.includedSpec).toEqual(PROP_PATH_ITEM)
    expect(hints[1]?.includedPath).toBe('/service/dtm/definitions/properties')
    expect(hints[2]?.queryPath).toBe('/service/dtm/definitions/properties')
    expect(hints[2]?.includedSpec).toBeUndefined()
  })
})

describe('resolveCodeModeExtension — spec without x-codemode', () => {
  it('is a no-op on operations without x-codemode', () => {
    const spec: Spec = {
      paths: {
        '/items': {
          get: { summary: 'List items' },
          post: { summary: 'Create item' },
        },
      },
    }
    const before = JSON.stringify(spec)
    resolveCodeModeExtension(spec, '/service/foo')
    expect(JSON.stringify(spec)).toBe(before)
  })
})
