import { defineTool } from 'tmcp/tool'
import { tool } from 'tmcp/utils'
import * as v from 'valibot'
import { c8yMcpServer } from '../server-instance'
import { writeActiveTenant } from '../cli/active-tenant'
import { setCliTenantContext } from '../cli/tenant-context'

export function createSetActiveTenantTool() {
  return defineTool(
    {
      name: 'set-active-tenant',
      title: 'Set Active Tenant',
      description: 'Set the Cumulocity tenant for this CLI session. The tenantUrl must match one returned by list-credentials. The selection is persisted across sessions so you only need to call this once (or when switching tenants).',
      schema: v.object({
        tenantUrl: v.pipe(
          v.string(),
          v.url('Must be a valid URL, e.g. https://mytenant.cumulocity.com'),
          v.description('Base URL of the Cumulocity tenant — must be present in list-credentials'),
        ),
      }),
    },
    async (input) => {
      try {
        // Validate: tenantUrl must be in stored credentials
        const storedCreds = await globalThis._getStoredC8yAuth()
        const known = storedCreds.find((c) => c.tenantUrl === input.tenantUrl)
        if (!known) {
          const available = storedCreds.map((c) => c.tenantUrl).join(', ')
          return tool.error(
            `Tenant ${input.tenantUrl} not found in stored credentials.${
              available ? ` Known tenants: ${available}` : ' No tenants stored — use creds add first.'}`,
          )
        }

        writeActiveTenant(input.tenantUrl)
        const ctx = await setCliTenantContext(input.tenantUrl)

        // Push auth and specs into the shared MCP context so all subsequent
        // tool calls (query, execute) read from it without needing to re-resolve.
        const custom = c8yMcpServer.ctx.custom
        if (!custom) {
          // should never happen
          throw new Error('MCP server context not initialized')
        }

        custom.auth = { tenantUrl: ctx.tenantUrl, authorizationHeader: ctx.authorizationHeader }
        custom.specs = ctx.specs
        custom.specsEnabled = ctx.specsEnabled

        const specKeys = Object.entries(ctx.specs)
          .filter(([, v]) => v !== null)
          .map(([k]) => k)
        return tool.text(
          `Active tenant set to ${input.tenantUrl}. Available specs: ${specKeys.join(', ') || '(none)'}. You can now use query and execute.`,
        )
      } catch (error) {
        return tool.error(error instanceof Error ? error.message : String(error))
      }
    },
  )
}
