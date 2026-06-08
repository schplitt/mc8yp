#!/usr/bin/env node
import { StdioTransport } from '@tmcp/transport-stdio'
import { defineCommand, runMain } from 'citty'
import consola from 'consola'
import pkgjson from '../../package.json' with { type: 'json' }
import { getCoreOpenApiLabel, getCoreOpenApiVersion, setCoreOpenApiVersion, specs } from '#core-openapi'
import { c8yMcpServer, setupMcpServer } from '../server'
import { getCredentialsByTenantUrl, getStoredC8yAuth } from '../utils/credentials'
import { parseAllowRule, parseRestrictionRule } from '../utils/restrictions'
import { readActiveTenantUrl } from './active-tenant'
import { configureSpecRemoval, getCliTenantContext, setCliTenantContext } from './tenant-context'

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
    spec: {
      type: 'string',
      description: `Bundled core OpenAPI snapshot to expose to query. Available: ${specs.map((e) => `${e.version} (${e.label})`).join(', ')}.`,
      alias: 's',
      default: getCoreOpenApiVersion(),
    },
    specRemoval: {
      type: 'boolean',
      description: 'When enabled (default), bundled specs for services not installed on the tenant are removed from the query sandbox. Pass --no-spec-removal to keep them visible for reference. Execute restrictions always apply regardless of this flag.',
      default: true,
    },
  },
  setup: () => {
    globalThis._getCredentialsByTenantUrl = getCredentialsByTenantUrl
    globalThis._getStoredC8yAuth = getStoredC8yAuth
  },
  subCommands: {
    creds: () => import('./subcommands/creds').then((m) => m.default),
  },
  run: async ({ args }) => {
    const rawSpecVersion = Array.isArray(args.spec) ? args.spec.at(-1) : args.spec
    const requested = rawSpecVersion ?? getCoreOpenApiVersion()
    const selected = specs.find((e) => e.version === requested)
    if (!selected) {
      throw new Error(`Invalid --spec value "${requested}". Available: ${specs.map((e) => e.version).join(', ')}`)
    }
    setCoreOpenApiVersion(selected.version)
    consola.info(`Using bundled core OpenAPI snapshot: ${getCoreOpenApiLabel()}`)

    const rawRestrictions = args.restriction
    const restrictionSources = (Array.isArray(rawRestrictions) ? rawRestrictions : rawRestrictions ? [rawRestrictions] : []).filter(
      (v): v is string => typeof v === 'string' && v.length > 0,
    )
    const { parsedRules: restrictions, failedRules: failedRestrictions } = parseRestrictionRule(restrictionSources)
    if (failedRestrictions.length > 0) {
      throw new Error(['One or more restriction flags could not be parsed:', ...failedRestrictions.map((r) => `- ${r.rule}: ${r.reason}`)].join('\n'))
    }

    const rawAllowed = args.allowed
    const allowSources = (Array.isArray(rawAllowed) ? rawAllowed : rawAllowed ? [rawAllowed] : []).filter(
      (v): v is string => typeof v === 'string' && v.length > 0,
    )
    const { parsedRules: parsedAllowRules, failedRules: failedAllowRules } = parseAllowRule(allowSources)
    if (failedAllowRules.length > 0) {
      throw new Error(['One or more allow flags could not be parsed:', ...failedAllowRules.map((r) => `- ${r.rule}: ${r.reason}`)].join('\n'))
    }

    if (restrictions.length > 0) {
      consola.info(`Applying ${restrictions.length} restriction rule(s):`, restrictions.map((r) => r.source))
    }
    if (parsedAllowRules.length > 0) {
      consola.info(`Applying ${parsedAllowRules.length} allow rule(s):`, parsedAllowRules.map((r) => r.source))
    }

    const specRemoval = args.specRemoval !== false
    if (!specRemoval) {
      consola.info('Spec removal disabled: bundled specs remain visible in query even when the service is not installed')
    }
    configureSpecRemoval(specRemoval)

    // If a tenant was previously selected, populate the in-memory context now
    // so the first tool call is immediately ready — discovery cost is paid here
    // at startup, not deferred to the first tool call.
    const activeTenant = readActiveTenantUrl()
    if (activeTenant) {
      try {
        const tenantCtx = await setCliTenantContext(activeTenant)
        const specKeys = Object.entries(tenantCtx.specs).filter(([, v]) => v !== null).map(([k]) => k)
        consola.info(`Active tenant: ${activeTenant}. Available specs: ${specKeys.join(', ') || '(none)'}`)
      } catch (err) {
        consola.warn(`Could not activate tenant ${activeTenant}:`, err instanceof Error ? err.message : String(err))
      }
    } else {
      consola.info('No active tenant set. Call set-active-tenant to connect before using query or execute.')
    }

    setupMcpServer('cli')

    const transport = new StdioTransport(c8yMcpServer)
    const active = getCliTenantContext()
    consola.info('Starting MCP server over stdio transport...')
    transport.listen({
      env: 'cli' as const,
      restrictions,
      allowRules: parsedAllowRules,
      specs: active?.specs ?? {},
      auth: active ? { tenantUrl: active.tenantUrl, authorizationHeader: active.authorizationHeader } : undefined,
    })
  },
})

runMain(main)
