/* eslint-disable no-console */
// script to update cumulocity.json version in github actions
import fs from 'node:fs'

const filePath = './cumulocity.json'

// Read the existing cumulocity.json file
const data = fs.readFileSync(filePath, 'utf8')
const json = JSON.parse(data)

// Read package.json to derive version, name and key
const packageData = fs.readFileSync('./package.json', 'utf8')
const packageJson = JSON.parse(packageData)

// Use unscoped package name for name/key (strip @scope/ if present)
const baseName = `${String(packageJson.name).replace(/^@.*\//, '')}-server`
json.version = packageJson.version || json.version
json.name = baseName || json.name
json.key = `${baseName || json.name}-key`

// Write the updated JSON back to cumulocity.json
fs.writeFileSync(filePath, JSON.stringify(json, null, 2), 'utf8')

console.log(`Updated cumulocity.json: version=${json.version}, name=${json.name}, key=${json.key}`)
