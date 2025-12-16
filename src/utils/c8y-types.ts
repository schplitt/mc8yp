/**
 * Cumulocity types and TOON-formatted response helpers
 */
import type { IResultList } from '@c8y/client'
import { encode } from '@toon-format/toon'

export type SeverityType = 'CRITICAL' | 'MAJOR' | 'MINOR' | 'WARNING'
export type AlarmStatusType = 'ACTIVE' | 'ACKNOWLEDGED' | 'CLEARED'

export interface PagingInfo {
  currentPage: number
  pageSize: number
  totalPages?: number
  totalRecords?: number
  hasMore: boolean
}

export interface SupportedSeries {
  fragment: string
  series: string[]
}

/**
 * Format paging stats as compact string
 * @param paging - The paging information to format
 * @returns Formatted paging statistics string
 */
export function formatPagingStats(paging: PagingInfo): string {
  const total = paging.totalRecords ? ` of ${paging.totalRecords}` : ''
  const more = paging.hasMore ? ' (more available)' : ''
  return `Page ${paging.currentPage}/${paging.totalPages ?? '?'}${total}${more}`
}

/**
 * Create TOON-encoded paginated response - much more compact than JSON
 * @param result - The result list from Cumulocity API
 * @param entityName - Name of the entity type for the header
 * @param hint - Optional hint text to display
 * @returns TOON-encoded string with paging information
 */
export function createPaginatedResponse<T>(
  result: IResultList<T>,
  entityName: string,
  hint?: string,
): string {
  const paging: PagingInfo = {
    currentPage: result.paging?.currentPage ?? 1,
    pageSize: result.paging?.pageSize ?? 20,
    totalPages: result.paging?.totalPages,
    totalRecords: result.paging?.totalPages
      ? result.paging.totalPages * (result.paging?.pageSize ?? 20)
      : undefined,
    hasMore: (result.paging?.currentPage ?? 1) < (result.paging?.totalPages ?? 1),
  }

  const lines: string[] = []
  lines.push(`# ${entityName}: ${formatPagingStats(paging)}`)
  if (hint)
    lines.push(`# ${hint}`)
  lines.push('')
  lines.push(encode(result.data))

  return lines.join('\n')
}

/**
 * Create simple TOON response for single object
 * @param obj - The object to encode
 * @param entityName - Name of the entity type for the header
 * @returns TOON-encoded string
 */
export function createObjectResponse<T>(obj: T, entityName: string): string {
  return `# ${entityName}\n${encode(obj)}`
}

/**
 * Create error response with proper error details
 * @param error - The error object or message
 * @param context - Context description of where the error occurred
 * @returns Formatted error message string
 */
export function createErrorResponse(error: unknown, context: string): string {
  let msg = 'Unknown error'

  if (error instanceof Error) {
    msg = error.message
    // Check if there's additional response data (HTTP errors)
    const anyError = error as any
    if (anyError.response) {
      const status = anyError.response.status || anyError.status
      const statusText = anyError.response.statusText || anyError.statusText
      msg = `${status ? `HTTP ${status}` : 'Error'}${statusText ? ` ${statusText}` : ''}: ${msg}`
    }
  } else if (typeof error === 'string') {
    msg = error
  } else if (error && typeof error === 'object') {
    // Try to extract useful info from error object
    const errorObj = error as any
    if (errorObj.message) {
      msg = errorObj.message
    } else if (errorObj.error) {
      msg = typeof errorObj.error === 'string' ? errorObj.error : JSON.stringify(errorObj.error)
    } else {
      try {
        msg = JSON.stringify(error, null, 2)
      } catch {
        msg = String(error)
      }
    }
  }

  return `Error ${context}: ${msg}`
}

/**
 * Parse supported series from device
 * @param supportedSeries - Array of supported series strings in format "fragment.series"
 * @returns Array of objects with fragment and series properties
 */
export function parseSupportedSeries(
  supportedSeries: string[] | undefined,
): { fragment: string, series: string }[] {
  if (!supportedSeries)
    return []
  return supportedSeries.map((s) => {
    const [fragment, series] = s.split('.') as [string, string]
    return { fragment, series }
  })
}
