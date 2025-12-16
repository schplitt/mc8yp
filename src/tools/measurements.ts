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
 * Get measurements - single tool with all filters
 */
export function createGetMeasurementsTool() {
  return defineTool({
    name: 'get-measurements',
    description: 'Get measurements from device',
    schema: addTenantURLToSchema(v.object({
      deviceId: v.pipe(v.string(), v.description('Device ID (required)')),
      type: v.optional(v.pipe(v.string(), v.description('Measurement type filter'))),
      valueFragmentType: v.optional(v.pipe(v.string(), v.description('Fragment type (e.g. c8y_Temperature)'))),
      valueFragmentSeries: v.optional(v.pipe(v.string(), v.description('Series (e.g. T)'))),
      dateFrom: v.optional(v.pipe(v.string(), v.description('ISO date from'))),
      dateTo: v.optional(v.pipe(v.string(), v.description('ISO date to'))),
      revert: v.optional(v.pipe(v.boolean(), v.description('Oldest first if true'))),
      pageSize: v.optional(v.number()),
      page: v.optional(v.number()),
    })),
  }, async (input) => {
    try {
      const client = await getAuthenticatedClient(input)
      const res = await client.measurement.list({
        source: input.deviceId,
        type: input.type,
        valueFragmentType: input.valueFragmentType,
        valueFragmentSeries: input.valueFragmentSeries,
        dateFrom: input.dateFrom,
        dateTo: input.dateTo,
        revert: input.revert,
        pageSize: input.pageSize ?? 50,
        currentPage: input.page ?? 1,
        withTotalPages: true,
      })
      return tool.text(createPaginatedResponse(res, `Measurements for ${input.deviceId}`))
    } catch (error) {
      return tool.error(createErrorResponse(error, `getting measurements for ${input.deviceId}`))
    }
  })
}

/**
 * Get measurement statistics
 */
export function createGetMeasurementStatsTool() {
  return defineTool({
    name: 'get-measurement-stats',
    description: 'Get min/max/avg statistics',
    schema: addTenantURLToSchema(v.object({
      deviceId: v.pipe(v.string(), v.description('Device ID')),
      fragment: v.pipe(v.string(), v.description('Fragment (e.g. c8y_Temperature)')),
      series: v.pipe(v.string(), v.description('Series (e.g. T)')),
      dateFrom: v.pipe(v.string(), v.description('ISO date from')),
      dateTo: v.pipe(v.string(), v.description('ISO date to')),
    })),
  }, async (input) => {
    try {
      const client = await getAuthenticatedClient(input)
      // Get measurements in range and compute stats
      const res = await client.measurement.list({
        source: input.deviceId,
        valueFragmentType: input.fragment,
        valueFragmentSeries: input.series,
        dateFrom: input.dateFrom,
        dateTo: input.dateTo,
        pageSize: 2000,
      })

      const values = res.data
        .map((m) => {
          const frag = m[input.fragment] as Record<string, { value?: number }> | undefined
          return frag?.[input.series]?.value
        })
        .filter((v): v is number => typeof v === 'number')

      if (values.length === 0) {
        return tool.text(createObjectResponse({ message: 'No measurements found in range' }, 'Stats'))
      }

      const stats = {
        count: values.length,
        min: Math.min(...values),
        max: Math.max(...values),
        avg: values.reduce((a, b) => a + b, 0) / values.length,
        fragment: input.fragment,
        series: input.series,
        dateFrom: input.dateFrom,
        dateTo: input.dateTo,
      }
      return tool.text(createObjectResponse(stats, `Stats for ${input.fragment}.${input.series}`))
    } catch (error) {
      return tool.error(createErrorResponse(error, 'getting measurement stats'))
    }
  })
}
