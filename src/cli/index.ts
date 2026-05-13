import { StdioTransport } from '@tmcp/transport-stdio'
import { defineCommand, runMain } from 'citty'
import consola from 'consola'
import pkgjson from '../../package.json' with { type: 'json' }
import { getCoreOpenApiLabel, getCoreOpenApiVersion, setCoreOpenApiVersion, specs } from '#core-openapi'
import { createC8YMcpServer } from '../server'
import { getCredentialsByTenantUrl, getStoredC8yAuth } from '../utils/credentials'
import { createOpenApiPartAllowRules } from '../utils/openapi'
import { parseAllowRule, parseEnabledOpenApiParts, parseRestrictionRule } from '../utils/restrictions'

const main = defineCommand({
  meta: {
    name: `${pkgjson.name}-cli`,
    version: pkgjson.version,
    description: pkgjson.description,
  },
  args: {
    restriction: {
      type: 'string',
      description: 'Restriction rule to deny API access (for example "GET:/inventory/**"). Can be repeated.',
      alias: ['r', 'restrict'],
    },
    allowed: {
      type: 'string',
      description: 'Allow rule to permit API access (for example "GET:/inventory/**"). Can be repeated. When present, non-matching operations are blocked unless another allow rule matches them.',
      alias: ['a', 'allow'],
    },
    openapi: {
      type: 'string',
      description: 'Bundled OpenAPI parts to enable for query and execute. Repeat to narrow visibility to a subset such as "core". Defaults to all bundled specs.',
      alias: ['o', 'api'],
    },
    spec: {
      type: 'string',
      description: `Bundled core OpenAPI snapshot to expose to query. Available: ${specs.map((entry) => `${entry.version} (${entry.label})`).join(', ')}.`,
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
    const selected = specs.find((entry) => entry.version === requested)
    if (!selected) {
      throw new Error(`Invalid --spec value "${requested}". Available: ${specs.map((entry) => entry.version).join(', ')}`)
    }
    setCoreOpenApiVersion(selected.version)
    consola.info(`Using bundled core OpenAPI snapshot: ${getCoreOpenApiLabel()}`)

    const rawRestrictions = args.restriction
    const restrictionSources = (Array.isArray(rawRestrictions) ? rawRestrictions : rawRestrictions ? [rawRestrictions] : []).filter(
      (value): value is string => typeof value === 'string' && value.length > 0,
    )
    const { parsedRules: restrictions, failedRules: failedRestrictions } = parseRestrictionRule(restrictionSources)

    if (failedRestrictions.length > 0) {
      throw new Error([
        'One or more restriction flags could not be parsed:',
        ...failedRestrictions.map((rule) => `- ${rule.rule}: ${rule.reason}`),
      ].join('\n'))
    }

    const rawAllowed = args.allowed
    const allowSources = (Array.isArray(rawAllowed) ? rawAllowed : rawAllowed ? [rawAllowed] : []).filter(
      (value): value is string => typeof value === 'string' && value.length > 0,
    )
    const { parsedRules: parsedAllowRules, failedRules: failedAllowRules } = parseAllowRule(allowSources)

    if (failedAllowRules.length > 0) {
      throw new Error([
        'One or more allow flags could not be parsed:',
        ...failedAllowRules.map((rule) => `- ${rule.rule}: ${rule.reason}`),
      ].join('\n'))
    }

    if (restrictions.length > 0) {
      consola.info(`Applying ${restrictions.length} restriction rule(s):`, restrictions.map((r) => r.source))
    }

    if (parsedAllowRules.length > 0) {
      consola.info(`Applying ${parsedAllowRules.length} allow rule(s):`, parsedAllowRules.map((rule) => rule.source))
    }

    const rawOpenApi = args.openapi
    const openApiSources = (Array.isArray(rawOpenApi) ? rawOpenApi : rawOpenApi ? [rawOpenApi] : []).filter(
      (value): value is string => typeof value === 'string' && value.length > 0,
    )
    const { enabledApis, failedValues } = parseEnabledOpenApiParts(openApiSources)

    if (failedValues.length > 0) {
      throw new Error([
        'One or more OpenAPI flags could not be parsed:',
        ...failedValues.map((value) => `- ${value.value}: ${value.reason}`),
      ].join('\n'))
    }

    if (enabledApis.length > 0) {
      consola.info(`Enabled bundled OpenAPI parts for this connection:`, enabledApis)
    }

    // When a connection narrows bundled OpenAPI parts, expand that selection into
    // concrete allow rules here so execute enforcement can stay purely path/method-based.
    const allowRules = enabledApis.length > 0
      ? [...parsedAllowRules, ...createOpenApiPartAllowRules(enabledApis)]
      : parsedAllowRules

    const server = createC8YMcpServer()

    // Start the server with stdio transport
    const transport = new StdioTransport(server)
    consola.info('Starting MCP server over stdio transport...')
    transport.listen({ restrictions, allowRules, enabledApis })
  },
})

runMain(main)
