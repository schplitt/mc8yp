/* eslint-disable antfu/no-top-level-await -- build-time CLI script run via `node`, not part of the shipped bundle */
// ─────────────────────────────────────────────────────────────────────────
// Build-time prebuild: embed every bundled CORE OpenAPI snapshot into a vector
// file.
//
// CORE ONLY, by design. Core is the always-present, never-changing surface, so
// it is worth prebuilding once and shipping. Every other source (DTM and any
// future service) is discovered per-tenant and embedded LIVE at runtime — never
// prebuilt here.
//
// For each core snapshot in openapi-builds.json `sources.core`, chunk it
// (chunkSpec) and embed the chunks with a pool of worker threads (one per CPU
// core), then write openapi/vectors/core/<version>.json. Runs locally / in CI
// — the embedding model is a devDependency and never ships in the microservice.
// The deployed service loads these prebuilt vectors instead of re-embedding the
// core corpus at startup.
//
// Run:  node scripts/build-spec-vectors.ts
//       DTYPE=fp32 MODEL=bge-base node scripts/build-spec-vectors.ts
//       WORKERS=4 node scripts/build-spec-vectors.ts
// ─────────────────────────────────────────────────────────────────────────

import { Buffer } from 'node:buffer'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import consola from 'consola'
import { embedTexts } from '../src/codemode/embed-pool.ts'
import { chunkSpec, CHUNKER_VERSION } from '../src/codemode/spec-chunker.ts'
import { preprocessOpenApi } from '../src/utils/openapi-preprocessor.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workerUrl = new URL('../src/codemode/embed-worker.ts', import.meta.url)

// Model registry. The chosen model + dtype are written into every vector file;
// the runtime query embedding MUST use the same pair for vectors to be
// comparable, so keep this the single source of truth.
const MODELS: Record<string, { hf: string, dim: number, passagePrefix: string }> = {
  'bge-base': { hf: 'Xenova/bge-base-en-v1.5', dim: 768, passagePrefix: '' },
  'bge-small': { hf: 'Xenova/bge-small-en-v1.5', dim: 384, passagePrefix: '' },
  'gte-base': { hf: 'Xenova/gte-base', dim: 768, passagePrefix: '' },
}

const MODEL_KEY = process.env.MODEL ?? 'bge-base'
const model = MODELS[MODEL_KEY]
if (!model)
  throw new Error(`Unknown MODEL "${MODEL_KEY}". Known: ${Object.keys(MODELS).join(', ')}`)
const DTYPE = process.env.DTYPE ?? 'q8'
// Default to ONE worker. onnxruntime-node intermittently crashes (native
// Napi::Error) when several sessions run inference concurrently in-process, so
// parallel workers are unreliable for a build step. A single worker does all
// core versions in ~80s, which is fine for a rarely-run prebuild. Override with
// WORKERS=N on platforms where concurrent sessions happen to be stable.
const WORKERS = process.env.WORKERS ? Number(process.env.WORKERS) : 1

function fmtEta(ms: number): string {
  if (!Number.isFinite(ms))
    return '…'
  const s = Math.ceil(ms / 1000)
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`
}

interface SourceEntry { version: string, label?: string }
const config = JSON.parse(readFileSync(resolve(root, 'openapi-builds.json'), 'utf8')) as {
  sources: Record<string, SourceEntry[]>
}

// CORE ONLY. Services (DTM etc.) are embedded live at runtime, never prebuilt.
const coreEntries = config.sources.core ?? []

consola.info(`Prebuilding CORE spec vectors with ${MODEL_KEY} (${model.hf}, dim ${model.dim}, dtype ${DTYPE}) using ${WORKERS} worker(s)`)

let totalChunks = 0
const written: string[] = []

for (const entry of coreEntries) {
  const specPath = resolve(root, 'openapi', 'core', `${entry.version}.json`)
  // Preprocess EXACTLY as the #core-openapi build plugin does (core => no
  // servicePrefix, default options) so the chunks here are byte-identical to
  // the ones the runtime re-derives from the inlined spec — same ids AND same
  // text, so the prebuilt embeddings line up and reflect what is searched
  // (including the `c8y:query` query-param annotation the preprocessor adds).
  const spec = await preprocessOpenApi(JSON.parse(readFileSync(specPath, 'utf8')))
  const chunks = chunkSpec('core', spec)

  consola.start(`core/${entry.version}: embedding ${chunks.length} chunks`)
  const t0 = performance.now()
  const embeddings = await embedTexts({
    texts: chunks.map((c) => c.text),
    dim: model.dim,
    model: model.hf,
    dtype: DTYPE,
    passagePrefix: model.passagePrefix,
    workers: WORKERS,
    createWorker: (options) => new Worker(workerUrl, options),
    onProgress: (done, total, etaMs) => {
      const pct = ((done / total) * 100).toFixed(0)
      process.stdout.write(`\r  core/${entry.version}: ${pct}% (${done}/${total}) ~${fmtEta(etaMs)} left      `)
    },
  })
  process.stdout.write('\n')

  const outDir = resolve(root, 'openapi', 'vectors', 'core')
  mkdirSync(outDir, { recursive: true })
  const outPath = resolve(outDir, `${entry.version}.json`)
  const payload = {
    model: model.hf,
    dim: model.dim,
    dtype: DTYPE,
    chunkerVersion: CHUNKER_VERSION,
    ids: chunks.map((c) => c.id),
    // base64 of the row-major Float32 matrix (chunks.length * dim floats)
    embeddings: Buffer.from(embeddings.buffer, embeddings.byteOffset, embeddings.byteLength).toString('base64'),
  }
  writeFileSync(outPath, `${JSON.stringify(payload)}\n`)

  const secs = ((performance.now() - t0) / 1000).toFixed(1)
  totalChunks += chunks.length
  written.push(relative(root, outPath))
  consola.success(`core/${entry.version}: ${chunks.length} chunks → ${relative(root, outPath)} (${secs}s)`)
}

consola.box(`Prebuilt ${written.length} core vector files, ${totalChunks} chunks total:\n${written.map((f) => `  • ${f}`).join('\n')}`)
