import { defineTool } from 'tmcp/tool'
import { tool } from 'tmcp/utils'
import * as v from 'valibot'
import {
  createErrorResponse,
  createObjectResponse,
  createPaginatedResponse,
  parseSupportedSeries,
} from '../utils/c8y-types'
import { getAuthenticatedClient } from '../utils/client'
import { addTenantURLToSchema } from '../utils/schema'

/**
 * Main inventory query tool - replaces search-devices, search-groups, search-assets, query-inventory
 * Agent learns OData syntax from prompts
 */
export function createQueryInventoryTool() {
  return defineTool({
    name: 'query-inventory',
    description: 'Query devices, groups, assets with OData filter',
    schema: addTenantURLToSchema(v.object({
      query: v.pipe(v.string(), v.description('OData query (use inventory-query prompt for syntax)')),
      pageSize: v.optional(v.pipe(v.number(), v.description('Results per page (default 50, max 2000)'))),
      page: v.optional(v.pipe(v.number(), v.description('Page number (avoid pagination if possible)'))),
    })),
  }, async (input) => {
    try {
      const client = await getAuthenticatedClient(input)
      const res = await client.inventory.list({
        query: input.query,
        pageSize: input.pageSize ?? 50,
        currentPage: input.page ?? 1,
        withTotalPages: true,
      })
      return tool.text(createPaginatedResponse(res, 'Inventory', 'Refine query if too many results'))
    } catch (error) {
      return tool.error(createErrorResponse(error, 'querying inventory'))
    }
  })
}

/**
 * Get single object by ID
 */
export function createGetObjectTool() {
  return defineTool({
    name: 'get-object',
    description: 'Get device/group/asset or other by ID',
    schema: addTenantURLToSchema(v.object({
      id: v.pipe(v.string(), v.description('Managed object ID')),
    })),
  }, async (input) => {
    try {
      const client = await getAuthenticatedClient(input)
      const res = await client.inventory.detail(input.id)
      return tool.text(createObjectResponse(res.data, `Object ${input.id}`))
    } catch (error) {
      return tool.error(createErrorResponse(error, `getting object ${input.id}`))
    }
  })
}

/**
 * List children of a group or device
 */
export function createListChildrenTool() {
  return defineTool({
    name: 'list-children',
    description: 'List children of group or device',
    schema: addTenantURLToSchema(v.object({
      id: v.pipe(v.string(), v.description('Parent object ID')),
      type: v.optional(v.pipe(v.picklist(['asset', 'device', 'addition']), v.description('Child type filter'))),
      pageSize: v.optional(v.number()),
    })),
  }, async (input) => {
    try {
      const client = await getAuthenticatedClient(input)
      const childType = input.type ?? 'asset'
      const res = await client.inventory.childAssetsList(input.id, {
        pageSize: input.pageSize ?? 50,
        withTotalPages: true,
        ...(childType === 'device' && { query: '$filter=has(c8y_IsDevice)' }),
      })
      return tool.text(createPaginatedResponse(res, `Children of ${input.id}`))
    } catch (error) {
      return tool.error(createErrorResponse(error, `listing children of ${input.id}`))
    }
  })
}

/**
 * Get supported measurement series for a device
 */
export function createGetSupportedSeriesTool() {
  return defineTool({
    name: 'get-supported-series',
    description: 'Get measurement types device supports',
    schema: addTenantURLToSchema(v.object({
      deviceId: v.pipe(v.string(), v.description('Device ID')),
    })),
  }, async (input) => {
    try {
      const client = await getAuthenticatedClient(input)
      const res = await client.inventory.detail(input.deviceId)
      const device = res.data
      const series = parseSupportedSeries(device.c8y_SupportedSeries)
      return tool.text(createObjectResponse({
        deviceId: input.deviceId,
        deviceName: device.name,
        supportedSeries: series,
        raw: device.c8y_SupportedSeries,
      }, `Supported series for ${device.name ?? input.deviceId}`))
    } catch (error) {
      return tool.error(createErrorResponse(error, `getting supported series for ${input.deviceId}`))
    }
  })
}
