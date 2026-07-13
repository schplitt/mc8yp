import { defineTool } from 'tmcp/tool'
import { tool } from 'tmcp/utils'
import * as v from 'valibot'
import { c8yMcpServer } from '../server-instance'
import { clearActiveTenant, writeActiveTenant } from '../cli/active-tenant'
import { clearCliTenantContext, setCliTenantContext } from '../cli/tenant-context'
import { getBundledOnlySpecs } from '../utils/spec-resolution'

/**
 * Clear the active tenant everywhere it is recorded: persistence file,
 * in-memory CLI context, and the shared MCP custom context. The custom-
 * context update is what makes subsequent `codemode` calls observe the
 * no-tenant state — discovery falls back to bundled-only specs, live API
 * calls error loudly on missing auth.
 *
 * Exported so the drift-recovery paths (status, CLI startup) can reuse
 * the same teardown the explicit reset uses.
 */
export function resetActiveTenant(): void {
  clearActiveTenant()
  clearCliTenantContext()
  const custom = c8yMcpServer.ctx.custom
  if (custom) {
    custom.auth = undefined
    custom.specs = getBundledOnlySpecs()
  }
}

export function createSetActiveTenantTool() {
  return defineTool(
    {
      name: 'set-active-tenant',
      title: 'Set Active Tenant',
      description: 'Set the Cumulocity tenant for this CLI session, or pass tenantUrl: null to clear the active tenant. The tenantUrl must match one returned by the status tool. The selection is persisted across sessions so you only need to call this once (or when switching tenants). Clearing falls back to bundled-only browsing — codemode discovery still works but live API calls are unavailable until a tenant is set again.',
      schema: v.object({
        tenantUrl: v.nullable(
          v.pipe(
            v.string(),
            v.url('Must be a valid URL, e.g. https://mytenant.cumulocity.com'),
            v.description('Base URL of the Cumulocity tenant — must be present in the status tool output. Pass null to clear the active tenant.'),
          ),
        ),
      }),
    },
    async (input) => {
      try {
        if (input.tenantUrl === null) {
          resetActiveTenant()
          return tool.text(
            'Active tenant cleared. Codemode discovery now falls back to all bundled OpenAPI snapshots; live API calls are unavailable until you set a tenant. Call set-active-tenant with a tenantUrl from the status tool to reconnect.',
          )
        }

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
        // codemode calls read from it without needing to re-resolve.
        const custom = c8yMcpServer.ctx.custom
        if (!custom) {
          // should never happen
          throw new Error('MCP server context not initialized')
        }

        custom.auth = { tenantUrl: ctx.tenantUrl, authorizationHeader: ctx.authorizationHeader }
        custom.specs = ctx.specs

        const specKeys = Object.entries(ctx.specs)
          .filter(([, v]) => v !== null)
          .map(([k]) => k)
        return tool.text(
          `Active tenant set to ${input.tenantUrl}. Available specs: ${specKeys.join(', ') || '(none)'}. You can now use the codemode tool.`,
        )
      } catch (error) {
        return tool.error(error instanceof Error ? error.message : String(error))
      }
    },
  )
}
