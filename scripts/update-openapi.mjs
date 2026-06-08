/* eslint-disable no-console */
// Fetch and update all bundled OpenAPI specs defined in openapi-builds.json.
// Two generic loops: core versions (under openapi/core/<version>.json) and
// services (under openapi/services/<key>.json). No per-spec code paths.

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const openApiConfigPath = path.join(rootDir, 'openapi-builds.json')
const outputDir = path.join(rootDir, 'openapi')

const config = JSON.parse(fs.readFileSync(openApiConfigPath, 'utf8'))

/**
 * @typedef {{ id: string, status: 'unchanged' | 'updated' | 'created' | 'error', detail?: string }} Result
 */

/** @type {Result[]} */
const results = []
let hasErrors = false

/**
 * Fetch one spec, write it to disk, append a result entry.
 * @param {string} id              Human-readable id for logs (e.g. "core@release", "services/dtm")
 * @param {string} url             Upstream URL to fetch
 * @param {string} outputPath      Destination file
 */
async function fetchAndWrite(id, url, outputPath) {
  process.stdout.write(`Fetching ${id} ... `)

  let response
  try {
    response = await fetch(url)
  } catch (err) {
    const detail = /** @type {Error} */ (err).message
    console.error(`network error: ${detail}`)
    results.push({ id, status: 'error', detail })
    hasErrors = true
    return
  }

  if (!response.ok) {
    const detail = `HTTP ${response.status} ${response.statusText}`
    console.error(detail)
    results.push({ id, status: 'error', detail })
    hasErrors = true
    return
  }

  let text
  try {
    text = await response.text()
    JSON.parse(text)
  } catch (err) {
    const detail = `invalid JSON: ${/** @type {Error} */ (err).message}`
    console.error(detail)
    results.push({ id, status: 'error', detail })
    hasErrors = true
    return
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  const newContent = text.trim()
  const existing = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8').trim() : null

  if (existing === newContent) {
    console.log('unchanged')
    results.push({ id, status: 'unchanged' })
  } else {
    fs.writeFileSync(outputPath, newContent, 'utf8')
    const status = existing === null ? 'created' : 'updated'
    console.log(status)
    results.push({ id, status })
  }
}

// Core versions
for (const entry of config.core.versions) {
  // eslint-disable-next-line antfu/no-top-level-await
  await fetchAndWrite(
    `core@${entry.version}`,
    entry.url,
    path.join(outputDir, 'core', `${entry.version}.json`),
  )
}

// Bundled services (single version per service — the upstream live spec)
for (const entry of config.services ?? []) {
  // eslint-disable-next-line antfu/no-top-level-await
  await fetchAndWrite(
    `services/${entry.key}`,
    entry.url,
    path.join(outputDir, 'services', `${entry.key}.json`),
  )
}

console.log('\nSummary:')
for (const result of results) {
  const icon = result.status === 'error' ? '✗' : result.status === 'unchanged' ? '·' : '✓'
  const detail = result.detail ? ` — ${result.detail}` : ''
  console.log(`  ${icon} ${result.id}: ${result.status}${detail}`)
}

if (process.env.GITHUB_OUTPUT) {
  const json = JSON.stringify(results)
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `results<<EOF\n${json}\nEOF\n`, 'utf8')
}

if (hasErrors) {
  console.error('\nOne or more specs failed to update.')
  process.exit(1)
}
