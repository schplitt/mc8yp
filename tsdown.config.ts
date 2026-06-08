import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'tsdown'

const rootDir = path.dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// openapi-builds.json schema
// ---------------------------------------------------------------------------

interface CoreVersionEntry {
  version: string
  label: string
  url: string
  default?: boolean
}

interface ServiceEntry {
  /**
   * Microservice context path key (also the file name under openapi/services/).
   */
  key: string
  label: string
  url: string
  /**
   * URL prefix prepended to spec paths at build time.
   */
  servicePrefix: string
}

interface BuildEntry {
  version: string
  label: string
  /**
   * Which core version this build inlines. Bundled services are always included as-is.
   */
  core: string
  default?: boolean
}

interface OpenApiConfig {
  core: { versions: CoreVersionEntry[] }
  services: ServiceEntry[]
  builds: BuildEntry[]
}

const OPENAPI_CONFIG = JSON.parse(
  readFileSync(path.join(rootDir, 'openapi-builds.json'), 'utf8'),
) as OpenApiConfig

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function getCoreVersion(version: string): CoreVersionEntry {
  const entry = OPENAPI_CONFIG.core.versions.find((v) => v.version === version)
  if (!entry) {
    throw new Error(`Unknown core OpenAPI version: ${version}`)
  }
  return entry
}

function readCoreSpecJson(version: string): string {
  return readFileSync(path.join(rootDir, 'openapi', 'core', `${version}.json`), 'utf8').trim()
}

function readServiceSpecJson(key: string): string {
  return readFileSync(path.join(rootDir, 'openapi', 'services', `${key}.json`), 'utf8').trim()
}

/**
 * Rewrite an OpenAPI spec so every `paths` key is prefixed with `servicePrefix`,
 * and any `servers[].url` template placeholder includes the prefix too.
 * Applied to bundled service specs at build time so they look identical to
 * what live discovery produces in src/utils/api-discovery.ts.
 * @param specJson
 * @param servicePrefix
 */
function rewriteSpecPaths(specJson: string, servicePrefix: string): string {
  const spec = JSON.parse(specJson) as {
    paths?: Record<string, unknown>
    servers?: Array<{ url: string, description?: string }>
  }
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
  return JSON.stringify(spec)
}

// ---------------------------------------------------------------------------
// #core-openapi — special-cased: version-switchable in CLI, single-version in server
// ---------------------------------------------------------------------------

const CORE_VIRTUAL_ID = '#core-openapi'
const CORE_RESOLVED_ID = '\0virtual:core-openapi'

function generateCoreEntries(versions: readonly string[]): string {
  return versions.map((version) => {
    const source = getCoreVersion(version)
    return `  { version: ${JSON.stringify(version)}, label: ${JSON.stringify(source.label)}, spec: ${readCoreSpecJson(version)} },`
  }).join('\n')
}

function generateCoreCliModule(): string {
  const versions = OPENAPI_CONFIG.core.versions.map((v) => v.version)
  const defaultVersion = OPENAPI_CONFIG.core.versions.find((v) => v.default)?.version ?? versions[0] ?? 'release'

  return `export const specs = Object.freeze([
${generateCoreEntries(versions)}
]);
let activeVersion = ${JSON.stringify(defaultVersion)};
export function getCoreOpenApiSpec() {
  return specs.find((entry) => entry.version === activeVersion)?.spec ?? specs[0]?.spec;
}
export function getCoreOpenApiVersion() {
  return activeVersion;
}
export function setCoreOpenApiVersion(version) {
  if (!specs.some((entry) => entry.version === version)) {
    throw new Error("Unknown core OpenAPI version: " + version + ". Available: " + specs.map((entry) => entry.version).join(", "));
  }
  activeVersion = version;
}
export function getCoreOpenApiLabel() {
  return specs.find((entry) => entry.version === activeVersion)?.label ?? specs[0]?.label ?? activeVersion;
}
`
}

function generateCoreServerModule(build: BuildEntry): string {
  const version = build.core
  const label = getCoreVersion(version).label

  return `export const specs = Object.freeze([
${generateCoreEntries([version])}
]);
export function getCoreOpenApiSpec() {
  return specs[0]?.spec;
}
export function getCoreOpenApiVersion() {
  return specs[0]?.version ?? ${JSON.stringify(version)};
}
export function setCoreOpenApiVersion() {
  throw new Error("This server build is locked to core OpenAPI version " + (specs[0]?.version ?? ${JSON.stringify(version)}) + ".");
}
export function getCoreOpenApiLabel() {
  return specs[0]?.label ?? ${JSON.stringify(label)};
}
`
}

export function coreOpenApiPlugin(options: { mode: 'cli' } | { mode: 'server', build: BuildEntry }) {
  return {
    name: 'mc8yp:core-openapi',
    resolveId(id: string) {
      return id === CORE_VIRTUAL_ID ? CORE_RESOLVED_ID : null
    },
    load(id: string) {
      if (id !== CORE_RESOLVED_ID)
        return null
      return options.mode === 'cli' ? generateCoreCliModule() : generateCoreServerModule(options.build)
    },
  }
}

// ---------------------------------------------------------------------------
// #bundled-services — generic: emits BUNDLED_SERVICE_SPECS as DiscoveredApiSpec[]
// Identical content for CLI and server builds — bundled services have no version axis.
// ---------------------------------------------------------------------------

const SERVICES_VIRTUAL_ID = '#bundled-services'
const SERVICES_RESOLVED_ID = '\0virtual:bundled-services'

function generateBundledServicesModule(): string {
  const entries = OPENAPI_CONFIG.services.map((service) => {
    const rawSpec = readServiceSpecJson(service.key)
    const rewrittenSpec = rewriteSpecPaths(rawSpec, service.servicePrefix)
    return `  { contextPath: ${JSON.stringify(service.key)}, appLabel: ${JSON.stringify(service.label)}, specLabel: ${JSON.stringify(service.label)}, servicePrefix: ${JSON.stringify(service.servicePrefix)}, spec: ${rewrittenSpec} },`
  }).join('\n')

  return `export const BUNDLED_SERVICE_SPECS = Object.freeze([
${entries}
]);
`
}

export function bundledServicesPlugin() {
  return {
    name: 'mc8yp:bundled-services',
    resolveId(id: string) {
      return id === SERVICES_VIRTUAL_ID ? SERVICES_RESOLVED_ID : null
    },
    load(id: string) {
      if (id !== SERVICES_RESOLVED_ID)
        return null
      return generateBundledServicesModule()
    },
  }
}

// ---------------------------------------------------------------------------
// Build matrix
// ---------------------------------------------------------------------------

const serverBuilds = OPENAPI_CONFIG.builds.map((build) => ({
  name: `mc8yp-server-build-${build.version}`,
  entry: { server: './src/index.ts' },
  treeshake: true,
  clean: build.version === OPENAPI_CONFIG.builds[0]?.version,
  dts: false,
  format: 'module' as const,
  plugins: [coreOpenApiPlugin({ mode: 'server', build }), bundledServicesPlugin()],
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
    plugins: [coreOpenApiPlugin({ mode: 'cli' }), bundledServicesPlugin()],
    // no external -> everything starting with @c8y/ should be bundled for cli usage
    noExternal: [/^@c8y\/.*$/],
    outDir: 'dist',
  },
])
