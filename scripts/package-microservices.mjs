import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageJsonPath = path.join(rootDir, 'package.json')
const cumulocityJsonPath = path.join(rootDir, 'cumulocity.json')
const dockerfilePath = path.join(rootDir, 'Dockerfile')
const buildRootDir = path.join(rootDir, '.output')
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
const releaseTag = process.env.TAG_NAME ?? `v${packageJson.version}`
const assetBaseName = packageJson.name

const specVersions = fs.readdirSync(path.join(rootDir, 'core-openapi'))
  .filter((fileName) => fileName.endsWith('.json'))
  .map((fileName) => fileName.slice(0, -'.json'.length))
  .sort((left, right) => {
    if (left === 'release') {
      return -1
    }
    if (right === 'release') {
      return 1
    }
    return right.localeCompare(left, undefined, { numeric: true })
  })

function run(command, args, cwd = rootDir) {
  execFileSync(command, args, {
    cwd,
    stdio: 'inherit',
  })
}

function createStageDir(version) {
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), `mc8yp-${version}-`))
  fs.copyFileSync(dockerfilePath, path.join(stageDir, 'Dockerfile'))
  fs.copyFileSync(cumulocityJsonPath, path.join(stageDir, 'cumulocity.json'))
  fs.mkdirSync(path.join(stageDir, '.output'), { recursive: true })
  fs.cpSync(path.join(buildRootDir, version), path.join(stageDir, '.output'), { recursive: true })
  return stageDir
}

for (const version of specVersions) {
  const buildDir = path.join(buildRootDir, version)
  if (!fs.existsSync(path.join(buildDir, 'server.mjs'))) {
    throw new Error(`Missing built server bundle for core OpenAPI version "${version}" at ${buildDir}. Run pnpm build first.`)
  }

  const stageDir = createStageDir(version)
  const imageTag = `${assetBaseName}:${releaseTag}-${version}`
  const imageTarPath = path.join(stageDir, 'image.tar')
  const zipFileName = `${assetBaseName}-${version}_${releaseTag}.zip`
  const zipFilePath = path.join(rootDir, zipFileName)

  try {
    run('docker', ['build', '-t', imageTag, '.'], stageDir)
    run('docker', ['save', imageTag, '-o', imageTarPath], stageDir)
    run('zip', ['-j', zipFilePath, imageTarPath, path.join(stageDir, 'cumulocity.json')], stageDir)
  } finally {
    try {
      run('docker', ['image', 'rm', imageTag])
    } catch {
    }
    fs.rmSync(stageDir, { recursive: true, force: true })
  }
}
