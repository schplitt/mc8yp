import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { rolldown } from 'rolldown'
import { defineConfig } from 'tsdown'
import workerPlugin from './workerPlugin.ts'
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
    getVectors: 'getCoreOpenApiVectors',
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

async function prepareSpecJson(specJson: string, servicePrefix?: string): Promise<string> {
  const spec = await preprocessOpenApi(JSON.parse(specJson), { servicePrefix })
  return JSON.stringify(spec)
}

async function readSpecJson(api: OpenApiModuleName, version: string): Promise<string> {
  const raw = readFileSync(path.join(rootDir, 'openapi', api, `${version}.json`), 'utf8').trim()
  const source = getSourceConfig(api, version)
  return prepareSpecJson(raw, source.servicePrefix)
}

// Prebuilt embedding vectors live in openapi/vectors/<api>/<version>.json
// (ids + base64 Float32 matrix; see scripts/build-spec-vectors.ts). Inlined
// alongside the spec so the runtime loads them instead of re-embedding the core
// corpus at startup. These are REQUIRED for every bundled core version — a
// missing file fails the build (run `pnpm build:vectors`) rather than shipping
// a core surface the runtime cannot search.
function readVectorsJson(api: OpenApiModuleName, version: string): string {
  const vectorsPath = path.join(rootDir, 'openapi', 'vectors', api, `${version}.json`)
  if (!existsSync(vectorsPath)) {
    throw new Error(
      `Missing prebuilt vectors for ${api}/${version} at ${path.relative(rootDir, vectorsPath)}. `
      + `Run \`pnpm build:vectors\` before building.`,
    )
  }
  return readFileSync(vectorsPath, 'utf8').trim()
}

async function generateEntries(api: OpenApiModuleName, versions: readonly string[]): Promise<string> {
  const lines = await Promise.all(versions.map(async (version) => {
    const source = getSourceConfig(api, version)
    return `  { version: ${JSON.stringify(version)}, label: ${JSON.stringify(source.label)}, spec: ${await readSpecJson(api, version)}, vectors: ${readVectorsJson(api, version)} },`
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
export function ${moduleInfo.getVectors}() {
  const entry = ${moduleInfo.entryConst}.find((entry) => entry.version === activeVersion) ?? ${moduleInfo.entryConst}[0];
  if (!entry?.vectors)
    throw new Error("No prebuilt vectors for core OpenAPI version " + activeVersion + ".");
  return entry.vectors;
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
export function ${moduleInfo.getVectors}() {
  if (!${moduleInfo.entryConst}[0]?.vectors)
    throw new Error("No prebuilt vectors for core OpenAPI version ${version}.");
  return ${moduleInfo.entryConst}[0].vectors;
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

/**
 * Virtual `?bundle` plugin.
 *
 * `import source from '<specifier>?bundle'` resolves `<specifier>` with
 * rolldown, bundles it (and any of its own deps) into a single ESM module,
 * and exports the resulting source **as a string** (default export).
 *
 * The string is meant to be handed to `@iso4/sandbox` as a source-string
 * import (`run({ imports: { '<name>': bundledSource } })`) so untrusted
 * sandbox code can `import X from '<name>'` without the host ever exposing a
 * real module loader. minisearch is the first consumer (search index over the
 * OpenAPI specs inside the `query` sandbox).
 *
 * Generic by design: any future sandbox-side library uses the same suffix.
 */
export function bundleStringPlugin() {
  const SUFFIX = '?bundle'
  const RESOLVED_PREFIX = '\0bundle:'

  return {
    name: 'mc8yp:bundle-string',
    // Run before Vite/rolldown's built-in node resolver, which would otherwise
    // strip the `?bundle` query and resolve to the real module.
    enforce: 'pre' as const,
    resolveId(id: string) {
      if (!id.endsWith(SUFFIX))
        return null
      return RESOLVED_PREFIX + id.slice(0, -SUFFIX.length)
    },
    async load(id: string) {
      if (!id.startsWith(RESOLVED_PREFIX))
        return null
      const specifier = id.slice(RESOLVED_PREFIX.length)

      const bundle = await rolldown({
        input: specifier,
        // Neutral platform: no Node built-in shims. Sandbox libs run in V8
        // isolates with only the iso4-provided globals (setTimeout, etc.).
        platform: 'neutral',
        logLevel: 'silent',
      })
      try {
        const { output } = await bundle.generate({ format: 'esm' })
        const code = output.filter((c) => c.type === 'chunk').map((c) => c.code).join('\n')
        return `export default ${JSON.stringify(code)};\n`
      } finally {
        await bundle.close()
      }
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
  plugins: [coreOpenApiPlugin({ mode: 'server', build }), bundledServicesPlugin({ mode: 'server', build }), bundleStringPlugin(), workerPlugin()],
  // Bundle pure-JS deps; keep these external (installed via pnpm install --prod):
  //   @iso4/sandbox              per-platform Rust binary (sandbox isolate)
  //   @huggingface/transformers  pulls native onnxruntime-node + sharp (+ @img/*)
  //                              which can't be inlined — kept external so its
  //                              whole native tree installs transitively at runtime
  //   @napi-rs/*                 N-API native bindings (defensive; unused server-side)
  noExternal: [/^(?!@iso4\/sandbox$|@napi-rs\/|@huggingface\/transformers)/],
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
    plugins: [coreOpenApiPlugin({ mode: 'cli' }), bundledServicesPlugin({ mode: 'cli' }), bundleStringPlugin(), workerPlugin()],
    // Bundle pure-JS deps to reduce supply-chain risk for CLI users. These stay
    // external (cannot be statically inlined; installed from node_modules):
    //   @iso4/sandbox              per-platform Rust binaries (@iso4/v8-*)
    //   @napi-rs/*                 N-API native bindings (keyring)
    //   @huggingface/transformers  pulls native onnxruntime-node + sharp (+ @img/*);
    //                              kept external so its native tree resolves at runtime
    // @iso4/fetch is pure JS (rou3 + undici) and is safe to bundle.
    noExternal: [/^(?!@iso4\/sandbox$|@napi-rs\/|@huggingface\/transformers)/],
    outDir: 'dist',
  },
])
