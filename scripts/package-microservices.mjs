import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import process from 'node:process'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageJsonPath = path.join(rootDir, 'package.json')
const cumulocityJsonPath = path.join(rootDir, 'cumulocity.json')
const buildRootDir = path.join(rootDir, '.output')
const stagingRootDir = path.join(rootDir, '.c8y')
const stagedDockerfilePath = path.join(stagingRootDir, 'Dockerfile')
const stagedImageTarPath = path.join(stagingRootDir, 'image.tar')
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
const releaseTag = process.env.TAG_NAME ?? `v${packageJson.version}`
const assetBaseName = packageJson.name
const targetPlatform = process.env.DOCKER_PLATFORM ?? 'linux/amd64'
const pnpmVersion = typeof packageJson.packageManager === 'string' && packageJson.packageManager.startsWith('pnpm@')
  ? packageJson.packageManager.slice('pnpm@'.length)
  : '10.33.0'

function sanitizeDockerNamePart(value, fallback) {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return sanitized || fallback
}

const dockerRepositoryName = sanitizeDockerNamePart(assetBaseName, 'mc8yp')
const dockerReleaseTag = sanitizeDockerNamePart(releaseTag, `v${packageJson.version}`)

const openapiVersionsConfig = JSON.parse(fs.readFileSync(path.join(rootDir, 'openapi-versions.json'), 'utf8'))
const specVersions = openapiVersionsConfig.versions.map((entry) => entry.version)

function run(command, args, cwd = rootDir) {
  execFileSync(command, args, {
    cwd,
    stdio: 'inherit',
  })
}

function renderDockerfile(version) {
  return `FROM node:24-bookworm-slim AS deps

WORKDIR /app

COPY package.json ./package.json
COPY pnpm-lock.yaml ./pnpm-lock.yaml
COPY pnpm-workspace.yaml ./pnpm-workspace.yaml

RUN npm install -g pnpm@${pnpmVersion} \
  && pnpm install --prod --frozen-lockfile

FROM node:24-bookworm-slim AS runtime

WORKDIR /app

COPY --from=deps /app/node_modules/ ./node_modules/
COPY package.json ./package.json
COPY .output/${version}/ ./server/

ENV NODE_ENV=production

EXPOSE 80

CMD ["node", "--enable-source-maps", "/app/server/server.mjs"]
`
}

function prepareStagingDir(version) {
  fs.mkdirSync(stagingRootDir, { recursive: true })
  fs.writeFileSync(stagedDockerfilePath, renderDockerfile(version))
}

function removeExistingZipArtifacts() {
  for (const entry of fs.readdirSync(rootDir)) {
    if (entry.endsWith('.zip')) {
      fs.rmSync(path.join(rootDir, entry), { force: true })
    }
  }
}

try {
  fs.rmSync(stagingRootDir, { recursive: true, force: true })
  fs.mkdirSync(stagingRootDir, { recursive: true })
  removeExistingZipArtifacts()

  for (const version of specVersions) {
    const buildDir = path.join(buildRootDir, version)
    if (!fs.existsSync(path.join(buildDir, 'server.mjs'))) {
      throw new Error(`Missing built server bundle for core OpenAPI version "${version}" at ${buildDir}. Run pnpm build first.`)
    }

    prepareStagingDir(version)
    const zipFileName = `${assetBaseName}-${version}-${releaseTag}.zip`
    const zipFilePath = path.join(rootDir, zipFileName)
    const imageRef = `${dockerRepositoryName}:${sanitizeDockerNamePart(version, 'release')}-${dockerReleaseTag}`

    try {
      run('docker', ['build', '--platform', targetPlatform, '-f', stagedDockerfilePath, '-t', imageRef, '.'], rootDir)
      run('docker', ['save', imageRef, '-o', stagedImageTarPath], rootDir)
      run('zip', ['-j', zipFilePath, stagedImageTarPath, cumulocityJsonPath], rootDir)
    } finally {
      try {
        run('docker', ['image', 'rm', imageRef])
      } catch {
      }
      fs.rmSync(stagedDockerfilePath, { force: true })
      fs.rmSync(stagedImageTarPath, { force: true })
    }
  }
} finally {
  fs.rmSync(stagingRootDir, { recursive: true, force: true })
}
