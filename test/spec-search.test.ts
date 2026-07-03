import { describe, expect, it } from 'vitest'
import { loadCoreIndex } from '../src/codemode/spec-search'

// These exercise the prebuilt-vectors ↔ chunker contract WITHOUT the embedding
// model: loadCoreIndex decodes the inlined core vectors, re-chunks the inlined
// core spec, and asserts they line up (chunkerVersion + id alignment). Search
// quality itself (which needs the model) is covered by scripts/spec-search-eval.
describe('spec-search — core index', () => {
  it('loads prebuilt core vectors and zips them onto the re-chunked core spec', () => {
    const index = loadCoreIndex()
    expect(index.chunks.length).toBeGreaterThan(0)
    expect(index.dim).toBeGreaterThan(0)
    // the matrix is exactly chunks × dim — proves the drift guard passed and
    // every chunk got its vector
    expect(index.matrix.length).toBe(index.chunks.length * index.dim)
    // every hit can be navigated back to source via a pasteable header accessor
    expect(index.chunks.every((c) => typeof c.header === 'string' && c.header.length > 0)).toBe(true)
  })

  it('caches the core index (same reference across calls)', () => {
    expect(loadCoreIndex()).toBe(loadCoreIndex())
  })
})
