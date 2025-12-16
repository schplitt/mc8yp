import type { IAuditRecord, IResultList } from '@c8y/client'
import { defineTool } from 'tmcp/tool'

import { tool } from 'tmcp/utils'

/**
 * Metadata Tools - Dashboards, Audit, Tenant, Users
 */
import * as v from 'valibot'
import {
  createErrorResponse,
  createObjectResponse,
  createPaginatedResponse,
} from '../utils/c8y-types'
import { getAuthenticatedClient } from '../utils/client'
import { addTenantURLToSchema } from '../utils/schema'

// ============================================================================
// DASHBOARD TOOLS
// ============================================================================

/**
 * Get dashboards for a device or group
 */
export function createGetDashboardsTool() {
  return defineTool({
    name: 'get-dashboards',
    description: 'Get dashboards for device or group',
    schema: addTenantURLToSchema(v.object({
      deviceId: v.pipe(v.string(), v.description('Device or group ID')),
    })),
  }, async (input) => {
    try {
      const client = await getAuthenticatedClient(input)
      const res = await client.inventory.childAdditionsList(input.deviceId, {
        query: '$filter=has(c8y_Dashboard)',
        pageSize: 50,
        withTotalPages: true,
      })
      return tool.text(createPaginatedResponse(res, `Dashboards for ${input.deviceId}`))
    } catch (error) {
      return tool.error(createErrorResponse(error, `getting dashboards for ${input.deviceId}`))
    }
  })
}

// ============================================================================
// AUDIT TOOLS
// ============================================================================

/**
 * Get audit logs with optional filters
 */
export function createGetAuditTool() {
  return defineTool({
    name: 'get-audit',
    description: 'Get audit logs with filters',
    schema: addTenantURLToSchema(v.object({
      dateFrom: v.pipe(v.string(), v.description('ISO date from (required)')),
      dateTo: v.pipe(v.string(), v.description('ISO date to (required)')),
      user: v.optional(v.pipe(v.string(), v.description('Filter by username'))),
      type: v.optional(v.pipe(v.string(), v.description('Audit type (e.g. Operation, Alarm, User)'))),
      application: v.optional(v.pipe(v.string(), v.description('Application name (e.g. cockpit)'))),
      source: v.optional(v.pipe(v.string(), v.description('Source device/object ID'))),
      pageSize: v.optional(v.pipe(v.number(), v.integer()), 50),
      page: v.optional(v.pipe(v.number(), v.integer()), 1),
    })),
  }, async (input) => {
    try {
      const client = await getAuthenticatedClient(input)

      const params = new URLSearchParams()
      params.append('dateFrom', input.dateFrom)
      params.append('dateTo', input.dateTo)
      params.append('pageSize', input.pageSize!.toString())
      params.append('revert', 'true')
      if (input.type)
        params.append('type', input.type)
      // Always include user parameter, even if empty (some APIs are sensitive to this)
      params.append('user', input.user || '')
      params.append('withTotalPages', 'true')
      if (input.application)
        params.append('application', input.application)
      if (input.source)
        params.append('source', input.source)
      if (input.page)
        params.append('currentPage', input.page!.toString())

      const url = `/audit/auditRecords?${params.toString()}`
      const res = await client.core.fetch(url)
      const rawData = await res.json()

      // Transform response to match expected format (auditRecords -> data, statistics -> paging)
      const data = {
        data: rawData.auditRecords || [],
        paging: rawData.statistics
          ? {
              currentPage: rawData.statistics.currentPage,
              pageSize: rawData.statistics.pageSize,
              totalPages: rawData.statistics.totalPages,
            }
          : undefined,
      } as IResultList<IAuditRecord>

      return tool.text(createPaginatedResponse(data, 'Audit records'))
    } catch (error) {
      return tool.error(createErrorResponse(error, 'getting audit logs'))
    }
  })
}

// ============================================================================
// TENANT TOOLS
// ============================================================================

/**
 * Get current tenant info
 */
export function createGetCurrentTenantTool() {
  return defineTool({
    name: 'get-current-tenant',
    description: 'Get current tenant info',
    schema: addTenantURLToSchema(v.object({
      withParent: v.optional(v.pipe(v.boolean(), v.description('Include parent tenant'))),
    })),
  }, async (input) => {
    try {
      const client = await getAuthenticatedClient(input)
      const res = await client.tenant.current({
        withParent: input.withParent,
      })
      delete res.data.applications
      if ('ownedApplications' in res.data)
        delete res.data.ownedApplications
      return tool.text(createObjectResponse(res.data, 'Current tenant'))
    } catch (error) {
      return tool.error(createErrorResponse(error, 'getting current tenant'))
    }
  })
}

/**
 * Get tenant usage statistics
 */
export function createGetTenantStatsTool() {
  return defineTool({
    name: 'get-tenant-stats',
    description: 'Get tenant usage statistics',
    schema: addTenantURLToSchema(v.object({
      dateFrom: v.optional(v.pipe(v.string(), v.description('ISO date from'))),
      dateTo: v.optional(v.pipe(v.string(), v.description('ISO date to'))),
      pageSize: v.optional(v.number()),
    })),
  }, async (input) => {
    try {
      const client = await getAuthenticatedClient(input)
      // Use fetch for statistics endpoint not in client
      const url = `/tenant/statistics?pageSize=${input.pageSize ?? 50}&withTotalPages=true${
        input.dateFrom ? `&dateFrom=${input.dateFrom}` : ''
      }${input.dateTo ? `&dateTo=${input.dateTo}` : ''}`
      const res = await client.core.fetch(url)
      const data = await res.json()
      return tool.text(createObjectResponse(data, 'Tenant statistics'))
    } catch (error) {
      return tool.error(createErrorResponse(error, 'getting tenant statistics'))
    }
  })
}

