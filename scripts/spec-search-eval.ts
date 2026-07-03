/* eslint-disable no-console, antfu/no-top-level-await, node/prefer-global/process, style/max-statements-per-line -- standalone CLI eval script run via `node`, not part of the shipped bundle */
// ─────────────────────────────────────────────────────────────────────────
// Phase A: offline retrieval bake-off for spec search.
//
// Goal: pick an embedding model and prove cross-reference / vocabulary-gap
// retrieval works, on the REAL bundled specs, using BRUTE-FORCE EXACT cosine
// (no ANN index). Exact is the ground truth: it isolates model quality from any
// index approximation, so a later PGlite+pgvector (HNSW) pass can be measured
// against these numbers instead of flying blind.
//
// Run (Node 26 strips the TS types directly — no tsx):
//   node scripts/spec-search-eval.ts
//   DTYPE=fp32 node scripts/spec-search-eval.ts     # full precision (bigger/slower)
//   MODELS=bge-base,gte-base node scripts/spec-search-eval.ts
//   VERBOSE=1 node scripts/spec-search-eval.ts      # per-case detail
//
// First run downloads each model to ~/.cache/huggingface (one-time).
// ─────────────────────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { env, pipeline } from '@huggingface/transformers'
import MiniSearch from 'minisearch'
import { buildSpecChunks } from '../src/codemode/spec-chunker.ts'
import type { SpecChunk } from '../src/codemode/spec-chunker.ts'
import { EVAL_SET } from '../test/fixtures/search-eval-set.ts'
import type { EvalCase } from '../test/fixtures/search-eval-set.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')

// ── config ──────────────────────────────────────────────────────────────
const DTYPE = (process.env.DTYPE ?? 'q8') as 'q8' | 'fp32' | 'fp16'
const VERBOSE = process.env.VERBOSE === '1'
const BATCH = 16

const LIMIT = 8 // primary hits returned
const MAX_RELATED = 5 // global cap on neighbours across the whole result
const EXPAND_FROM_TOP = 5 // expand neighbours from this many top primary hits
const NEIGHBORS_PER_ANCHOR = 3 // nearest other-source fragments pulled per anchor
const RELATED_MIN_SIM = 0.4 // cosine floor a neighbour must clear to attach
const PREVIEW_CHARS = 800 // preview truncation, for context-volume accounting
const RRF_K = 60 // reciprocal-rank-fusion constant
const W_VEC = 1.0 // fusion weight on the (stronger) vector ranking
const W_KW = 0.4 // fusion weight on the (noisier) keyword ranking

interface ModelConfig {
  key: string
  hfModel: string
  dim: number
  queryPrefix: string
  passagePrefix: string
}

const ALL_MODELS: ModelConfig[] = [
  { key: 'minilm-l6', hfModel: 'Xenova/all-MiniLM-L6-v2', dim: 384, queryPrefix: '', passagePrefix: '' },
  { key: 'bge-small', hfModel: 'Xenova/bge-small-en-v1.5', dim: 384, queryPrefix: 'Represent this sentence for searching relevant passages: ', passagePrefix: '' },
  { key: 'gte-base', hfModel: 'Xenova/gte-base', dim: 768, queryPrefix: '', passagePrefix: '' },
  { key: 'bge-base', hfModel: 'Xenova/bge-base-en-v1.5', dim: 768, queryPrefix: 'Represent this sentence for searching relevant passages: ', passagePrefix: '' },
  { key: 'bge-large', hfModel: 'Xenova/bge-large-en-v1.5', dim: 1024, queryPrefix: 'Represent this sentence for searching relevant passages: ', passagePrefix: '' },
]

const selected = process.env.MODELS?.split(',').map((s) => s.trim()).filter(Boolean)
const MODELS = selected?.length ? ALL_MODELS.filter((m) => selected.includes(m.key)) : ALL_MODELS

// ── helpers ─────────────────────────────────────────────────────────────
type Ranked = Array<{ sourceId: string, score: number, chunkIndex: number }>

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!
  return s
}

// Collapse fragment-level scores to one row per sourceId (best fragment wins),
// sorted best-first.
function collapseBySource(scores: Array<{ sourceId: string, score: number, chunkIndex: number }>): Ranked {
  const best = new Map<string, { sourceId: string, score: number, chunkIndex: number }>()
  for (const row of scores) {
    const cur = best.get(row.sourceId)
    if (!cur || row.score > cur.score)
      best.set(row.sourceId, row)
  }
  return [...best.values()].sort((a, b) => b.score - a.score)
}

function rankVector(qVec: Float32Array, vectors: Float32Array[], chunks: SpecChunk[]): Ranked {
  return collapseBySource(vectors.map((v, i) => ({ sourceId: chunks[i]!.sourceId, score: dot(qVec, v), chunkIndex: i })))
}

