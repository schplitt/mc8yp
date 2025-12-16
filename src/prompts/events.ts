/**
 * Event Prompts - Help users query and understand device events
 */

import { definePrompt } from 'tmcp/prompt'
import { prompt } from 'tmcp/utils'
import * as v from 'valibot'
import { getAuthenticatedClient } from '../utils/client'
import { addTenantURLToSchema } from '../utils/schema'

/**
 * Guide for querying events
 */
export function createEventsGuidePrompt() {
  return definePrompt({
    name: 'events-guide',
    description: 'Learn about querying events in Cumulocity.',
  }, () => {
    return prompt.message(
      `# Understanding Events in Cumulocity

## What Are Events?
Events record things that happened on devices:
- Configuration changes
- User actions
- State transitions
- Location updates
- Custom application events

## Key Difference from Alarms
- **Events**: Informational, record what happened
- **Alarms**: Problems requiring attention, have severity/status

## Querying Events

### By Device (Most Common)
\`\`\`
get-events(deviceId: "12345", pageSize: 20)
\`\`\`

### By Type
\`\`\`
get-events(deviceId: "12345", type: "c8y_LocationUpdate")
\`\`\`

### By Time Range
\`\`\`
get-events(deviceId: "12345", dateFrom: "2024-01-01", dateTo: "2024-01-31")
\`\`\`

## Common Event Types
- \`c8y_LocationUpdate\` - GPS position change
- \`c8y_ConfigurationUpdate\` - Config changed
- \`c8y_SoftwareUpdate\` - Software installed
- \`c8y_FirmwareUpdate\` - Firmware flashed
- \`c8y_ConnectionEvent\` - Device connected/disconnected

## Tips
- Always filter by device - events can be numerous
- Use \`get-event-types\` to discover what types exist for a device
- Time ranges help narrow results`,
    )
  })
}

/**
 * Discover event types for a device
 */
export function createDeviceEventTypesPrompt() {
  return definePrompt({
    name: 'device-event-types',
    description: 'Discover what event types a device generates.',
    schema: addTenantURLToSchema(v.object({
      deviceId: v.pipe(v.string(), v.minLength(1), v.description('Device ID to check')),
    })),
  }, async (input) => {
    try {
      const client = await getAuthenticatedClient(input)

      // Get device name
      const device = (await client.inventory.detail(input.deviceId)).data
      const name = (device as Record<string, unknown>).name ?? 'Unknown'

      // Get recent events to discover types
      const events = await client.event.list({
        source: input.deviceId,
        pageSize: 100,
      })

      // Count by type
      const typeCounts = new Map<string, number>()
      for (const event of events.data) {
        const count = typeCounts.get(event.type) ?? 0
        typeCounts.set(event.type, count + 1)
      }

      const sortedTypes = [...typeCounts.entries()].sort((a, b) => b[1] - a[1])

      return prompt.message(
        `# Event Types for: ${name}
Device ID: ${input.deviceId}

## Found Types (from last ${events.data.length} events)
${sortedTypes.length > 0
  ? sortedTypes.map(([type, count]) =>
      `- **${type}**: ${count} events`).join('\n')
  : 'No events found for this device.'}

## Query Specific Type
${sortedTypes.length > 0 && sortedTypes[0]
  ? `\`\`\`
get-events(deviceId: "${input.deviceId}", type: "${sortedTypes[0][0]}")
\`\`\``
  : 'No types available to query.'}

## Get All Recent Events
\`\`\`
get-events(deviceId: "${input.deviceId}", pageSize: 20)
\`\`\``,
      )
    } catch (e) {
      return prompt.message(`Error: ${e instanceof Error ? e.message : String(e)}`)
    }
  })
}
