#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { StdioTransport } from '@tmcp/transport-stdio'
import { defineCommand, runMain } from 'citty'
import consola from 'consola'
import pkgjson from '../../package.json' with { type: 'json' }
import { getCoreOpenApiLabel, getCoreOpenApiVersion, setCoreOpenApiVersion, specs } from '#core-openapi'
import { c8yMcpServer, setupMcpServer } from '../server'
import { getCredentialsByTenantUrl, getStoredC8yAuth } from '../utils/credentials'
import { parseAllowRule, parseRestrictionRule } from '../utils/restrictions'
import { clearActiveTenant, readActiveTenantUrl } from './active-tenant'
import { getCliTenantContext, setCliTenantContext } from './tenant-context'
import { getBundledOnlySpecs } from '../utils/spec-resolution'

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
    policyData: {
      type: 'string',
      description: 'Path to an OPA data.json file. When supplied, OPA decides whether to allow, elicit, or deny mutating operations instead of always prompting.',
      alias: ['p', 'policy-data'],
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

    const rawPolicyData = Array.isArray(args.policyData) ? args.policyData.at(-1) : args.policyData
    let policyDataPath: string | undefined
    if (rawPolicyData) {
      policyDataPath = resolve(rawPolicyData)
      if (!existsSync(policyDataPath)) {
        throw new Error(`--policy-data: file not found: ${policyDataPath}`)
      }
      try {
        JSON.parse(readFileSync(policyDataPath, 'utf8'))
      } catch {
        throw new Error(`--policy-data: file is not valid JSON: ${policyDataPath}`)
      }
      consola.info(`OPA policy data loaded: ${policyDataPath}`)
    }

    // If a tenant was previously selected, populate the in-memory context now
    // so the first tool call is immediately ready — discovery cost is paid here
    // at startup, not deferred to the first tool call.
    const activeTenant = readActiveTenantUrl()
    if (activeTenant) {
      try {
        const tenantCtx = await setCliTenantContext(activeTenant)
        const serviceKeys = Object.keys(tenantCtx.specs.specs)
        consola.info(`Active tenant: ${activeTenant}`)
        consola.info(`Startup discovery complete: ${serviceKeys.length} microservice API spec(s) found${serviceKeys.length > 0 ? ` [${serviceKeys.join(', ')}]` : ''}`)
        consola.info(`Available specs: ${['core', ...serviceKeys].join(', ')}`)
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
      consola.info('No active tenant set. Call set-active-tenant to connect before using query or execute. Discovery will run once a tenant is activated.')
    }

    setupMcpServer('cli')

    const transport = new StdioTransport(c8yMcpServer)
    const active = getCliTenantContext()
    consola.info('Starting MCP server over stdio transport...')
    transport.listen({
      env: 'cli' as const,
      restrictions,
      allowRules: parsedAllowRules,
      // No active tenant: expose every bundled spec so the query tool stays
      // useful as a reference. execute throws a clear missing-auth error so
      // the agent cannot misuse this state for real calls.
      specs: active?.specs ?? getBundledOnlySpecs(),
      auth: active ? { tenantUrl: active.tenantUrl, authorizationHeader: active.authorizationHeader } : undefined,
      policyDataPath,
    })
  },
})

runMain(main)