/**
 * Get tenant usage summary
 */
export function createGetTenantSummaryTool() {
  return defineTool({
    name: 'get-tenant-summary',
    description: 'Get tenant usage summary',
    schema: addTenantURLToSchema(v.object({
      dateFrom: v.optional(v.pipe(v.string(), v.description('ISO date from'))),
      dateTo: v.optional(v.pipe(v.string(), v.description('ISO date to'))),
    })),
  }, async (input) => {
    try {
      const client = await getAuthenticatedClient(input)
      const url = `/tenant/statistics/summary${
        input.dateFrom ? `?dateFrom=${input.dateFrom}` : ''
      }${input.dateTo ? `${input.dateFrom ? '&' : '?'}dateTo=${input.dateTo}` : ''}`
      const res = await client.core.fetch(url)
      const data = await res.json()
      return tool.text(createObjectResponse(data, 'Tenant summary'))
    } catch (error) {
      return tool.error(createErrorResponse(error, 'getting tenant summary'))
    }
  })
}

// ============================================================================
// USER TOOLS
// ============================================================================

/**
 * Get current user info
 */
export function createGetCurrentUserTool() {
  return defineTool({
    name: 'get-current-user',
    description: 'Get current user info',
    schema: addTenantURLToSchema(v.object({})),
  }, async (input) => {
    try {
      const client = await getAuthenticatedClient(input)
      const res = await client.user.current()
      return tool.text(createObjectResponse(res.data, 'Current user'))
    } catch (error) {
      return tool.error(createErrorResponse(error, 'getting current user'))
    }
  })
}

/**
 * Get users for tenant
 */
export function createGetUsersTool() {
  return defineTool({
    name: 'get-users',
    description: 'Get users for tenant',
    schema: addTenantURLToSchema(v.object({
      username: v.optional(v.pipe(v.string(), v.description('Filter by username prefix'))),
      groups: v.optional(v.pipe(v.string(), v.description('Filter by group IDs (comma-separated)'))),
      onlyDevices: v.optional(v.pipe(v.boolean(), v.description('Only device users'))),
      pageSize: v.optional(v.number()),
      page: v.optional(v.number()),
    })),
  }, async (input) => {
    try {
      const client = await getAuthenticatedClient(input)
      // Get current tenant to get tenantId
      const res = await client.user.list({
        username: input.username,
        groups: input.groups,
        onlyDevices: input.onlyDevices,
        pageSize: input.pageSize ?? 50,
        currentPage: input.page ?? 1,
        withTotalPages: true,
      })
      return tool.text(createPaginatedResponse(res, `Users for current tenant`))
    } catch (error) {
      return tool.error(createErrorResponse(error, 'getting users'))
    }
  })
}

// ============================================================================
// APPLICATION TOOLS
// ============================================================================

/**
 * Get all applications on the tenant
 * Covers: extensions, plugins, packages, widgets (via extensions), microservices
 */
export function createGetApplicationsTool() {
  return defineTool({
    name: 'get-applications',
    description: 'Get all applications on tenant',
    schema: addTenantURLToSchema(v.object({
      type: v.optional(v.pipe(v.picklist(['EXTERNAL', 'HOSTED', 'MICROSERVICE']), v.description('HOSTED=extensions/plugins, MICROSERVICE=backend services'))),
      availability: v.optional(v.pipe(v.picklist(['MARKET', 'PRIVATE', 'SHARED']), v.description('MARKET=official, PRIVATE=custom uploaded, SHARED=shared'))),
      page: v.optional(v.pipe(v.number(), v.integer())),
    })),
  }, async (input) => {
    try {
      const client = await getAuthenticatedClient(input)

      const params = new URLSearchParams()
      if (input.availability)
        params.append('availability', input.availability)
      if (input.type)
        params.append('type', input.type)
      params.append('pageSize', '2000')
      if (input.page)
        params.append('currentPage', input.page.toString())

      const url = `/application/applications?${params.toString()}`
      const res = await client.core.fetch(url)
      const data = await res.json()
      return tool.text(createObjectResponse(data, 'Applications'))
    } catch (error) {
      return tool.error(createErrorResponse(error, 'getting applications'))
    }
  })
}

/**
 * Get a specific application by ID
 */
export function createGetApplicationTool() {
  return defineTool({
    name: 'get-application',
    description: 'Get a specific application by ID',
    schema: addTenantURLToSchema(v.object({
      id: v.pipe(v.string(), v.description('Application ID')),
    })),
  }, async (input) => {
    try {
      const client = await getAuthenticatedClient(input)
      const url = `/application/applications/${input.id}`
      const res = await client.core.fetch(url)
      const data = await res.json()
      return tool.text(createObjectResponse(data, `Application ${input.id}`))
    } catch (error) {
      return tool.error(createErrorResponse(error, `getting application ${input.id}`))
    }
  })
}

/**
 * Get all versions of an application
 */
export function createGetApplicationVersionsTool() {
  return defineTool({
    name: 'get-application-versions',
    description: 'Get all versions of application',
    schema: addTenantURLToSchema(v.object({
      id: v.pipe(v.string(), v.description('Application ID')),
    })),
  }, async (input) => {
    try {
      const client = await getAuthenticatedClient(input)
      const url = `/application/applications/${input.id}/versions`
      const res = await client.core.fetch(url)
      const data = await res.json()
      return tool.text(createObjectResponse(data, `Versions for application ${input.id}`))
    } catch (error) {
      return tool.error(createErrorResponse(error, `getting versions for application ${input.id}`))
    }
  })
}
