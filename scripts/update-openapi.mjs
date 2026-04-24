/* eslint-disable no-console */
// Script to fetch and update all bundled core OpenAPI specs defined in openapi-versions.json
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const versionsConfigPath = path.join(rootDir, 'openapi-versions.json')
const outputDir = path.join(rootDir, 'core-openapi')

const config = JSON.parse(fs.readFileSync(versionsConfigPath, 'utf8'))

/** @type {Array<{ version: string, status: 'unchanged' | 'updated' | 'created' | 'error', detail?: string }>} */
const results = []
let hasErrors = false

for (const entry of config.versions) {
  const { version, label, url } = entry
  const outputPath = path.join(outputDir, `${version}.json`)

  process.stdout.write(`Fetching ${label} (${version}) ... `)

  let response
  try {
    // eslint-disable-next-line antfu/no-top-level-await
    response = await fetch(url)
  } catch (err) {
    const detail = /** @type {Error} */ (err).message
    console.error(`network error: ${detail}`)
    results.push({ version, status: 'error', detail })
    hasErrors = true
    continue
  }

  if (!response.ok) {
    const detail = `HTTP ${response.status} ${response.statusText}`
    console.error(detail)
    results.push({ version, status: 'error', detail })
    hasErrors = true
    continue
  }

  let text
  try {
    // eslint-disable-next-line antfu/no-top-level-await
    text = await response.text()
    JSON.parse(text) // validate JSON
  } catch (err) {
    const detail = `invalid JSON: ${/** @type {Error} */ (err).message}`
    console.error(detail)
    results.push({ version, status: 'error', detail })
    hasErrors = true
    continue
  }

  const newContent = text.trim()
  const existing = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8').trim() : null

  if (existing === newContent) {
    console.log('unchanged')
    results.push({ version, status: 'unchanged' })
  } else {
    fs.writeFileSync(outputPath, newContent, 'utf8')
    const status = existing === null ? 'created' : 'updated'
    console.log(status)
    results.push({ version, status })
  }
}

console.log('\nSummary:')
for (const r of results) {
  const icon = r.status === 'error' ? '✗' : r.status === 'unchanged' ? '·' : '✓'
  const detail = r.detail ? ` — ${r.detail}` : ''
  console.log(`  ${icon} ${r.version}: ${r.status}${detail}`)
}

// Expose results as a GitHub Actions step output when running in CI (no-op locally)
if (process.env.GITHUB_OUTPUT) {
  const json = JSON.stringify(results)
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `results<<EOF\n${json}\nEOF\n`, 'utf8')
}

if (hasErrors) {
  console.error('\nOne or more specs failed to update.')
  process.exit(1)
}
