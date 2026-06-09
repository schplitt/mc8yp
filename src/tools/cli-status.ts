import { defineTool } from 'tmcp/tool'
import { tool } from 'tmcp/utils'
import { getCliTenantContext } from '../cli/tenant-context'
import { resetActiveTenant } from './active-tenant'

export function createCliStatusTool() {
  return defineTool(
    {
      name: 'cli-status',
      description: 'Read the current CLI status: stored tenant credentials and which tenant query and execute will hit. Call this before doing real work so you know which tenant you are operating against. If no tenant is active, query falls back to all bundled OpenAPI snapshots and execute is unavailable — set-active-tenant must be called first. This tool also self-heals: if the active tenant has lost its stored credentials it is automatically reset before the status is reported.',
    },
    async () => {
      const creds = await globalThis._getStoredC8yAuth()
      let active = getCliTenantContext()
      let driftRecoveryNotice: string | null = null

      if (active && !creds.some((c) => c.tenantUrl === active!.tenantUrl)) {
        // Drift: the active tenant has no stored credentials anymore (e.g. the
        // user ran `creds remove` mid-session). The session cannot do any
        // authenticated work for it, so wipe it everywhere.
        const cleared = active.tenantUrl
        resetActiveTenant()
        active = null
        driftRecoveryNotice = `Active tenant ${cleared} was cleared automatically because no credentials are stored for it. Query now falls back to all bundled OpenAPI snapshots; execute is unavailable until you set a tenant.`
      }

      const sections: string[] = []

      if (driftRecoveryNotice) {
        sections.push(driftRecoveryNotice)
      }

      if (active) {
        sections.push(`Active tenant: ${active.tenantUrl}`)
      } else {
        sections.push('Active tenant: (none) — query falls back to all bundled OpenAPI snapshots; execute is unavailable until set-active-tenant is called. Visibility in the bundled-only mode does NOT guarantee any service is installed on any tenant.')
      }

      if (creds.length === 0) {
        sections.push('Stored credentials: (none). Use `creds add` from the shell to register a tenant before calling set-active-tenant.')
      } else {
        const lines = creds.map((c) => `- ${c.tenantUrl} (tenantId: ${c.tenantId})`).join('\n')
        sections.push(`Stored credentials:\n${lines}`)
      }

      if (!active && creds.length > 0) {
        sections.push('Next step: call set-active-tenant with one of the tenant URLs above before using query or execute.')
      }

      return tool.text(sections.join('\n\n'))
    },
  )
}
