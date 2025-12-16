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
 * Get events - single tool with all filters
 */
export function createGetEventsTool() {
  return defineTool({
    name: 'get-events',
    description: 'Get events from device',
    schema: addTenantURLToSchema(v.object({
      deviceId: v.pipe(v.string(), v.description('Device ID (required)')),
      type: v.optional(v.pipe(v.string(), v.description('Event type filter'))),
      fragmentType: v.optional(v.pipe(v.string(), v.description('Fragment type filter'))),
      dateFrom: v.optional(v.pipe(v.string(), v.description('ISO date from'))),
      dateTo: v.optional(v.pipe(v.string(), v.description('ISO date to'))),
      withSourceAssets: v.optional(v.pipe(v.boolean(), v.description('Include parent assets'))),
      withSourceDevices: v.optional(v.pipe(v.boolean(), v.description('Include parent devices'))),
      pageSize: v.optional(v.number()),
      page: v.optional(v.number()),
    })),
  }, async (input) => {
    try {
      const client = await getAuthenticatedClient(input)
      const res = await client.event.list({
        source: input.deviceId,
        type: input.type,
        fragmentType: input.fragmentType,
        dateFrom: input.dateFrom,
        dateTo: input.dateTo,
        withSourceAssets: input.withSourceAssets,
        withSourceDevices: input.withSourceDevices,
        pageSize: input.pageSize ?? 50,
        currentPage: input.page ?? 1,
        withTotalPages: true,
      })
      return tool.text(createPaginatedResponse(res, `Events for ${input.deviceId}`))
    } catch (error) {
      return tool.error(createErrorResponse(error, `getting events for ${input.deviceId}`))
    }
  })
}

/**
 * Discover event types for a device
 */
export function createGetEventTypesTool() {
  return defineTool({
    name: 'get-event-types',
    description: 'Discover event types for device',
    schema: addTenantURLToSchema(v.object({
      deviceId: v.pipe(v.string(), v.description('Device ID')),
    })),
  }, async (input) => {
    try {
      const client = await getAuthenticatedClient(input)
      // Get recent events and extract unique types
      const res = await client.event.list({
        source: input.deviceId,
        pageSize: 100,
      })

      const types = [...new Set(res.data.map((e) => e.type).filter(Boolean))]
      return tool.text(createObjectResponse({
        deviceId: input.deviceId,
        eventTypes: types,
        sampleCount: res.data.length,
      }, `Event types for ${input.deviceId}`))
    } catch (error) {
      return tool.error(createErrorResponse(error, `getting event types for ${input.deviceId}`))
    }
  })
}