function rankKeyword(ms: MiniSearch, query: string): Ranked {
  // @ts-expect-error: MiniSearch's search() returns a generic array of hits, but we know our storeFields are sourceId/header/kind/spec
  const results = ms.search(query, { fuzzy: 0.2, prefix: true }) as Array<{ id: number, score: number, sourceId: string }>
  return collapseBySource(results.map((r) => ({ sourceId: r.sourceId, score: r.score, chunkIndex: r.id })))
}

// Weighted reciprocal rank fusion. Vector is the stronger signal on this
// corpus, so it carries more weight; keyword only nudges exact-token matches up.
function rrf(vec: Ranked, kw: Ranked): Ranked {
  const rankOf = (list: Ranked): Map<string, number> => new Map(list.map((r, i) => [r.sourceId, i + 1]))
  const rv = rankOf(vec)
  const rk = rankOf(kw)
  const chunkOf = new Map<string, number>([...vec, ...kw].map((r) => [r.sourceId, r.chunkIndex]))
  const ids = new Set([...rv.keys(), ...rk.keys()])
  const fused: Ranked = []
  for (const id of ids) {
    const sv = rv.has(id) ? W_VEC / (RRF_K + rv.get(id)!) : 0
    const sk = rk.has(id) ? W_KW / (RRF_K + rk.get(id)!) : 0
    fused.push({ sourceId: id, score: sv + sk, chunkIndex: chunkOf.get(id)! })
  }
  return fused.sort((a, b) => b.score - a.score)
}

// Neighbour expansion: from each of the top primary hits, pull its
// NEIGHBORS_PER_ANCHOR nearest OTHER-source fragments (cross-references) above a
// similarity floor, then dedupe by sourceId across anchors and globally cap.
// This is the generic "follow the reference" mechanism — no hardcoded links.
function expandNeighbours(primary: Ranked, vectors: Float32Array[], chunks: SpecChunk[]): Ranked {
  const primaryIds = new Set(primary.slice(0, LIMIT).map((r) => r.sourceId))
  const related = new Map<string, { sourceId: string, score: number, chunkIndex: number }>()
  for (const hit of primary.slice(0, EXPAND_FROM_TOP)) {
    const anchor = vectors[hit.chunkIndex]!
    const perAnchor: Array<{ sourceId: string, score: number, chunkIndex: number }> = []
    for (let i = 0; i < vectors.length; i++) {
      const sid = chunks[i]!.sourceId
      if (primaryIds.has(sid))
        continue
      const sim = dot(anchor, vectors[i]!)
      if (sim >= RELATED_MIN_SIM)
        perAnchor.push({ sourceId: sid, score: sim, chunkIndex: i })
    }
    perAnchor.sort((a, b) => b.score - a.score)
    for (const cand of perAnchor.slice(0, NEIGHBORS_PER_ANCHOR)) {
      const cur = related.get(cand.sourceId)
      if (!cur || cand.score > cur.score)
        related.set(cand.sourceId, cand)
    }
  }
  return [...related.values()].sort((a, b) => b.score - a.score).slice(0, MAX_RELATED)
}

function rankOfSource(ranked: Ranked, sourceId: string): number {
  const i = ranked.findIndex((r) => r.sourceId === sourceId)
  return i < 0 ? Infinity : i + 1
}

function hit(ranked: Ranked, expect: string[], k: number): boolean {
  const top = new Set(ranked.slice(0, k).map((r) => r.sourceId))
  return expect.some((e) => top.has(e))
}

// ── load specs + build the shared chunk space ─────────────────────────────
const core = JSON.parse(readFileSync(resolve(root, 'openapi/core/release.json'), 'utf8'))
const dtm = JSON.parse(readFileSync(resolve(root, 'openapi/dtm/release.json'), 'utf8'))
const chunks = buildSpecChunks(core, { dtm }, {})
const splitSources = new Set(chunks.filter((c) => c.part).map((c) => c.sourceId))
console.log(`\nCorpus: ${chunks.length} chunks from ${new Set(chunks.map((c) => c.sourceId)).size} sources `
  + `(${splitSources.size} sources were split). Eval cases: ${EVAL_SET.length}.\n`)

// keyword index (shared across all models — built once)
const ms = new MiniSearch({ fields: ['text'], storeFields: ['sourceId', 'header', 'kind', 'spec'] })
// NB: `id: i` must come AFTER `...c` — SpecChunk has its own string `id`, and
// we need MiniSearch's doc id to be the numeric chunk index (used as chunkIndex).
ms.addAll(chunks.map((c, i) => ({ ...c, id: i })))

