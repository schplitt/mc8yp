import { defineTool } from 'tmcp/tool'
import { tool } from 'tmcp/utils'

export function createListCredentialsTool() {
  return defineTool(
    {
      name: 'list-credentials',
      description: 'List stored Cumulocity credentials',
    },
    async () => {
      // get stored credentials
      const creds = await globalThis._getStoredC8yAuth()

      if (creds.length === 0) {
        return tool.error('No stored credentials found.')
      }

      const lines = creds.map(
        (c) => `TenantUrl: ${c.tenantUrl}`,
      ).join('\n')

      return tool.text(`Found credentials for the following tenants:\n${lines}`)
    },
  )
}
