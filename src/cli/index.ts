import { StdioTransport } from '@tmcp/transport-stdio'
import { defineCommand, runMain } from 'citty'
import consola from 'consola'
import pkgjson from '../../package.json' with { type: 'json' }
import { getCoreOpenApiLabel, getCoreOpenApiVersion, setCoreOpenApiVersion, specs } from '#core-openapi'
import { createC8YMcpServer } from '../server'
import { getCredentialsByTenantUrl, getStoredC8yAuth } from '../utils/credentials'
import { parseRestrictionRule } from '../utils/restrictions'

const main = defineCommand({
  meta: {
    name: `${pkgjson.name}-cli`,
    version: pkgjson.version,
    description: pkgjson.description,
  },
  args: {
    restriction: {
      type: 'string',
      description: 'Restriction rule to deny API access (e.g. "GET:/inventory/**"). Can be repeated.',
      alias: ['r', 'restrict'],
    },
    spec: {
      type: 'string',
      description: `Core OpenAPI snapshot to expose to query. Available: ${specs.map((s) => `${s.version} (${s.label})`).join(', ')}.`,
      alias: 's',
      default: getCoreOpenApiVersion(),
    },
  },
  setup: () => {
    globalThis.executionEnvironment = 'cli'
    // Expose credential functions globally for subcommands and tools to use
    globalThis._getCredentialsByTenantUrl = getCredentialsByTenantUrl
    globalThis._getStoredC8yAuth = getStoredC8yAuth
  },
  subCommands: {
    creds: () => import('./subcommands/creds').then((m) => m.default),
  },
  run: async ({ args }) => {
    const rawSpecVersion = Array.isArray(args.spec) ? args.spec.at(-1) : args.spec
    const requested = rawSpecVersion ?? getCoreOpenApiVersion()
    const selected = specs.find((s) => s.version === requested)
    if (!selected) {
      throw new Error(`Invalid --spec value "${requested}". Available: ${specs.map((s) => s.version).join(', ')}`)
    }
    setCoreOpenApiVersion(selected.version)
    consola.info(`Using core OpenAPI snapshot: ${getCoreOpenApiLabel()}`)

    const raw = args.restriction
    const restrictionSources = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter(
      (value): value is string => typeof value === 'string' && value.length > 0,
    )
    const { parsedRules: restrictions, failedRules } = parseRestrictionRule(restrictionSources)

    if (failedRules.length > 0) {
      throw new Error([
        'One or more restriction flags could not be parsed:',
        ...failedRules.map((rule) => `- ${rule.rule}: ${rule.reason}`),
      ].join('\n'))
    }

    if (restrictions.length > 0) {
      consola.info(`Applying ${restrictions.length} restriction rule(s):`, restrictions.map((r) => r.source))
    }

    const server = createC8YMcpServer()

    // Start the server with stdio transport
    const transport = new StdioTransport(server)
    consola.info('Starting MCP server over stdio transport...')
    transport.listen({ restrictions })
  },
})

runMain(main)
