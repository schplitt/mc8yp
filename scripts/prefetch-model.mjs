/* eslint-disable no-console, antfu/no-top-level-await -- build-time CLI script run via `node` in the Docker image */
// ─────────────────────────────────────────────────────────────────────────
// Build-time model prefetch (Docker deps stage).
//
// Downloads the embedding model into @huggingface/transformers' default cache
// — which lives INSIDE node_modules — so the subsequent `COPY --from=deps
// /app/node_modules` carries it into the runtime image. The deployed
// microservice then loads the model from that baked cache with no network call
// and an instant cold start.
//
// Model id + dtype are read from the prebuilt core vectors so this never drifts
// from what the runtime actually searches against.
// ─────────────────────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { pipeline } from '@huggingface/transformers'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { model, dtype } = JSON.parse(readFileSync(resolve(root, 'openapi/vectors/core/release.json'), 'utf8'))

console.log(`Prefetching embedding model ${model} (dtype ${dtype}) into the transformers cache…`)
const t0 = Date.now()
// Loading the pipeline downloads the weights/tokenizer AND validates the native
// runtime (onnxruntime-node + sharp) resolves — a useful build-time smoke test.
await pipeline('feature-extraction', model, { dtype })
console.log(`Model cached in ${((Date.now() - t0) / 1000).toFixed(1)}s.`)
