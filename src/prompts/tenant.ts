import { definePrompt } from 'tmcp/prompt'

import { prompt } from 'tmcp/utils'
/**
 * Tenant Context Prompt - Provides tenant info to agent
 */
import * as v from 'valibot'

import { getAuthenticatedClient } from '../utils/client'
import { addTenantURLToSchema } from '../utils/schema'

/**
 * Get current tenant context - use this before tenant-specific operations
 */
export function createTenantContextPrompt() {
  return definePrompt({
    name: 'tenant-context',
    description: 'Get current tenant context including tenantId, domain, and applications. Use before any tenant-specific operations.',
    schema: addTenantURLToSchema(v.object({})),
  }, async (input) => {
    try {
      const client = await getAuthenticatedClient(input)

      // Get current tenant
      const tenant = await client.tenant.current({ withParent: true })

      // Get current user
      const user = await client.user.current()

      const tenantInfo = {
        tenantId: tenant.data.name,
        domain: tenant.data.domainName,
        allowCreateTenants: tenant.data.allowCreateTenants,
        parent: tenant.data.parent,
      }

      const userInfo = {
        username: user.data.userName,
        email: user.data.email,
        firstName: user.data.firstName,
        lastName: user.data.lastName,
        roles: user.data.effectiveRoles?.map((r: { name: string }) => r.name) ?? [],
      }

      return prompt.message(
        `# Tenant Context

## Current Tenant
- **Tenant ID**: ${tenantInfo.tenantId}
- **Domain**: ${tenantInfo.domain}
- **Parent**: ${tenantInfo.parent ?? 'none'}
- **Can Create Tenants**: ${tenantInfo.allowCreateTenants}

## Current User
- **Username**: ${userInfo.username}
- **Email**: ${userInfo.email ?? 'not set'}
- **Name**: ${[userInfo.firstName, userInfo.lastName].filter(Boolean).join(' ') || 'not set'}
- **Roles**: ${userInfo.roles.join(', ') || 'none'}


---
Use \`tenantId: "${tenantInfo.tenantId}"\` for any tenant-specific API calls.`,
      )
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      return prompt.message(`Error getting tenant context: ${msg}`)
    }
  })
}

/**
 * Audit query help prompt
 */
export function createAuditQueryPrompt() {
  return definePrompt({
    name: 'audit-query',
    description: 'Get help with audit log queries and available audit types.',
    schema: addTenantURLToSchema(v.object({})),
  }, () => {
    return prompt.message(
      `# Audit Query Help

## ⚠️ CRITICAL: Date Range Required
Audit queries REQUIRE BOTH dateFrom AND dateTo in ISO format. Do NOT provide just one.
Use the \`datetime-guide\` or \`calculate-date-range\` prompts to get proper ISO date ranges for sensible time periods.

**Common sensible ranges:**
- **Today**: dateFrom: "2025-12-16T00:00:00Z", dateTo: "2025-12-17T00:00:00Z"
- **Past 24 hours**: dateFrom: "2025-12-16T00:00:00Z", dateTo: "2025-12-17T00:00:00Z"
- **Past week**: dateFrom: "2025-12-10T00:00:00Z", dateTo: "2025-12-17T00:00:00Z"
- **Past 30 days**: dateFrom: "2025-11-17T00:00:00Z", dateTo: "2025-12-17T00:00:00Z"
- **This month**: dateFrom: "2025-12-01T00:00:00Z", dateTo: "2025-12-17T00:00:00Z"

## Audit Record Types
- \`Alarm\` - Alarm changes
- \`Application\` - Application changes
- \`Event\` - Event changes
- \`Inventory\` - Managed object changes
- \`Operation\` - Operation changes
- \`User\` - User management
- \`Group\` - Group management
- \`Tenant\` - Tenant management
- \`SingleSignOn\` - SSO events
- \`UserAuthentication\` - Login/logout

## Query Parameters
- \`dateFrom\` - **REQUIRED**: Start date in ISO format
- \`dateTo\` - **REQUIRED**: End date in ISO format
- \`user\` - Filter by username
- \`type\` - Filter by audit type
- \`application\` - Filter by app name (cockpit, devicemanagement, etc.)
- \`source\` - Filter by device/object ID

## Example Queries
\`\`\`
# User authentication in past 24 hours
get-audit(type: "UserAuthentication", dateFrom: "2025-12-16T00:00:00.000Z", dateTo: "2025-12-17T00:00:00.000Z")

# Changes by specific user in past week
get-audit(user: "admin", dateFrom: "2025-12-10T00:00:00.000Z", dateTo: "2025-12-17T00:00:00.000Z")

# Recent device changes (last 7 days)
get-audit(type: "Inventory", source: "12345", dateFrom: "2025-12-10T00:00:00.000Z", dateTo: "2025-12-17T00:00:00.000Z")

# Alarm changes in specific time range
get-audit(type: "Alarm", dateFrom: "2025-12-01T00:00:00.000Z", dateTo: "2025-12-17T23:59:59.999Z")
\`\`\`

**Tip**: Always use \`datetime-guide\` prompt to calculate proper ISO date ranges for any time period.`,
    )
  })
}