// keyword-only baseline (model-independent)
const keywordRanks = EVAL_SET.map((c) => rankKeyword(ms, c.query))

async function embed(extractor: any, texts: string[]): Promise<Float32Array[]> {
  const out: Float32Array[] = []
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH)
    const t = await extractor(batch, { pooling: 'mean', normalize: true })
    const rows = t.tolist() as number[][]
    for (const row of rows) out.push(Float32Array.from(row))
    process.stdout.write(`\r    embedded ${Math.min(i + BATCH, texts.length)}/${texts.length}   `)
  }
  process.stdout.write('\n')
  return out
}

interface Recall { r1: number, r5: number, r10: number }
interface Timing { loadMs: number, indexMs: number, queryEmbedMs: number, searchMs: number }
interface ModelSummary {
  model: string
  dim: number
  keyword: Recall
  vector: Recall
  hybrid: Recall
  /**
   * xref cases where the referenced chunk surfaced at all (primary or related).
   */
  xrefSurfaced: number
  /**
   * xref cases where it surfaced ONLY because of neighbour expansion.
   */
  xrefByExpansion: number
  timing: Timing
  ctxPerQuery: number
}
const summary: ModelSummary[] = []

const KINDS = ['vocab-gap', 'deep', 'cross-ref', 'normal'] as const
const n = EVAL_SET.length
const nXref = EVAL_SET.filter((c) => c.crossRef).length
const pct = (x: number, d = n): string => `${((x / d) * 100).toFixed(0)}%`

env.allowRemoteModels = true

