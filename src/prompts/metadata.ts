/**
 * Metadata Prompts - Dashboards and Audit
 */

import { definePrompt } from 'tmcp/prompt'
import { prompt } from 'tmcp/utils'

/**
 * Guide for metadata queries
 */
export function createMetadataGuidePrompt() {
  return definePrompt({
    name: 'metadata-guide',
    description: 'Learn about dashboards and audit logs.',
  }, () => {
    return prompt.message(
      `# Cumulocity Metadata: Dashboards & Audit

## Dashboards
Dashboards visualize device data. They can be:
- Device-specific: Show data from one device
- Group-specific: Aggregate data from a group
- Global: Platform-wide metrics

### Query Dashboards
\`\`\`
get-dashboards deviceId="12345"
\`\`\`

## Audit Logs
Audit logs track administrative actions and system events. 

⚠️ **CRITICAL**: Audit queries REQUIRE BOTH dateFrom AND dateTo in ISO format. Always provide a meaningful date range.

**Sensible defaults:**
- Past 24 hours: Yesterday to today
- Past week: 7 days ago to today
- Past month: 30 days ago to today
- This month: First day of month to today

Use the datetime-guide prompt to get proper ISO date ranges.

### Available Audit Types
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

### Query Examples

**All audit logs for today (use current date):**
\`\`\`
get-audit(dateFrom: "2025-12-16T00:00:00Z", dateTo: "2025-12-17T00:00:00Z")
\`\`\`

**Inventory changes by a specific user in past week:**
\`\`\`
get-audit(type: "Inventory", user: "admin", dateFrom: "2025-12-10T00:00:00Z", dateTo: "2025-12-17T00:00:00Z")
\`\`\`

**User authentication events in past 30 days:**
\`\`\`
get-audit(type: "UserAuthentication", dateFrom: "2025-11-17T00:00:00Z", dateTo: "2025-12-17T00:00:00Z")
\`\`\`

**Application changes in past 24 hours:**
\`\`\`
get-audit(type: "Application", dateFrom: "2025-12-16T00:00:00Z", dateTo: "2025-12-17T00:00:00Z")
\`\`\`

### Pagination
- \`pageSize\` - Number of results per page (default: 50)
- \`page\` - Page number (default: 1)

## Tips
- Always provide at least dateFrom or dateTo to avoid errors
- Use datetime-guide prompt to calculate proper ISO date ranges
- Audit logs require appropriate permissions
- Filter by user and type to narrow down large result sets`,
    )
  })
}
