import { defineTool } from 'tmcp/tool'
import { tool } from 'tmcp/utils'
import * as v from 'valibot'
import {
  createErrorResponse,
  createObjectResponse,
  createPaginatedResponse,
} from '../utils/c8y-types'
import { getAuthenticatedClient } from '../utils/client'

import { addTenantURLToSchema } from '../utils/schema'

/**
 * Get alarms - single tool with all filters
 */
export function createGetAlarmsTool() {
  return defineTool({
    name: 'get-alarms',
    description: 'Get alarms with optional filters',
    schema: addTenantURLToSchema(v.object({
      deviceId: v.optional(v.pipe(v.string(), v.description('Device ID filter'))),
      status: v.optional(v.pipe(
        (v.picklist(['ACTIVE', 'ACKNOWLEDGED', 'CLEARED'])),
        v.description('Status filter (default: ACTIVE)'),
      ), 'ACTIVE'),
      severity: v.optional(v.pipe(
        (v.picklist(['CRITICAL', 'MAJOR', 'MINOR', 'WARNING'])),
        v.description('Severity filter'),
      )),
      type: v.optional(v.pipe(v.string(), v.description('Alarm type filter'))),
      dateFrom: v.optional(v.pipe(v.string(), v.description('ISO date from'))),
      dateTo: v.optional(v.pipe(v.string(), v.description('ISO date to'))),
      resolved: v.optional(v.pipe(v.boolean(), v.description('Filter by resolved state'))),
      withSourceAssets: v.optional(v.pipe(v.boolean(), v.description('Include parent assets'))),
      withSourceDevices: v.optional(v.pipe(v.boolean(), v.description('Include parent devices'))),
      pageSize: v.optional(v.number()),
      page: v.optional(v.number()),
    })),
  }, async (input) => {
    try {
      const client = await getAuthenticatedClient(input)
      const res = await client.alarm.list({
        source: input.deviceId,
        status: input.status,
        severity: input.severity,
        type: input.type,
        dateFrom: input.dateFrom,
        dateTo: input.dateTo,
        resolved: input.resolved,
        withSourceAssets: input.withSourceAssets,
        withSourceDevices: input.withSourceDevices,
        pageSize: input.pageSize ?? 50,
        currentPage: input.page ?? 1,
        withTotalPages: true,
      })
      const context = input.deviceId ? `device ${input.deviceId}` : 'tenant'
      return tool.text(createPaginatedResponse(res, `Alarms for ${context}`))
    } catch (error) {
      return tool.error(createErrorResponse(error, 'getting alarms'))
    }
  })
}

/**
 * Get alarm counts by severity from managed object's c8y_ActiveAlarmsStatus fragment
 */
export function createGetAlarmCountsTool() {
  return defineTool({
    name: 'get-alarm-counts',
    description: 'Count active alarms by severity from managed object inventory',
    schema: addTenantURLToSchema(v.object({
      deviceId: v.pipe(v.string(), v.description('Managed object ID (device, asset, or group)')),
    })),
  }, async (input) => {
    try {
      const client = await getAuthenticatedClient(input)

      // Get alarm counts from managed object's c8y_ActiveAlarmsStatus fragment
      const res = await client.inventory.detail(input.deviceId)
      const alarmStatus = res.data.c8y_ActiveAlarmsStatus as Record<string, number> | undefined

      if (alarmStatus) {
        const total = (alarmStatus.critical ?? 0)
          + (alarmStatus.major ?? 0)
          + (alarmStatus.minor ?? 0)
          + (alarmStatus.warning ?? 0)

        return tool.text(createObjectResponse({
          CRITICAL: alarmStatus.critical ?? 0,
          MAJOR: alarmStatus.major ?? 0,
          MINOR: alarmStatus.minor ?? 0,
          WARNING: alarmStatus.warning ?? 0,
          total,
          deviceId: input.deviceId,
        }, 'Alarm counts'))
      } else {
        return tool.text(createObjectResponse({
          CRITICAL: 0,
          MAJOR: 0,
          MINOR: 0,
          WARNING: 0,
          total: 0,
          deviceId: input.deviceId,
          note: 'No c8y_ActiveAlarmsStatus fragment found on this managed object',
        }, 'Alarm counts'))
      }
    } catch (error) {
      return tool.error(createErrorResponse(error, 'getting alarm counts'))
    }
  })
}
