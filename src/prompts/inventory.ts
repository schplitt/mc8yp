/**
 * Inventory Prompts - Help users construct queries and navigate IoT hierarchy
 *
 * These prompts provide completions where possible to help users discover
 * what's available before querying.
 */

import { definePrompt } from 'tmcp/prompt'
import { prompt } from 'tmcp/utils'
import * as v from 'valibot'
import { getAuthenticatedClient } from '../utils/client'
import { addTenantURLToSchema } from '../utils/schema'

/**
 * Help find devices - suggests common search patterns
 */
export function createFindDevicesPrompt() {
  return definePrompt({
    name: 'find-devices',
    description: 'Get guidance on finding devices in the inventory.',
    schema: addTenantURLToSchema(v.object({
      context: v.optional(v.pipe(v.string(), v.description('What kind of device are you looking for?'))),
    })),
  }, (input) => {
    const context = input.context || 'devices'

    return prompt.message(
      `# Finding Devices in Cumulocity

You're looking for: ${context}

## Recommended Workflow

1. **Start with a specific search:**
   Use \`query-inventory\` with filters to find devices.
   Example: \`query-inventory(query: "$filter=name eq 'MyDevice'")\`

2. **Search by name pattern:**
   Use OData query with contains or startswith.
   Example: \`query-inventory(query: "$filter=contains(name,'Sensor')")\`

3. **Search by capability:**
   Use \`query-inventory\` to find devices with specific features.
   Example: \`query-inventory(query: "$filter=has(c8y_IsDevice)")\`

4. **Navigate hierarchy:**
   Use \`list-children\` to explore device groups.

5. **Get specific object:**
   Use \`get-object(id: "12345")\` when you know the ID.

## Tips
- Never try to "list all" - there may be thousands of devices
- Always use filters in query-inventory
- Use \`get-supported-series\` on a device to see what it measures`,
    )
  })
}

/**
 * Help construct OData inventory queries
 */
export function createInventoryQueryPrompt() {
  return definePrompt({
    name: 'inventory-query',
    description: 'Get help constructing OData inventory queries. NOTE: OData query syntax ONLY works for inventory, not measurements/events/alarms.',
    schema: addTenantURLToSchema(v.object({
      queryType: v.optional(v.picklist(['filter', 'has', 'search', 'hierarchy', 'nested'])),
    })),
  }, (input) => {
    const examples: Record<string, string> = {
      filter: `
## Filter Queries
\`\`\`
$filter=has(c8y_IsDevice)                           # All devices
$filter=(name eq 'MyDevice')                        # Exact name
$filter=(name eq 'Sensor*')                         # Name wildcard
$filter=(type eq 'c8y_Linux')                       # By type
$filter=has(c8y_IsDevice) and (name eq 'Test*')    # Combined
\`\`\``,
      has: `
## Fragment (has) Queries
\`\`\`
$filter=has(c8y_IsDevice)          # Devices
$filter=has(c8y_IsDeviceGroup)     # Groups
$filter=has(c8y_IsAsset)           # Assets
$filter=has(c8y_Temperature)       # Has temperature
$filter=has(c8y_Position)          # Has GPS
$filter=has(c8y_Firmware)          # Has firmware info
\`\`\``,
      search: `
## Text Search
\`\`\`
$filter=(name eq '*sensor*')       # Contains 'sensor'
$filter=(owner eq 'admin')         # By owner
$filter=bygroupid(123456)          # In specific group
\`\`\``,
      hierarchy: `
## Hierarchy Queries
\`\`\`
$filter=bygroupid(123456)              # Direct children of group
$filter=isinhierarchyof(123456)        # All descendants
$filter=has(c8y_IsDevice) and bygroupid(123456)  # Devices in group
\`\`\``,
      nested: `
## Nested Property Queries
\`\`\`
$filter=(c8y_Hardware.model eq 'ABC')              # By hardware model
$filter=(c8y_Position.lng gt 10.5d)                # GPS longitude
$filter=(c8y_Firmware.version eq '2.0')            # Firmware version
$filter=(customFragment.nestedField eq 'value')   # Custom properties
\`\`\`
Note: Decimals need 'd' suffix (10.5d), strings need quotes.`,
    }

    const selectedExample = input.queryType
      ? examples[input.queryType]
      : Object.values(examples).join('\n')

    return prompt.message(
      `# Cumulocity Inventory Query Syntax (OData)

⚠️ IMPORTANT: This query language ONLY works for inventory/managed objects.
Measurements, events, and alarms use different HTTP query parameters.

${selectedExample}

## Common Fragments
- \`c8y_IsDevice\` - Device marker
- \`c8y_IsDeviceGroup\` - Group marker
- \`c8y_IsAsset\` - Asset marker
- \`c8y_Connection\` - Connection status
- \`c8y_Availability\` - Availability status
- \`c8y_Hardware\` - Hardware info

## Query ANY Property
Managed objects can have ANY custom properties. You can query:
- Standard properties: name, type, owner
- Nested properties: c8y_Hardware.model, c8y_Position.lng
- Custom fragments: myCustomFragment.myField

## Usage
Pass the query string to \`query-inventory\` tool.
For measurements/events/alarms, use their specific filter parameters instead.`,
    )
  })
}

