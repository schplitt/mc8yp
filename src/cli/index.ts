#!/usr/bin/env node
import { StdioTransport } from '@tmcp/transport-stdio'
import { defineCommand, runMain } from 'citty'
import consola from 'consola'
import pkgjson from '../../package.json' with { type: 'json' }
import { getCoreOpenApiLabel, getCoreOpenApiVersion, setCoreOpenApiVersion, specs } from '#core-openapi'
import { c8yMcpServer, setupMcpServer } from '../server'
import { getCredentialsByTenantUrl, getStoredC8yAuth } from '../utils/credentials'
import { parseAllowRule, parseNoMcp, parseRestrictionRule } from '../utils/restrictions'
import { clearActiveTenant, readActiveTenantUrl } from './active-tenant'
import { getCliTenantContext, setCliTenantContext } from './tenant-context'
import { getBundledOnlyCapabilities } from '../utils/capability-resolution'

const main = defineCommand({
  meta: {
    name: `${pkgjson.name}-cli`,
    version: pkgjson.version,
    description: pkgjson.description,
  },
  args: {
    'restriction': {
      type: 'string',
      description: 'Restriction rule to deny API access (for example "GET:/inventory/**"). Can be repeated.',
      alias: ['r', 'restrict'],
    },
    'allowed': {
      type: 'string',
      description: 'Allow rule to permit API access (for example "GET:/inventory/**"). Can be repeated. When present, non-matching operations are blocked unless another allow rule matches them.',
      alias: ['a', 'allow'],
    },
    'spec': {
      type: 'string',
      description: `Bundled core OpenAPI snapshot to expose to codemode. Available: ${specs.map((e) => `${e.version} (${e.label})`).join(', ')}.`,
      alias: 's',
      default: getCoreOpenApiVersion(),
    },
    'no-mcp': {
      type: 'string',
      description: 'Disable MCP wrapping: pass "*" (or no value) for all services, or a contextPath. Can be repeated. Opted-out services fall back to their OpenAPI spec.',
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

    const rawNoMcp = args['no-mcp'] as string | boolean | Array<string | boolean> | undefined
    const noMcp = parseNoMcp(Array.isArray(rawNoMcp) ? rawNoMcp : rawNoMcp !== undefined ? [rawNoMcp] : [])
    if (noMcp.all || noMcp.contextPaths.size > 0) {
      consola.info(`MCP wrapping disabled for: ${noMcp.all ? 'all services' : [...noMcp.contextPaths].join(', ')}`)
    }

    // If a tenant was previously selected, populate the in-memory context now
    // so the first tool call is immediately ready — discovery cost is paid here
    // at startup, not deferred to the first tool call.
    const activeTenant = readActiveTenantUrl()
    if (activeTenant) {
      try {
        const tenantCtx = await setCliTenantContext(activeTenant)
        const specKeys = Object.keys(tenantCtx.specs.specs)
        const mcpKeys = Object.keys(tenantCtx.specs.mcpServers)
        consola.info(`Active tenant: ${activeTenant}`)
        consola.info(`Startup discovery complete — OpenAPI specs: ${specKeys.length > 0 ? specKeys.join(', ') : 'none'}; MCP servers: ${mcpKeys.length > 0 ? mcpKeys.join(', ') : 'none'}`)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        // Drift recovery: if the persistence file points at a tenant whose
        // credentials no longer exist, wipe the persistence file so the next
        // restart is clean. Other failure modes (network, discovery) keep
        // the persistence file alone — they may be transient.
        if (message.includes('No stored credentials found for tenant URL')) {
          clearActiveTenant()
          consola.warn(`Active tenant ${activeTenant} was cleared because no credentials are stored for it. Call set-active-tenant with a known tenant URL or run 'creds add' first.`)
        } else {
          consola.warn(`Could not activate tenant ${activeTenant}:`, message)
        }
      }
    } else {
      consola.info('No active tenant set. Call set-active-tenant to connect before making live API calls through codemode. Discovery will run once a tenant is activated.')
    }

    setupMcpServer('cli')

    const transport = new StdioTransport(c8yMcpServer)
    const active = getCliTenantContext()
    consola.info('Starting MCP server over stdio transport...')
    transport.listen({
      env: 'cli' as const,
      restrictions,
      allowRules: parsedAllowRules,
      noMcp,
      // No active tenant: expose every bundled spec so codemode discovery
      // stays useful as a reference. Live API calls throw a clear
      // missing-auth error so the agent cannot misuse this state.
      specs: active?.specs ?? getBundledOnlyCapabilities(),
      auth: active ? { tenantUrl: active.tenantUrl, authorizationHeader: active.authorizationHeader } : undefined,
    })
  },
})

runMain(main)