for (const model of MODELS) {
  console.log(`\n══ ${model.key}  (${model.hfModel}, dim ${model.dim}, dtype ${DTYPE}) ══`)
  const tLoad = performance.now()
  const extractor = await pipeline('feature-extraction', model.hfModel, { dtype: DTYPE })
  const loadMs = performance.now() - tLoad

  console.log('  embedding corpus (this is the on-the-fly INDEXING cost)…')
  const tIndex = performance.now()
  const vectors = await embed(extractor, chunks.map((c) => model.passagePrefix + c.text))
  const indexMs = performance.now() - tIndex

  console.log('  embedding queries…')
  const tQ = performance.now()
  const queryVecs = await embed(extractor, EVAL_SET.map((c) => model.queryPrefix + c.query))
  const queryEmbedMs = (performance.now() - tQ) / n

  const mk = (): Recall => ({ r1: 0, r5: 0, r10: 0 })
  const keyword = mk()
  const vector = mk()
  const hybrid = mk()
  const kindTotal: Record<string, number> = {}
  const kindVec: Record<string, number> = {}
  const kindHyb: Record<string, number> = {}
  for (const k of KINDS) {
    kindTotal[k] = 0; kindVec[k] = 0; kindHyb[k] = 0
  }

  let searchMsTotal = 0
  let ctxTotal = 0
  let xrefSurfaced = 0
  let xrefByExpansion = 0
  const xrefRows: Array<{ query: string, vecRank: number, hybRank: number, byExpansion: boolean, surfaced: boolean }> = []

  EVAL_SET.forEach((evalCase: EvalCase, idx) => {
    const kw = keywordRanks[idx]!
    const tSearch = performance.now()
    const vec = rankVector(queryVecs[idx]!, vectors, chunks)
    const hyb = rrf(vec, kw)
    const related = expandNeighbours(hyb, vectors, chunks)
    searchMsTotal += performance.now() - tSearch

    const tally = (acc: Recall, ranked: Ranked): void => {
      acc.r1 += hit(ranked, evalCase.expect, 1) ? 1 : 0
      acc.r5 += hit(ranked, evalCase.expect, 5) ? 1 : 0
      acc.r10 += hit(ranked, evalCase.expect, 10) ? 1 : 0
    }
    tally(keyword, kw)
    tally(vector, vec)
    tally(hybrid, hyb)

    kindTotal[evalCase.kind]!++
    if (hit(vec, evalCase.expect, 5))
      kindVec[evalCase.kind]!++
    if (hit(hyb, evalCase.expect, 5))
      kindHyb[evalCase.kind]!++

    // returned result = top primary hits + capped related neighbours
    const returned: Ranked = [...hyb.slice(0, LIMIT), ...related]
    ctxTotal += returned.reduce((s, r) => s + Math.min(chunks[r.chunkIndex]!.text.length, PREVIEW_CHARS), 0)

    if (evalCase.crossRef) {
      const vecRank = rankOfSource(vec, evalCase.crossRef)
      const hybRank = rankOfSource(hyb, evalCase.crossRef)
      const inPrimary = hybRank <= LIMIT
      const inRelated = related.some((r) => r.sourceId === evalCase.crossRef)
      const surfaced = inPrimary || inRelated
      const byExpansion = !inPrimary && inRelated
      if (surfaced)
        xrefSurfaced++
      if (byExpansion)
        xrefByExpansion++
      xrefRows.push({ query: evalCase.query, vecRank, hybRank, byExpansion, surfaced })
    }

    if (VERBOSE) {
      const found = hit(hyb, evalCase.expect, 10)
      console.log(`    [${found ? '✓' : '✗'}] (${evalCase.kind}) "${evalCase.query}"`)
      console.log(`         → ${returned.slice(0, 5).map((r) => r.sourceId).join('  |  ')}`)
    }
  })

  console.log(`\n  ${'config'.padEnd(10)} ${'R@1'.padStart(5)} ${'R@5'.padStart(5)} ${'R@10'.padStart(5)}`)
  console.log(`  ${'keyword'.padEnd(10)} ${pct(keyword.r1).padStart(5)} ${pct(keyword.r5).padStart(5)} ${pct(keyword.r10).padStart(5)}`)
  console.log(`  ${'vector'.padEnd(10)} ${pct(vector.r1).padStart(5)} ${pct(vector.r5).padStart(5)} ${pct(vector.r10).padStart(5)}`)
  console.log(`  ${'hybrid'.padEnd(10)} ${pct(hybrid.r1).padStart(5)} ${pct(hybrid.r5).padStart(5)} ${pct(hybrid.r10).padStart(5)}`)

  console.log(`\n  R@5 by case kind (vector / hybrid):`)
  for (const k of KINDS)
    console.log(`    ${k.padEnd(10)} ${pct(kindVec[k]!, kindTotal[k]!).padStart(5)} / ${pct(kindHyb[k]!, kindTotal[k]!).padStart(5)}   (${kindTotal[k]} cases)`)

  console.log(`\n  cross-reference resolution (${xrefSurfaced}/${nXref} surfaced, ${xrefByExpansion} only via neighbour expansion):`)
  for (const r of xrefRows) {
    const mark = r.surfaced ? (r.byExpansion ? 'via-expansion' : 'in-primary') : 'MISSED'
    const vr = r.vecRank === Infinity ? '—' : `#${r.vecRank}`
    console.log(`    [${mark.padEnd(13)}] vecRank ${vr.padStart(4)}  "${r.query}"`)
  }

  console.log(`\n  timing:  model-load ${(loadMs / 1000).toFixed(1)}s | INDEX ${(indexMs / 1000).toFixed(1)}s for ${chunks.length} chunks (${(chunks.length / (indexMs / 1000)).toFixed(0)} chunks/s) | query-embed ${queryEmbedMs.toFixed(0)}ms | brute-force search ${(searchMsTotal / n).toFixed(1)}ms/query`)
  console.log(`  avg context returned: ${Math.round(ctxTotal / n)} chars/query (${LIMIT} primary + up to ${MAX_RELATED} related)`)

  summary.push({ model: model.key, dim: model.dim, keyword, vector, hybrid, xrefSurfaced, xrefByExpansion, ctxPerQuery: Math.round(ctxTotal / n), timing: { loadMs, indexMs, queryEmbedMs, searchMs: searchMsTotal / n } })
}

// ── final cross-model summary ─────────────────────────────────────────────
console.log(`\n\n════════ SUMMARY ════════`)
console.log(`(R@k on hybrid = vector+keyword RRF. xref = cross-ref chunks surfaced / ${nXref}. index = on-the-fly cost for ${chunks.length} chunks.)\n`)
console.log(`${'model'.padEnd(11)} ${'dim'.padStart(4)} ${'vR@5'.padStart(5)} ${'vR@10'.padStart(6)} ${'hR@5'.padStart(5)} ${'hR@10'.padStart(6)} ${'xref'.padStart(5)} ${'index'.padStart(7)} ${'q-emb'.padStart(6)} ${'ctx/q'.padStart(6)}`)
for (const s of summary) {
  console.log(
    `${s.model.padEnd(11)} ${String(s.dim).padStart(4)} `
    + `${pct(s.vector.r5).padStart(5)} ${pct(s.vector.r10).padStart(6)} `
    + `${pct(s.hybrid.r5).padStart(5)} ${pct(s.hybrid.r10).padStart(6)} `
    + `${`${s.xrefSurfaced}/${nXref}`.padStart(5)} `
    + `${`${(s.timing.indexMs / 1000).toFixed(1)}s`.padStart(7)} `
    + `${`${s.timing.queryEmbedMs.toFixed(0)}ms`.padStart(6)} `
    + `${String(s.ctxPerQuery).padStart(6)}`,
  )
}
console.log('')
