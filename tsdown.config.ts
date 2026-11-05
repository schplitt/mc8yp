import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'tsdown'
import { preprocessOpenApi } from './src/utils/openapi-preprocessor.ts'

const rootDir = path.dirname(fileURLToPath(import.meta.url))

const OPENAPI_MODULES = {
  core: {
    virtualId: '#core-openapi',
    resolvedId: '\0virtual:core-openapi',
    entryType: 'CoreOpenApiEntry',
    entryConst: 'specs',
    getSpec: 'getCoreOpenApiSpec',
    getVersion: 'getCoreOpenApiVersion',
    setVersion: 'setCoreOpenApiVersion',
    getLabel: 'getCoreOpenApiLabel',
    pluginName: 'mc8yp:core-openapi',
  },
} as const

type OpenApiModuleName = keyof typeof OPENAPI_MODULES

interface OpenApiSourceEntry {
  version: string
  label: string
  url: string
  default?: boolean
}

interface OpenApiBuildEntry {
  version: string
  label: string
  artifact: string
  apis: Record<string, string>
  default?: boolean
}

const OPENAPI_CONFIG = JSON.parse(
  readFileSync(path.join(rootDir, 'openapi-builds.json'), 'utf8'),
) as {
  sources: Record<string, OpenApiSourceEntry[]>
  builds: OpenApiBuildEntry[]
}

function getSourceConfig(api: OpenApiModuleName, version: string): OpenApiSourceEntry {
  const entry = OPENAPI_CONFIG.sources[api]?.find((candidate) => candidate.version === version)
  if (!entry) {
    throw new Error(`Unknown ${api} OpenAPI version ${version}.`)
  }
  return entry
}

async function readSpecJson(api: OpenApiModuleName, version: string): Promise<string> {
  const raw = readFileSync(path.join(rootDir, 'openapi', api, `${version}.json`), 'utf8').trim()
  return JSON.stringify(await preprocessOpenApi(JSON.parse(raw)))
}

async function generateEntries(api: OpenApiModuleName, versions: readonly string[]): Promise<string> {
  const lines = await Promise.all(versions.map(async (version) => {
    const source = getSourceConfig(api, version)
    return `  { version: ${JSON.stringify(version)}, label: ${JSON.stringify(source.label)}, spec: ${await readSpecJson(api, version)} },`
  }))
  return lines.join('\n')
}

async function generateCliModule(api: OpenApiModuleName): Promise<string> {
  const moduleInfo = OPENAPI_MODULES[api]
  const versions = OPENAPI_CONFIG.sources[api].map((entry) => entry.version)
  const defaultVersion = OPENAPI_CONFIG.sources[api].find((entry) => entry.default)?.version ?? versions[0] ?? 'release'

  return `export const ${moduleInfo.entryConst} = Object.freeze([\n${await generateEntries(api, versions)}\n]);
let activeVersion = ${JSON.stringify(defaultVersion)};
export function ${moduleInfo.getSpec}() {
  return ${moduleInfo.entryConst}.find((entry) => entry.version === activeVersion)?.spec ?? ${moduleInfo.entryConst}[0]?.spec;
}
export function ${moduleInfo.getVersion}() {
  return activeVersion;
}
export function ${moduleInfo.setVersion}(version) {
  if (!${moduleInfo.entryConst}.some((entry) => entry.version === version)) {
    throw new Error("Unknown ${api} OpenAPI version: " + version + ". Available: " + ${moduleInfo.entryConst}.map((entry) => entry.version).join(", "));
  }
  activeVersion = version;
}
export function ${moduleInfo.getLabel}() {
  return ${moduleInfo.entryConst}.find((entry) => entry.version === activeVersion)?.label ?? ${moduleInfo.entryConst}[0]?.label ?? activeVersion;
}
`
}

async function generateServerModule(api: OpenApiModuleName, build: OpenApiBuildEntry): Promise<string> {
  const moduleInfo = OPENAPI_MODULES[api]
  const version = build.apis[api]
  const label = getSourceConfig(api, version).label

  return `export const ${moduleInfo.entryConst} = Object.freeze([\n${await generateEntries(api, [version])}\n]);
export function ${moduleInfo.getSpec}() {
  return ${moduleInfo.entryConst}[0]?.spec;
}
export function ${moduleInfo.getVersion}() {
  return ${moduleInfo.entryConst}[0]?.version ?? ${JSON.stringify(version)};
}
export function ${moduleInfo.setVersion}() {
  throw new Error("This server build is locked to ${api} OpenAPI version " + (${moduleInfo.entryConst}[0]?.version ?? ${JSON.stringify(version)}) + ".");
}
export function ${moduleInfo.getLabel}() {
  return ${moduleInfo.entryConst}[0]?.label ?? ${JSON.stringify(label)};
}
`
}

function createOpenApiPlugin(api: OpenApiModuleName, options: { mode: 'cli' } | { mode: 'server', build: OpenApiBuildEntry }) {
  const moduleInfo = OPENAPI_MODULES[api]

  return {
    name: moduleInfo.pluginName,
    resolveId(id: string) {
      if (id === moduleInfo.virtualId) {
        return moduleInfo.resolvedId
      }
      return null
    },
    load(id: string) {
      if (id !== moduleInfo.resolvedId) {
        return null
      }
      return options.mode === 'cli'
        ? generateCliModule(api)
        : generateServerModule(api, options.build)
    },
  }
}

export function coreOpenApiPlugin(options: { mode: 'cli' } | { mode: 'server', build: OpenApiBuildEntry }) {
  return createOpenApiPlugin('core', options)
}

const serverBuilds = OPENAPI_CONFIG.builds.map((build) => ({
  name: `mc8yp-server-build-${build.version}`,
  entry: { server: './src/index.ts' },
  treeshake: true,
  clean: build.version === OPENAPI_CONFIG.builds[0]?.version,
  dts: false,
  format: 'module' as const,
  plugins: [coreOpenApiPlugin({ mode: 'server', build })],
  // Bundle all non-native deps so the Docker image only needs @iso4/sandbox
  // (and its per-platform Rust binary) plus just-bash installed at runtime via
  // pnpm install --prod. just-bash stays external: it lazy-loads WASM runtimes
  // (quickjs-emscripten, sql.js) for its optional python/js/sqlite commands, so
  // static inlining is fragile. @napi-rs/* is excluded defensively (unused in server mode).
  noExternal: [/^(?!@iso4\/sandbox$|@napi-rs\/|just-bash(?:$|\/))/],
  outDir: `.output/${build.version}`,
}))

export default defineConfig([
  ...serverBuilds,
  {
    name: 'mc8yp-cli-build',
    entry: { cli: './src/cli/index.ts' },
    treeshake: true,
    clean: true,
    dts: false,
    format: 'module',
    plugins: [coreOpenApiPlugin({ mode: 'cli' })],
    // Bundle every non-native dep to reduce supply-chain risk for CLI users.
    // @iso4/sandbox must stay external: it resolves per-platform Rust binaries
    // (@iso4/v8-*) at runtime and cannot be statically inlined.
    // @napi-rs/* must stay external for the same reason (N-API native bindings).
    // just-bash stays external too: it lazy-loads WASM runtimes for its optional
    // commands, so static inlining is fragile (we only use the pure-JS core shell).
    // @iso4/fetch is pure JS (rou3 + undici) and is safe to bundle.
    noExternal: [/^(?!@iso4\/sandbox$|@napi-rs\/|just-bash(?:$|\/))/],
    outDir: 'dist',
  },
])
