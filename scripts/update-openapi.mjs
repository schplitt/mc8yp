/* eslint-disable no-console */
// Script to fetch and update all bundled OpenAPI specs defined in openapi-builds.json
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const openApiConfigPath = path.join(rootDir, 'openapi-builds.json')
const outputDir = path.join(rootDir, 'openapi')

const config = JSON.parse(fs.readFileSync(openApiConfigPath, 'utf8'))

/** @type {Array<{ api: string, version: string, status: 'unchanged' | 'updated' | 'created' | 'error', detail?: string }>} */
const results = []
let hasErrors = false

for (const [api, entries] of Object.entries(config.sources)) {
  for (const entry of entries) {
    const { version, label, url } = entry
    const apiOutputDir = path.join(outputDir, api)
    const outputPath = path.join(apiOutputDir, `${version}.json`)

    process.stdout.write(`Fetching ${api} ${label} (${version}) ... `)

    let response
    try {
      // eslint-disable-next-line antfu/no-top-level-await
      response = await fetch(url)
    } catch (err) {
      const detail = /** @type {Error} */ (err).message
      console.error(`network error: ${detail}`)
      results.push({ api, version, status: 'error', detail })
      hasErrors = true
      continue
    }

    if (!response.ok) {
      const detail = `HTTP ${response.status} ${response.statusText}`
      console.error(detail)
      results.push({ api, version, status: 'error', detail })
      hasErrors = true
      continue
    }

    let text
    try {
      // eslint-disable-next-line antfu/no-top-level-await
      text = await response.text()
      JSON.parse(text)
    } catch (err) {
      const detail = `invalid JSON: ${/** @type {Error} */ (err).message}`
      console.error(detail)
      results.push({ api, version, status: 'error', detail })
      hasErrors = true
      continue
    }

    fs.mkdirSync(apiOutputDir, { recursive: true })
    const newContent = text.trim()
    const existing = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8').trim() : null

    if (existing === newContent) {
      console.log('unchanged')
      results.push({ api, version, status: 'unchanged' })
    } else {
      fs.writeFileSync(outputPath, newContent, 'utf8')
      const status = existing === null ? 'created' : 'updated'
      console.log(status)
      results.push({ api, version, status })
    }
  }
}

console.log('\nSummary:')
for (const result of results) {
  const icon = result.status === 'error' ? '✗' : result.status === 'unchanged' ? '·' : '✓'
  const detail = result.detail ? ` — ${result.detail}` : ''
  console.log(`  ${icon} ${result.api}@${result.version}: ${result.status}${detail}`)
}

if (process.env.GITHUB_OUTPUT) {
  const json = JSON.stringify(results)
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `results<<EOF\n${json}\nEOF\n`, 'utf8')
}

if (hasErrors) {
  console.error('\nOne or more specs failed to update.')
  process.exit(1)
}
