/* eslint-disable antfu/no-top-level-await -- worker module entry; top-level await loads the model once before handling jobs */
// ─────────────────────────────────────────────────────────────────────────
// Embedding worker (worker_threads entry).
//
// Loads the embedding model ONCE, then embeds one shard of passages and writes
// each vector directly into a caller-provided SharedArrayBuffer at its row
// offset — so the result never has to be serialized back across the thread
// boundary. Used both at build time (a pool of these, one shard each) and at
// runtime (a single background worker so the deployed server's main thread
// stays responsive while a discovered spec is embedded).
//
// Bundled into the server/CLI output via the `?thread` worker plugin; run
// directly (Node strips the TS types) by the build-time prebuild script.
//
// Protocol — workerData: { model, dtype, intraOpNumThreads? }; ← { type:'ready' }
// once loaded. Two job shapes:
//   ShardJob (build):   writes vectors into a SharedArrayBuffer → 'progress'* then 'shardDone'
//   EmbedJob (runtime): returns vectors by message → 'embedProgress'* then 'embedResult'
//   either → { type:'error', id?, message } on failure
// ─────────────────────────────────────────────────────────────────────────

import { parentPort, workerData } from 'node:worker_threads'
import { pipeline } from '@huggingface/transformers'

interface EmbedWorkerData {
  model: string
  dtype: string
  /**
   * Optional onnxruntime intra-op thread count (uses multiple cores for ONE
   * session — the only *safe* parallelism, unlike concurrent sessions).
   */
  intraOpNumThreads?: number
}

/**
 * Build-time job: write each vector into a shared Float32 matrix at its row.
 */
export interface ShardJob {
  type: 'shard'
  texts: string[]
  rowOffset: number
  dim: number
  sab: SharedArrayBuffer
  passagePrefix: string
  batch: number
}

/**
 * Runtime job: embed texts and return the vectors via postMessage.
 */
export interface EmbedJob {
  type: 'embed'
  id: number
  texts: string[]
  passagePrefix: string
  batch: number
}

type Job = ShardJob | EmbedJob

if (!parentPort)
  throw new Error('embed-worker.ts must be run as a worker thread')
const port = parentPort

const { model, dtype, intraOpNumThreads } = workerData as EmbedWorkerData
const extractor = await pipeline('feature-extraction', model, {
  dtype: dtype as 'q8' | 'fp32' | 'fp16',
  ...(intraOpNumThreads && intraOpNumThreads > 1 ? { session_options: { intraOpNumThreads } } : {}),
})
port.postMessage({ type: 'ready' })

port.on('message', async (job: Job) => {
  try {
    if (job.type === 'shard') {
      const view = new Float32Array(job.sab)
      for (let i = 0; i < job.texts.length; i += job.batch) {
        const slice = job.texts.slice(i, i + job.batch).map((t) => job.passagePrefix + t)
        const out = await extractor(slice, { pooling: 'mean', normalize: true })
        const rows = out.tolist() as number[][]
        for (let j = 0; j < rows.length; j++)
          view.set(rows[j]!, (job.rowOffset + i + j) * job.dim)
        port.postMessage({ type: 'progress', count: rows.length })
      }
      port.postMessage({ type: 'shardDone' })
    } else {
      const vectors: number[][] = []
      for (let i = 0; i < job.texts.length; i += job.batch) {
        const slice = job.texts.slice(i, i + job.batch).map((t) => job.passagePrefix + t)
        const out = await extractor(slice, { pooling: 'mean', normalize: true })
        for (const row of out.tolist() as number[][]) vectors.push(row)
        port.postMessage({ type: 'embedProgress', id: job.id, done: Math.min(i + job.batch, job.texts.length) })
      }
      port.postMessage({ type: 'embedResult', id: job.id, vectors })
    }
  } catch (err) {
    port.postMessage({ type: 'error', id: (job as EmbedJob).id, message: (err as Error).message })
  }
})
