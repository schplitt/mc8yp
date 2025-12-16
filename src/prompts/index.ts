import {
  createAlarmsGuidePrompt,
  createAlarmStatusPrompt,
} from './alarms'
import {
  createCalculateDateRangePrompt,
  createDateTimeGuidePrompt,
} from './datetime'
import {
  createDeviceEventTypesPrompt,
  createEventsGuidePrompt,
} from './events'
import {
  createDeviceHierarchyPrompt,
  createFindDevicesPrompt,
  createInventoryQueryPrompt,
  createLookupDevicePrompt,
} from './inventory'
import {
  createAnalyzeMeasurementsPrompt,
  createGetMeasurementsPrompt,
  createMeasurementTimeRangePrompt,
} from './measurements'
import {
  createMetadataGuidePrompt,
} from './metadata'
import {
  createApplicationsGuidePrompt,
  createAuditQueryPrompt,
  createTenantContextPrompt,
} from './tenant'

// Create all prompts - called at server startup after execution context is set
export function createPrompts() {
  return [
    // Date/Time prompts
    createDateTimeGuidePrompt(),
    createCalculateDateRangePrompt(),

    // Inventory prompts
    createFindDevicesPrompt(),
    createInventoryQueryPrompt(),
    createDeviceHierarchyPrompt(),
    createLookupDevicePrompt(),

    // Measurement prompts
    createGetMeasurementsPrompt(),
    createAnalyzeMeasurementsPrompt(),
    createMeasurementTimeRangePrompt(),

    // Event prompts
    createEventsGuidePrompt(),
    createDeviceEventTypesPrompt(),

    // Alarm prompts
    createAlarmsGuidePrompt(),
    createAlarmStatusPrompt(),

    // Metadata prompts
    createMetadataGuidePrompt(),

    // Tenant prompts
    createTenantContextPrompt(),
    createAuditQueryPrompt(),
    createApplicationsGuidePrompt(),
  ]
}