/**
 * Explain device hierarchy navigation
 */
export function createDeviceHierarchyPrompt() {
  return definePrompt({
    name: 'device-hierarchy',
    description: 'Understand and navigate device/group hierarchy.',
  }, () => {
    return prompt.message(
      `# Cumulocity Device Hierarchy

## Structure
\`\`\`
Tenant
├── Device Group (c8y_IsDeviceGroup)
│   ├── Sub-Group
│   │   └── Device (c8y_IsDevice)
│   └── Device
├── Device Group
│   └── Asset (c8y_IsAsset)
│       └── Child Device
└── Root Device
\`\`\`

## Navigation Tools

1. **search-groups** - Find groups by name
2. **list-children** - Get children of a group/device
3. **get-object** - Get full details of any object

## Workflow Example

1. Search for a group: \`search-groups\` with name "*Building*"
2. Get group children: \`list-children\` with the group ID
3. Get device details: \`get-object\` with a device ID
4. Check capabilities: \`get-supported-series\` for measurements

## Key Concepts
- Groups organize devices logically
- Assets represent physical things (buildings, machines)
- Devices are data sources with measurements/events/alarms
- Child relationships form the hierarchy`,
    )
  })
}

/**
 * Interactive device lookup with completion
 */
export function createLookupDevicePrompt() {
  return definePrompt({
    name: 'lookup-device',
    description: 'Look up a device and see what data it provides.',
    schema: addTenantURLToSchema(v.object({
      deviceId: v.pipe(v.string(), v.minLength(1), v.description('Device ID to look up')),
    })),
  // Note: In future, could add completion for deviceId based on recent devices
  }, async (input) => {
    try {
      const client = await getAuthenticatedClient(input)

      // Get device details
      const device = (await client.inventory.detail(input.deviceId)).data
      const name = (device as Record<string, unknown>).name ?? 'Unknown'

      // Get supported series (returns string[] directly)
      const series = await client.inventory.getSupportedSeries(input.deviceId) ?? []

      // Check for recent alarms
      const alarms = await client.alarm.list({
        source: input.deviceId,
        resolved: false,
        pageSize: 5,
      })

      return prompt.message(
        `# Device: ${name} (${input.deviceId})

## Basic Info
- Type: ${(device as Record<string, unknown>).type ?? 'N/A'}
- Owner: ${device.owner}
- Is Device: ${'c8y_IsDevice' in device}

## Supported Measurements (${series.length})
${series.length > 0
  ? series.map((s) => `- ${s}`).join('\n')
  : 'No measurement series found'}

## Active Alarms (${alarms.data.length})
${alarms.data.length > 0
  ? alarms.data.map((a) => `- [${a.severity}] ${a.text}`).join('\n')
  : 'No active alarms'}

## Next Steps
- Use \`get-latest-measurements\` with deviceId: "${input.deviceId}"
- Use \`get-device-events\` for recent events
- Use \`get-device-alarms\` for alarm history`,
      )
    } catch (e) {
      return prompt.message(`Error looking up device: ${e instanceof Error ? e.message : String(e)}`)
    }
  })
}
