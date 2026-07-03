// ─────────────────────────────────────────────────────────────────────────
// Runtime embedder — ONE persistent worker, model loaded once.
//
// Embeds (a) the agent's search query and (b) live-discovered service specs. A
// single long-lived worker keeps the model off the main thread and avoids
// reloading it per call. A service spec is only ~tens of chunks, so multi-worker
// parallelism would cost more than it saves — and the 1-vCPU deployment can't
// use it anyway.
//
// The `?thread` specifier is interpreted by the rolldown worker plugin
// (workerPlugin.ts), which is registered in BOTH the tsdown build and the
// vitest config — so it resolves everywhere and can be a normal top-level
// import. Model/dtype come straight from the prebuilt core vectors, so query
// and corpus embeddings always share one model.
// ─────────────────────────────────────────────────────────────────────────

import type { Worker } from 'node:worker_threads'
import EmbedWorker from './embed-worker.ts?thread'
import { getCoreOpenApiVectors } from '#core-openapi'

export interface EmbedProgress { (done: number, total: number, etaMs: number): void }

const BATCH = 16

let workerPromise: Promise<Worker> | null = null
let nextId = 1
// Tail of the serialisation chain: each embed() awaits the previous one (a
// single onnxruntime session is sequential; concurrent jobs are what we avoid).
let queue: Promise<unknown> = Promise.resolve()

async function getWorker(): Promise<Worker> {
  workerPromise ??= (async () => {
    const { model, dtype } = getCoreOpenApiVectors()
    const worker = new EmbedWorker({ workerData: { model, dtype } })
    await new Promise<void>((resolve, reject) => {
      const onReady = (msg: { type?: string }): void => {
        if (msg?.type === 'ready') {
          worker.off('message', onReady)
          resolve()
        }
      }
      worker.on('message', onReady)
      worker.once('error', reject)
    })
    return worker
  })()
  return workerPromise
}

async function embedNow(texts: string[], prefix: string, onProgress?: EmbedProgress): Promise<Float32Array[]> {
  if (texts.length === 0)
    return []
  const worker = await getWorker()
  const id = nextId++
  const total = texts.length
  const started = performance.now()
  return new Promise<Float32Array[]>((resolve, reject) => {
    const onMessage = (msg: { type?: string, id?: number, done?: number, vectors?: number[][], message?: string }): void => {
      if (msg?.id !== id)
        return
      if (msg.type === 'embedProgress') {
        const done = msg.done ?? 0
        const rate = done > 0 ? done / (performance.now() - started) : 0
        onProgress?.(done, total, rate > 0 ? (total - done) / rate : Number.POSITIVE_INFINITY)
      } else if (msg.type === 'embedResult') {
        worker.off('message', onMessage)
        resolve((msg.vectors ?? []).map((v) => Float32Array.from(v)))
      } else if (msg.type === 'error') {
        worker.off('message', onMessage)
        reject(new Error(msg.message ?? 'embed worker error'))
      }
    }
    worker.on('message', onMessage)
    worker.postMessage({ type: 'embed', id, texts, passagePrefix: prefix, batch: BATCH })
  })
}

/**
 * Embed `texts` (serialised behind any in-flight job). The prefix is prepended
 * per text inside the worker.
 * @param texts Passages (or a single query) to embed.
 * @param opts Optional prefix + progress callback.
 * @param opts.prefix
 * @param opts.onProgress
 * @returns One normalized Float32Array per input text.
 */
export async function embed(texts: string[], opts?: { prefix?: string, onProgress?: EmbedProgress }): Promise<Float32Array[]> {
  const run = queue.then(() => embedNow(texts, opts?.prefix ?? '', opts?.onProgress))
  queue = run.then(() => undefined, () => undefined) // keep the chain alive on error
  return run
}

/**
 * Embed a single search query (applies the model's query prefix).
 * @param text
 * @param queryPrefix
 */
export async function embedQuery(text: string, queryPrefix = ''): Promise<Float32Array> {
  const [vector] = await embed([text], { prefix: queryPrefix })
  if (!vector)
    throw new Error('Query embedding produced no vector.')
  return vector
}

/**
 * Terminate the worker (shutdown).
 */
export async function disposeEmbedder(): Promise<void> {
  if (!workerPromise)
    return
  const pending = workerPromise
  workerPromise = null
  const worker = await pending.catch(() => null)
  if (worker)
    await worker.terminate()
}
