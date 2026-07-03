// ─────────────────────────────────────────────────────────────────────────
// Embedding pool.
//
// Spreads a list of passages across N embed workers (see embed-worker.ts),
// each writing its shard's vectors directly into one shared Float32 matrix
// (SharedArrayBuffer) — no per-vector copying back across threads. Returns the
// finished matrix as a single Float32Array of length texts.length * dim.
//
// The worker factory is injected so the SAME pool serves both consumers:
//   • build-time: () => new Worker(new URL('./embed-worker.ts', import.meta.url), opts)
//   • runtime:    createWorker from '../codemode/embed-worker.ts?thread' (bundled)
// On a single-core deployment pass workers:1 — there the worker still earns its
// keep by keeping embedding OFF the server's main thread.
// ─────────────────────────────────────────────────────────────────────────

import type { Worker, WorkerOptions } from 'node:worker_threads'
import { availableParallelism } from 'node:os'

export interface EmbedPoolOptions {
  /**
   * Passages to embed, in order; row i of the result is texts[i].
   */
  texts: string[]
  /**
   * Embedding dimension of the chosen model.
   */
  dim: number
  /**
   * HF model id, passed to each worker as workerData.
   */
  model: string
  /**
   * ONNX dtype (must match whatever the runtime query embedding uses).
   */
  dtype: string
  /**
   * Per-model passage prefix.
   */
  passagePrefix?: string
  /**
   * Worker count. Defaults to available CPU cores. Clamp to 1 on a 1-vCPU box.
   */
  workers?: number
  /**
   * Embedding batch size per worker step.
   */
  batch?: number
  /**
   * Spawns one worker; `options` carries `workerData`.
   */
  createWorker: (options: WorkerOptions) => Worker
  /**
   * Progress callback: done/total rows + a rough ETA in ms.
   */
  onProgress?: (done: number, total: number, etaMs: number) => void
}

/**
 * Embed `texts` across a worker pool into one shared Float32 matrix.
 * @param opts Pool configuration (texts, model, worker factory, callbacks).
 * @returns Float32Array of length `texts.length * dim`, row-major.
 */
export async function embedTexts(opts: EmbedPoolOptions): Promise<Float32Array> {
  const total = opts.texts.length
  const { dim } = opts
  const result = new Float32Array(new SharedArrayBuffer(total * dim * 4))
  if (total === 0)
    return result

  const sab = result.buffer as SharedArrayBuffer
  const passagePrefix = opts.passagePrefix ?? ''
  const batch = opts.batch ?? 16
  const nWorkers = Math.max(1, Math.min(opts.workers ?? availableParallelism(), total))
  const shardSize = Math.ceil(total / nWorkers)

  const shards: Array<{ start: number, end: number }> = []
  for (let start = 0; start < total; start += shardSize)
    shards.push({ start, end: Math.min(start + shardSize, total) })

  let done = 0
  const startedAt = performance.now()
  const report = (): void => {
    const elapsed = performance.now() - startedAt
    const rate = done > 0 ? done / elapsed : 0 // rows per ms
    const etaMs = rate > 0 ? (total - done) / rate : Number.POSITIVE_INFINITY
    opts.onProgress?.(done, total, etaMs)
  }

  await new Promise<void>((resolve, reject) => {
    let finished = 0
    let settled = false
    const workers: Worker[] = []
    const cleanup = (): void => {
      for (const w of workers)
        w.terminate()
    }
    const fail = (err: Error): void => {
      if (settled)
        return
      settled = true
      cleanup()
      reject(err)
    }

    const dispatch = (worker: Worker, shard: { start: number, end: number }): void => {
      worker.on('message', (msg: { type: string, count?: number, message?: string }) => {
        if (msg.type === 'progress') {
          done += msg.count ?? 0
          report()
        } else if (msg.type === 'shardDone') {
          worker.terminate()
          finished += 1
          if (finished === shards.length && !settled) {
            settled = true
            resolve()
          }
        } else if (msg.type === 'error') {
          fail(new Error(msg.message ?? 'embed worker error'))
        }
      })
      worker.postMessage({
        type: 'shard',
        texts: opts.texts.slice(shard.start, shard.end),
        rowOffset: shard.start,
        dim,
        sab,
        passagePrefix,
        batch,
      })
    }

    // Spawn workers ONE AT A TIME, waiting for each to load its model (the
    // `ready` signal) before spawning the next. onnxruntime-node crashes if
    // several native sessions initialise concurrently; serialising init avoids
    // that while still letting already-loaded workers embed in parallel.
    (async () => {
      for (const shard of shards) {
        if (settled)
          return
        const worker = opts.createWorker({ workerData: { model: opts.model, dtype: opts.dtype } })
        workers.push(worker)
        worker.on('error', fail)
        worker.on('exit', (code) => {
          if (code !== 0 && !settled)
            fail(new Error(`embed worker exited with code ${code}`))
        })
        await new Promise<void>((ready) => {
          const onReady = (msg: { type: string }): void => {
            if (msg.type === 'ready') {
              worker.off('message', onReady)
              ready()
            }
          }
          worker.on('message', onReady)
        })
        if (settled)
          return
        dispatch(worker, shard)
      }
    })().catch(fail)
  })

  return result
}
