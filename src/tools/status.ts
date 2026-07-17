import { BasicAuth, Client } from '@c8y/client'
import { defineTool } from 'tmcp/tool'
import { tool } from 'tmcp/utils'
import * as v from 'valibot'
import { getCliTenantContext } from '../cli/tenant-context'
import { c8yMcpServer } from '../server-instance'
import { refreshCapabilities } from '../utils/capability-discovery'
import { resolveCapabilities } from '../utils/capability-resolution'
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
    },
    async (input) => {
      return tool.text(await buildCliStatus(input.refresh === true))
    },
  )
}

async function buildCliStatus(refresh: boolean): Promise<string> {
  const creds = await globalThis._getStoredC8yAuth()
  let active = getCliTenantContext()
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

  if (refresh) {
    if (!active) {
      sections.push('Refresh requested but no tenant is active — nothing to refresh. Call set-active-tenant first.')
    } else {
      sections.push(await refreshCliActiveTenant(active.tenantUrl))
      // Pick up the post-refresh context for the visibility section below.
      active = getCliTenantContext()
    }
  }

  if (active) {
    sections.push(`Active tenant: ${active.tenantUrl}`)
  } else {
    sections.push('Active tenant: (none) — codemode discovery falls back to all bundled OpenAPI snapshots; live API calls are unavailable until set-active-tenant is called. Visibility in the bundled-only mode does NOT guarantee any service is installed on any tenant.')
  }

  if (creds.length === 0) {
    sections.push('Stored credentials: (none). Use `creds add` from the shell to register a tenant before calling set-active-tenant.')
  } else {
    const lines = creds.map((c) => `- ${c.tenantUrl} (tenantId: ${c.tenantId})`).join('\n')
    sections.push(`Stored credentials:\n${lines}`)
  }

  if (!active && creds.length > 0) {
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
    const creds = await globalThis._getCredentialsByTenantUrl(tenantUrl)
    const client = new Client(
      new BasicAuth({ tenant: creds.tenantId, user: creds.user, password: creds.password }),
      tenantUrl,
    )
    const result = await refreshCapabilities(creds.tenantId, client)
    const resolved = resolveCapabilities(result.specs, result.installedContextPaths, result.mcpServers)

    // Update both the CLI-local context and the shared MCP custom context
    // so subsequent codemode calls see the new surface immediately.
    const cliCtx = getCliTenantContext()
    if (cliCtx) {
      cliCtx.specs = resolved
    }
    const custom = c8yMcpServer.ctx.custom
    if (custom) {
      custom.specs = resolved
    }
    return `Refreshed API discovery for ${tenantUrl}: ${result.specs.length} spec(s) downloaded, ${result.mcpServers.length} MCP server(s) connected, ${result.installedContextPaths.size} subscribed application(s).`
  } catch (err) {
    return `Refresh failed for ${tenantUrl}: ${err instanceof Error ? err.message : String(err)}`
  }
}
