import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'tsdown'

const rootDir = path.dirname(fileURLToPath(import.meta.url))

const VIRTUAL_ID = '#core-openapi'
const RESOLVED_ID = '\0virtual:core-openapi'

interface OpenApiVersionEntry {
  version: string
  label: string
  url: string
  default?: boolean
}

const VERSIONS_CONFIG: OpenApiVersionEntry[] = JSON.parse(
  readFileSync(path.join(rootDir, 'openapi-versions.json'), 'utf8'),
).versions as OpenApiVersionEntry[]

type Version = string
const VERSIONS: Version[] = VERSIONS_CONFIG.map((e) => e.version)

function getLabelForVersion(version: Version): string {
  return VERSIONS_CONFIG.find((e) => e.version === version)?.label ?? version
}

function readSpecJson(version: Version): string {
  return readFileSync(path.join(rootDir, 'core-openapi', `${version}.json`), 'utf8').trim()
}

function generateEntries(versions: readonly Version[]): string {
  return versions
    .map((v) => `  { version: ${JSON.stringify(v)}, label: ${JSON.stringify(getLabelForVersion(v))}, spec: ${readSpecJson(v)} },`)
    .join('\n')
}

function generateCliModule(): string {
  const defaultVersion = VERSIONS_CONFIG.find((e) => e.default)?.version ?? VERSIONS[0] ?? 'release'
  return `export const specs = Object.freeze([
${generateEntries(VERSIONS)}
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

function generateServerModule(version: Version): string {
  return `export const specs = Object.freeze([
${generateEntries([version])}
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
  return specs[0]?.label ?? ${JSON.stringify(getLabelForVersion(version))};
}
`
}

export function coreOpenApiPlugin(options: { mode: 'cli' } | { mode: 'server', version: Version }) {
  return {
    name: 'mc8yp:core-openapi',
    resolveId(id: string) {
      if (id === VIRTUAL_ID) {
        return RESOLVED_ID
      }
      return null
    },
    load(id: string) {
      if (id !== RESOLVED_ID) {
        return null
      }
      return options.mode === 'cli'
        ? generateCliModule()
        : generateServerModule(options.version)
    },
  }
}

const serverBuilds = VERSIONS.map((version) => ({
  name: `mc8yp-server-build-${version}`,
  entry: { server: './src/index.ts' },
  treeshake: true,
  clean: version === 'release',
  dts: false,
  format: 'module' as const,
  plugins: [coreOpenApiPlugin({ mode: 'server', version })],
  outDir: `.output/${version}`,
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
    // no external -> everything starting with @c8y/ should be bundled for cli usage
    noExternal: [/^@c8y\/.*$/],
    outDir: 'dist',
  },
])
