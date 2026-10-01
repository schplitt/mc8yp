import { isInputRequired } from 'tmcp'
import { defineTool } from 'tmcp/tool'
import { tool } from 'tmcp/utils'
import * as v from 'valibot'
import { getCliTenantContext, getPendingCliTenantUrl } from '../cli/tenant-context'
import { createCliClient, getFreshCliCredentials } from '../cli/tfa-session'
import { c8yMcpServer } from '../server-instance'
import { refreshCapabilities } from '../utils/capability-discovery'
import { resolveCapabilities } from '../utils/capability-resolution'
import { createC8yAuthHeaders } from '../utils/client'
import { resetActiveTenant } from './active-tenant'

const STATUS_TOOL_DESCRIPTION
  = 'Show the current CLI status: stored tenant credentials, which tenant the codemode tool will hit, and the API namespaces visible right now. '
    + 'If no tenant is active, codemode discovery falls back to all bundled OpenAPI snapshots and live API calls are unavailable — set-active-tenant must be called first. '
    + 'This tool also self-heals: if the active tenant has lost its stored credentials it is automatically reset before the status is reported.\n\n'
    + 'Pass `refresh: true` to force a fresh API spec discovery against the active tenant. Use this after subscribing or unsubscribing a microservice in the tenant — otherwise discovered specs stay cached for 30 minutes. '
    + 'If no tenant is active, `refresh: true` is a noop.'

export function createStatusTool() {
  return defineTool(
    {
      name: 'status',
      title: 'mc8yp Status',
      description: STATUS_TOOL_DESCRIPTION,
      schema: v.object({
        refresh: v.optional(
          v.pipe(
            v.boolean(),
            v.description('When true, bust the API discovery cache for the active tenant and run a fresh discovery before reporting. Noop when no tenant is active.'),
          ),
          false,
        ),
      }),
      // A refresh against a TFA tenant may ask the client for a new TFA
      // code first; everything before it is read-only, so a replay is safe.
      replayable: true,
    },
    async (input) => {
      return tool.text(await buildCliStatus(input.refresh === true))
    },
  )
}

async function buildCliStatus(refresh: boolean): Promise<string> {
  const creds = await globalThis._getStoredC8yAuth()
  let active = getCliTenantContext()
  let pending = getPendingCliTenantUrl()
  const sections: string[] = []

  // Drift recovery: the active tenant has no stored credentials anymore
  // (e.g. the user ran `creds remove` mid-session).
  if (active && !creds.some((c) => c.tenantUrl === active!.tenantUrl)) {
    const cleared = active.tenantUrl
    resetActiveTenant()
    active = null
    sections.push(
      `Active tenant ${cleared} was cleared automatically because no credentials are stored for it. `
      + 'Codemode discovery now falls back to all bundled OpenAPI snapshots; live API calls are unavailable until you set a tenant.',
    )
  }

  if (pending && !creds.some((c) => c.tenantUrl === pending)) {
    sections.push(`Selected tenant ${pending} was cleared automatically because no credentials are stored for it.`)
    resetActiveTenant()
    pending = null
  }

  if (refresh) {
    if (pending) {
      sections.push(`Refresh skipped: ${pending} is waiting for a new TFA code. The next codemode or set-active-tenant call asks for it and runs discovery.`)
    } else if (!active) {
      sections.push('Refresh requested but no tenant is active — nothing to refresh. Call set-active-tenant first.')
    } else {
      sections.push(await refreshCliActiveTenant(active.tenantUrl))
      // Pick up the post-refresh context for the visibility section below.
      active = getCliTenantContext()
    }
  }

  if (active) {
    sections.push(`Active tenant: ${active.tenantUrl}`)
  } else if (pending) {
    sections.push(`Active tenant: ${pending} — waiting for a new TFA code because the stored TFA session expired. The next codemode or set-active-tenant call asks the user for it; until then codemode calls fail without running.`)
  } else {
    sections.push('Active tenant: (none) — codemode discovery falls back to all bundled OpenAPI snapshots; live API calls are unavailable until set-active-tenant is called. Visibility in the bundled-only mode does NOT guarantee any service is installed on any tenant.')
  }

  if (creds.length === 0) {
    sections.push('Stored credentials: (none). Use `creds add` from the shell to register a tenant before calling set-active-tenant.')
  } else {
    const lines = creds.map((c) => {
      const tfa = c.tfaSession
        ? `, TFA session ${c.tfaSession.expiresAt <= Date.now() ? 'expired' : 'valid until'} ${new Date(c.tfaSession.expiresAt).toISOString()}`
        : ''
      return `- ${c.tenantUrl} (tenantId: ${c.tenantId}${tfa})`
    }).join('\n')
    sections.push(`Stored credentials:\n${lines}`)
  }

  if (!active && !pending && creds.length > 0) {
    sections.push('Next step: call set-active-tenant with one of the tenant URLs above before making live API calls through codemode.')
  }

  return sections.join('\n\n')
}

/**
 * Trigger a fresh discovery for the CLI's active tenant and update the
 * in-memory specs everywhere they are read from. Returns a short text
 * suitable for inclusion in the status output.
 * @param tenantUrl - Base URL of the active Cumulocity tenant.
 */
async function refreshCliActiveTenant(tenantUrl: string): Promise<string> {
  try {
    const creds = await getFreshCliCredentials(tenantUrl)
    const client = createCliClient(creds)
    const result = await refreshCapabilities(creds.tenantId, client)
    const resolved = resolveCapabilities(result.specs, result.installedContextPaths, result.mcpServers)

    // Update both the CLI-local context and the shared MCP custom context
    // so subsequent codemode calls see the new surface immediately — but
    // only if this tenant is still the active one (the refresh may have
    // waited on a TFA prompt while set-active-tenant switched tenants).
    // The auth header is refreshed too, in case the TFA session was renewed.
    const cliCtx = getCliTenantContext()
    if (cliCtx?.tenantUrl === tenantUrl) {
      cliCtx.specs = resolved
      cliCtx.authorizationHeader = createC8yAuthHeaders(creds).Authorization!
      cliCtx.tfaExpiresAt = creds.tfaSession?.expiresAt
      const custom = c8yMcpServer.ctx.custom
      if (custom) {
        custom.specs = resolved
        custom.auth = { tenantUrl, authorizationHeader: cliCtx.authorizationHeader }
      }
    }
    return `Refreshed API discovery for ${tenantUrl}: ${result.specs.length} spec(s) downloaded, ${result.mcpServers.length} MCP server(s) connected, ${result.installedContextPaths.size} subscribed application(s).`
  } catch (err) {
    if (isInputRequired(err)) {
      throw err
    }
    return `Refresh failed for ${tenantUrl}: ${err instanceof Error ? err.message : String(err)}`
  }
}
