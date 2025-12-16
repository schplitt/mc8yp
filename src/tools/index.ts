import {
  createGetAlarmCountsTool,
  createGetAlarmsTool,
} from './alarms'
import {
  createGetEventsTool,
  createGetEventTypesTool,
} from './events'
import {
  createGetObjectTool,
  createGetSupportedSeriesTool,
  createListChildrenTool,
  createQueryInventoryTool,
} from './inventory'
import {
  createGetMeasurementStatsTool,
  createGetMeasurementsTool,
} from './measurements'
import {
  createGetApplicationsTool,
  createGetApplicationTool,
  createGetApplicationVersionsTool,
  createGetAuditTool,
  createGetCurrentTenantTool,
  createGetCurrentUserTool,
  createGetDashboardsTool,
  createGetTenantStatsTool,
  createGetTenantSummaryTool,
  createGetUsersTool,
} from './metadata'

// Create all tools - called at server startup after execution context is set
export function createTools() {
  return [
    // Inventory (4)
    createQueryInventoryTool(),
    createGetObjectTool(),
    createListChildrenTool(),
    createGetSupportedSeriesTool(),

    // Measurements (2)
    createGetMeasurementsTool(),
    createGetMeasurementStatsTool(),

    // Events (2)
    createGetEventsTool(),
    createGetEventTypesTool(),

    // Alarms (2)
    createGetAlarmsTool(),
    createGetAlarmCountsTool(),

    // Metadata (11)
    createGetDashboardsTool(),
    createGetAuditTool(),
    createGetCurrentTenantTool(),
    createGetTenantStatsTool(),
    createGetTenantSummaryTool(),
    createGetCurrentUserTool(),
    createGetUsersTool(),
    createGetApplicationTool(),
    createGetApplicationsTool(),
    createGetApplicationVersionsTool(),
  ]
}
