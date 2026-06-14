import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'tsdown'
import { resolveCodeModeExtension } from './src/utils/resolve-xcodemode.ts'
import type { Spec } from './src/utils/spec-resolution.ts'
import { resolveInternalRefs } from './src/utils/resolve-refs.ts'

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
  servicePrefix?: string
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

/**
 * Parse a raw spec JSON string, dereference its internal $ref pointers, then
 * (optionally) rewrite paths/servers with the service prefix. Returns a JSON
 * string ready to inline into a generated module.
 *
 * $ref resolution happens here so the bundled specs that ship in the build
 * carry fully inlined schemas, matching the resolution applied to live
 * discovered specs at runtime (see src/utils/resolve-refs.ts).
 * @param specJson Raw spec contents read from disk.
 * @param servicePrefix Optional prefix to prepend to paths/servers (service specs only).
 */
async function prepareSpecJson(specJson: string, servicePrefix?: string): Promise<string> {
  const spec = await resolveInternalRefs(JSON.parse(specJson) as {
    paths?: Record<string, unknown>
    servers?: Array<{ url: string, description?: string }>
  })
  resolveCodeModeExtension(spec as unknown as Spec, servicePrefix)
  if (servicePrefix) {
    if (spec.paths) {
      const rewritten: Record<string, unknown> = {}
      for (const [p, item] of Object.entries(spec.paths)) {
        rewritten[`${servicePrefix}${p}`] = item
      }
      spec.paths = rewritten
    }
    if (spec.servers) {
      spec.servers = spec.servers.map((server) => ({
        ...server,
        url: server.url.replace('<TENANT_DOMAIN>', `<TENANT_DOMAIN>${servicePrefix}`),
      }))
    }
  }
  return JSON.stringify(spec)
}

async function readSpecJson(api: OpenApiModuleName, version: string): Promise<string> {
  const raw = readFileSync(path.join(rootDir, 'openapi', api, `${version}.json`), 'utf8').trim()
  const source = getSourceConfig(api, version)
  return prepareSpecJson(raw, source.servicePrefix)
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

/**
 * Virtual module `#bundled-services` — exports BUNDLED_SERVICE_SPECS.
 *
 * Loops all entries in openapi-builds.json sources that carry a servicePrefix
 * and emits one DiscoveredApiSpec-shaped object per entry. For CLI builds the
 * default version is used; for server builds the version is taken from
 * build.apis[key]. Adding a future bundled service requires only dropping the
 * JSON file under openapi/<key>/<version>.json and a source entry with
 * servicePrefix in openapi-builds.json — no code changes here.
 * @param options
 */
export function bundledServicesPlugin(options: { mode: 'cli' } | { mode: 'server', build: OpenApiBuildEntry }) {
  const VIRTUAL_ID = '#bundled-services'
  const RESOLVED_ID = '\0virtual:bundled-services'

  return {
    name: 'mc8yp:bundled-services',
    resolveId(id: string) {
      if (id === VIRTUAL_ID)
        return RESOLVED_ID
      return null
    },
    async load(id: string) {
      if (id !== RESOLVED_ID)
        return null

      const entryLines: string[] = []

      for (const [key, sourceEntries] of Object.entries(OPENAPI_CONFIG.sources)) {
        // Only process service-backed sources (those with a servicePrefix)
        const serviceEntry = (sourceEntries as OpenApiSourceEntry[]).find((e) => e.servicePrefix != null)
        if (!serviceEntry)
          continue

        // Resolve the version to inline
        const version: string | undefined = options.mode === 'server'
          ? (options.build.apis[key] ?? (sourceEntries as OpenApiSourceEntry[]).find((e) => e.default)?.version ?? (sourceEntries as OpenApiSourceEntry[])[0]?.version)
          : ((sourceEntries as OpenApiSourceEntry[]).find((e) => e.default)?.version ?? (sourceEntries as OpenApiSourceEntry[])[0]?.version)

        if (version == null)
          continue

        const entry = (sourceEntries as OpenApiSourceEntry[]).find((e) => e.version === version)
        if (!entry?.servicePrefix)
          continue

        const rawJson = readFileSync(path.join(rootDir, 'openapi', key, `${version}.json`), 'utf8').trim()
        const rewrittenJson = await prepareSpecJson(rawJson, entry.servicePrefix)
        const contextPath = entry.servicePrefix.replace(/^\/service\//, '')

        entryLines.push(
          `  { contextPath: ${JSON.stringify(contextPath)}, appLabel: ${JSON.stringify(entry.label)}, specLabel: ${JSON.stringify(entry.label)}, servicePrefix: ${JSON.stringify(entry.servicePrefix)}, spec: ${rewrittenJson} }`,
        )
      }

      return `export const BUNDLED_SERVICE_SPECS = Object.freeze([\n${entryLines.join(',\n')}\n]);\n`
    },
  }
}

const serverBuilds = OPENAPI_CONFIG.builds.map((build) => ({
  name: `mc8yp-server-build-${build.version}`,
  entry: { server: './src/index.ts' },
  treeshake: true,
  clean: build.version === OPENAPI_CONFIG.builds[0]?.version,
  dts: false,
  format: 'module' as const,
  plugins: [coreOpenApiPlugin({ mode: 'server', build }), bundledServicesPlugin({ mode: 'server', build })],
  // Bundle all non-native deps so the Docker image only needs @iso4/sandbox
  // (and its per-platform Rust binary) installed at runtime via pnpm install --prod.
  // @napi-rs/* is excluded defensively (not used in server mode anyway).
  noExternal: [/^(?!@iso4\/sandbox$|@napi-rs\/)/],
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
    plugins: [coreOpenApiPlugin({ mode: 'cli' }), bundledServicesPlugin({ mode: 'cli' })],
    // Bundle every non-native dep to reduce supply-chain risk for CLI users.
    // @iso4/sandbox must stay external: it resolves per-platform Rust binaries
    // (@iso4/v8-*) at runtime and cannot be statically inlined.
    // @napi-rs/* must stay external for the same reason (N-API native bindings).
    // @iso4/fetch is pure JS (rou3 + undici) and is safe to bundle.
    noExternal: [/^(?!@iso4\/sandbox$|@napi-rs\/)/],
    outDir: 'dist',
  },
])