/**
 * Applications/Extensions/Widgets query help prompt
 */
export function createApplicationsGuidePrompt() {
  return definePrompt({
    name: 'applications-guide',
    description: 'Guide for querying applications, extensions, plugins, widgets, and microservices.',
    schema: addTenantURLToSchema(v.object({})),
  }, () => {
    return prompt.message(
      `# Cumulocity Applications Guide

## Terminology
In Cumulocity, "application" is a general term that covers:

| User Asks For | What It Is | How To Query |
|---------------|------------|--------------|
| **Widget** | UI component inside an extension | Query extensions (type=HOSTED), then look at manifest |
| **Extension/Plugin/Package** | Frontend package with widgets | \`type=HOSTED\` |
| **Microservice** | Backend service | \`type=MICROSERVICE\` |
| **Application** | Any of the above | No type filter |

## Type Parameter
- \`HOSTED\` = Extensions, plugins, packages (frontend) - **contains widgets**
- \`MICROSERVICE\` = Backend services
- \`EXTERNAL\` = External links/apps

## Availability Parameter
- \`MARKET\` = Downloaded from official Cumulocity marketplace
- \`PRIVATE\` = Manually uploaded by tenant (could be Cumulocity, third-party, or custom-developed)
- \`SHARED\` = Shared across tenants

### Identifying Custom-Developed Applications
An application with PRIVATE availability is custom-developed if:
1. **Package name** contains a company/org name other than "cumulocity"
2. **Metadata** references a custom domain (particularly one matching the tenant's custom domain, excluding the tenant ID)

Example: A PRIVATE extension named \`acme-inventory-widget\` with metadata URLs containing \`acme.example.com\` is likely custom-developed by ACME for this tenant.

## Common Queries

### Get all extensions/plugins (frontend packages)
\`\`\`
get-applications(type: "HOSTED")
\`\`\`

### Get all microservices (backend)
\`\`\`
get-applications(type: "MICROSERVICE")
\`\`\`

### Get custom/manually-uploaded extensions
\`\`\`
get-applications(type: "HOSTED", availability: "PRIVATE")
\`\`\`
*Note: These could be Cumulocity rebuilds, third-party, or custom-developed. Check package name and metadata to identify actual custom development.*

### Get official marketplace extensions
\`\`\`
get-applications(type: "HOSTED", availability: "MARKET")
\`\`\`

### Get all manually-uploaded code (extensions + microservices)
\`\`\`
get-applications(availability: "PRIVATE")
\`\`\`
*Note: Includes Cumulocity rebuilds, third-party, and custom-developed. See "Identifying Custom-Developed Applications" section above.*

## Finding Widgets
Widgets cannot be queried directly. To find widgets:
1. Query extensions: \`get-applications(type: "HOSTED")\`
2. Get the extension details with \`get-object(id)\`
3. Look at the \`c8y_Manifest\` or package contents for widget definitions

## Getting Application Details
Use \`get-application(id)\` to retrieve detailed information about a specific application including type, availability, owner, and metadata.

## Getting Versions
Use \`get-application-versions(id)\` with any application ID to see all versions.

⚠️ **Note**: Only HOSTED applications (extensions/plugins) support versioning. MICROSERVICE applications do NOT support versioning and will return an error if you try to retrieve versions.`,
    )
  })
}
