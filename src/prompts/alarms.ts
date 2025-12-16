/**
 * Alarm Prompts - Help users monitor and understand alarms
 */

import { definePrompt } from 'tmcp/prompt'
import { prompt } from 'tmcp/utils'
import * as v from 'valibot'
import { addTenantURLToSchema } from '../utils/schema'

/**
 * Guide for alarm monitoring
 */
export function createAlarmsGuidePrompt() {
  return definePrompt({
    name: 'alarms-guide',
    description: 'Learn about alarm monitoring in Cumulocity.',
  }, () => {
    return prompt.message(
      `# Alarm Monitoring in Cumulocity

## What Are Alarms?
Alarms indicate problems or conditions requiring attention:
- Device failures
- Threshold violations
- Connection issues
- Battery warnings

## Alarm Severity
| Severity | Meaning |
|----------|---------|
| CRITICAL | Immediate action required |
| MAJOR    | Significant problem |
| MINOR    | Minor issue |
| WARNING  | Potential problem |

## Alarm Status
| Status | Meaning |
|--------|---------|
| ACTIVE | Unresolved, needs attention |
| ACKNOWLEDGED | Seen but not fixed |
| CLEARED | Problem resolved |

## Recommended Workflow

1. **Start with active alarms:**
   \`get-alarms(status: "ACTIVE")\` shows all unresolved alarms

2. **Check critical first:**
   \`get-alarms(status: "ACTIVE", severity: "CRITICAL")\` for urgent issues

3. **Device-specific:**
   \`get-alarms(deviceId: "12345")\` for one device

4. **Historical analysis:**
   \`get-alarms(dateFrom: "2025-12-01T00:00:00Z", dateTo: "2025-12-16T23:59:59Z")\` with date range

## Tips
- Active alarms should be your default view
- Critical and Major require immediate attention
- Use \`get-alarm-counts\` for a quick overview
- Time-based queries help identify patterns`,
    )
  })
}

/**
 * Show current alarm status
 */
export function createAlarmStatusPrompt() {
  return definePrompt({
    name: 'alarm-status',
    description: 'Get current alarm status overview.',
    schema: addTenantURLToSchema(v.object({
      deviceId: v.pipe(v.string(), v.description('Managed object ID (device, asset, group, etc.)')),
    })),
  }, async (input) => {
    try {
      return prompt.message(
        `# Alarm Status Overview

Active alarm counts for any managed object (device, asset, group, etc.) are efficiently retrieved from its \`c8y_ActiveAlarmsStatus\` fragment in the inventory.
This fragment contains a real-time summary of active alarms by severity:
- \`critical\`: Number of critical alarms
- \`major\`: Number of major alarms  
- \`minor\`: Number of minor alarms
- \`warning\`: Number of warning alarms

Use \`get-alarm-counts(deviceId: "${input.deviceId || 'YOUR_MANAGED_OBJECT_ID'}")\` to retrieve alarm counts for any managed object.

## Quick Actions

### View alarm counts for a managed object:
\`\`\`
get-alarm-counts(deviceId: "${input.deviceId || 'YOUR_MANAGED_OBJECT_ID'}")
\`\`\`

### View critical alarms:
\`\`\`
get-alarms(status: "ACTIVE", severity: "CRITICAL"${input.deviceId ? `, deviceId: "${input.deviceId}"` : ''})
\`\`\`

### View all active:
\`\`\`
get-alarms(status: "ACTIVE"${input.deviceId ? `, deviceId: "${input.deviceId}"` : ''}, pageSize: 20)
\`\`\`

### View by severity:
\`\`\`
get-alarms(severity: "MAJOR", status: "ACTIVE"${input.deviceId ? `, deviceId: "${input.deviceId}"` : ''})
\`\`\``,
      )
    } catch (e) {
      return prompt.message(`Error: ${e instanceof Error ? e.message : String(e)}`)
    }
  })
}
