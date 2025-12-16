/**
 * Measurement Prompts - Help users query time-series data effectively
 */

import { definePrompt } from 'tmcp/prompt'
import { prompt } from 'tmcp/utils'
import * as v from 'valibot'
import { getAuthenticatedClient } from '../utils/client'
import { addTenantURLToSchema } from '../utils/schema'

/**
 * Guide for querying measurements
 */
export function createGetMeasurementsPrompt() {
  return definePrompt({
    name: 'measurements-guide',
    description: 'Learn how to query measurements effectively.',
  }, () => {
    return prompt.message(
      `# Querying Measurements in Cumulocity

## Important: Always Know Your Device First
Measurements can be in the millions. Never query without specifying a device.

## Workflow

1. **Find your device first:**
   Use \`query-inventory\` or \`get-object\` to identify the device ID.

2. **Discover what's measured:**
   Use \`get-supported-series\` to see what series the device reports.
   This returns series like: "c8y_Temperature.T", "c8y_Battery.level"

3. **Get recent data:**
   Use \`get-measurements(deviceId: "12345", pageSize: 10)\` for the most recent values.

4. **Query specific series:**
   Use \`get-measurements\` with valueFragmentType and valueFragmentSeries parameters.

5. **Time-range queries:**
   Use \`get-measurements\` with dateFrom/dateTo in ISO format.

## Series Format
Series names follow the pattern: \`{fragment}.{series}\`
- \`c8y_Temperature.T\` - Temperature value
- \`c8y_Battery.level\` - Battery percentage
- \`c8y_SignalStrength.rssi\` - Signal strength

## Tips
- Always specify a device ID
- Use supported series to know exact fragment/series names
- Limit results with pageSize (default 10)
- Use time ranges to narrow down data`,
    )
  })
}

/**
 * Help analyze a device's measurements
 */
export function createAnalyzeMeasurementsPrompt() {
  return definePrompt({
    name: 'analyze-measurements',
    description: 'Get analysis setup for a specific device\'s measurements.',
    schema: addTenantURLToSchema(v.object({
      deviceId: v.pipe(v.string(), v.minLength(1), v.description('Device ID to analyze')),
    })),
  }, async (input) => {
    try {
      const client = await getAuthenticatedClient(input)

      // Get device name
      const device = (await client.inventory.detail(input.deviceId)).data
      const name = (device as Record<string, unknown>).name ?? 'Unknown'

      // Get supported series (returns string[] directly)
      const series = await client.inventory.getSupportedSeries(input.deviceId) ?? []

      return prompt.message(
        `# Measurement Analysis: ${name}
Device ID: ${input.deviceId}

## Available Series (${series.length})
${series.length > 0
  ? series.map((s) => {
      const [fragment, seriesName] = s.split('.')
      return `- **${s}**
  - Fragment: \`${fragment}\`
  - Series: \`${seriesName}\`
  - Query: \`get-measurements\` with valueFragmentType="${fragment}", valueFragmentSeries="${seriesName}"`
    }).join('\n\n')
  : 'No series found. This device may not report measurements.'}

## Quick Commands

### Get latest values:
\`\`\`
get-measurements(deviceId: "${input.deviceId}", pageSize: 10)
\`\`\`

### Get statistics:
\`\`\`
get-measurement-stats(deviceId: "${input.deviceId}", fragment: "c8y_Temperature", series: "T", dateFrom: "2024-01-01", dateTo: "2024-01-31")
\`\`\`

## Time Ranges
- Last hour: dateFrom="${new Date(Date.now() - 3600000).toISOString()}"
- Last 24h: dateFrom="${new Date(Date.now() - 86400000).toISOString()}"
- Last 7d: dateFrom="${new Date(Date.now() - 604800000).toISOString()}"`,
      )
    } catch (e) {
      return prompt.message(`Error: ${e instanceof Error ? e.message : String(e)}`)
    }
  })
}

/**
 * Help with time range calculations
 */
export function createMeasurementTimeRangePrompt() {
  return definePrompt({
    name: 'measurement-time-range',
    description: 'Get help with time range parameters for queries.',
    schema: v.object({
      period: v.optional(v.picklist(['1h', '24h', '7d', '30d', 'custom'])),
    }),
  }, (input) => {
    const now = new Date()
    const periods = {
      '1h': { label: 'Last Hour', from: new Date(now.getTime() - 3600000) },
      '24h': { label: 'Last 24 Hours', from: new Date(now.getTime() - 86400000) },
      '7d': { label: 'Last 7 Days', from: new Date(now.getTime() - 604800000) },
      '30d': { label: 'Last 30 Days', from: new Date(now.getTime() - 2592000000) },
    }

    const selected = input.period && input.period !== 'custom' ? periods[input.period] : null

    return prompt.message(
      `# Time Range Query Builder

${selected
    ? `## Selected: ${selected.label}
\`\`\`
dateFrom: "${selected.from.toISOString()}"
dateTo: "${now.toISOString()}"
\`\`\``
    : `## Available Presets
${Object.entries(periods).map(([key, val]) =>
  `- **${key}**: ${val.label} (from ${val.from.toISOString()})`).join('\n')}`
}

## Custom Range Format
Use ISO 8601 format: \`YYYY-MM-DDTHH:mm:ss.sssZ\`

Examples:
- Specific date: "2024-01-15T00:00:00.000Z"
- Date and time: "2024-01-15T14:30:00.000Z"

## Query Example
\`\`\`
get-measurements(deviceId: "12345", dateFrom: "${(selected?.from ?? periods['24h'].from).toISOString()}", dateTo: "${now.toISOString()}")
\`\`\``,
    )
  })
}
