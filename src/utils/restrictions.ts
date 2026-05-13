import { OPENAPI_PARTS } from './openapi'

export const HTTP_METHODS = ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT', 'TRACE'] as const
export const RESTRICTION_QUERY_KEYS = ['restriction', 'restrict', 'r'] as const
export const ALLOW_QUERY_KEYS = ['allowed', 'allow', 'a'] as const
export const OPENAPI_DISABLED_QUERY_KEY = 'openapi-disabled' as const
export const RESTRICTION_HEADER = 'mc8yp-restriction'
export const ALLOW_HEADER = 'mc8yp-allow'
export const OPENAPI_DISABLED_HEADER = 'mc8yp-openapi-disabled'

export type HttpMethod = (typeof HTTP_METHODS)[number]
export type RestrictionMethod = HttpMethod | '*'

const HTTP_METHOD_SET: ReadonlySet<string> = new Set(HTTP_METHODS)
const SEGMENT_PATTERN = /^[A-Za-z0-9._~*-]+$/
const OPENAPI_PART_SET: ReadonlySet<string> = new Set(OPENAPI_PARTS)

function collectRuleSources(values: readonly unknown[]): string[] {
  return values.flatMap((value) => Array.isArray(value) ? value : [value]).filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  )
}

function collectHeaderRuleSources(value: string | null): string[] {
  if (!value) {
    return []
  }

  return value.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0)
}

export function collectServerRestrictionSources(query: Record<string, unknown>, headers: Headers): string[] {
  return [
    ...collectRuleSources(RESTRICTION_QUERY_KEYS.map((key) => query[key])),
    ...collectHeaderRuleSources(headers.get(RESTRICTION_HEADER)),
  ]
}

export function collectServerAllowSources(query: Record<string, unknown>, headers: Headers): string[] {
  return [
    ...collectRuleSources(ALLOW_QUERY_KEYS.map((key) => query[key])),
    ...collectHeaderRuleSources(headers.get(ALLOW_HEADER)),
  ]
}

export function collectServerDisabledOpenApiSources(query: Record<string, unknown>, headers: Headers): string[] {
  return [
    ...collectRuleSources([query[OPENAPI_DISABLED_QUERY_KEY]]),
    ...collectHeaderRuleSources(headers.get(OPENAPI_DISABLED_HEADER)),
  ]
}

interface BaseRule {
  method: RestrictionMethod
  pathPattern: string
  source: string
}

export interface RestrictionRule extends BaseRule {
  type: 'deny'
}

export interface AllowRule extends BaseRule {
  type: 'allow'
}

export interface InvalidRestrictionRule {
  rule: string
  reason: string
}

export type InvalidAllowRule = InvalidRestrictionRule

export interface RestrictionParseResult {
  parsedRules: RestrictionRule[]
  failedRules: InvalidRestrictionRule[]
}

export interface AllowParseResult {
  parsedRules: AllowRule[]
  failedRules: InvalidAllowRule[]
}

export interface OpenApiPartsParseResult {
  disabledApis: string[]
  failedValues: Array<{ value: string, reason: string }>
}

export function parseRestrictionRule(input: string | readonly string[]): RestrictionParseResult {
  const inputs = typeof input === 'string' ? [input] : input
  const parsedRules: RestrictionRule[] = []
  const failedRules: InvalidRestrictionRule[] = []

  for (const source of inputs) {
    if (!source) {
      failedRules.push({
        rule: source,
        reason: 'Restriction value must not be empty.',
      })
      continue
    }

    const sep = source.indexOf(':')
    if (sep > 0 && !source.startsWith('/')) {
      const rawMethod = source.slice(0, sep).toUpperCase()
      const rawPath = source.slice(sep + 1)

      if (!rawPath) {
        failedRules.push({
          rule: source,
          reason: 'Restriction path pattern must not be empty.',
        })
        continue
      }
      if (rawMethod && rawMethod !== '*' && !HTTP_METHOD_SET.has(rawMethod)) {
        failedRules.push({
          rule: source,
          reason: `Unsupported restriction method "${source.slice(0, sep)}".`,
        })
        continue
      }
      if (rawPath.includes('?') || rawPath.includes('#')) {
        failedRules.push({
          rule: source,
          reason: `Restriction pattern "${rawPath}" must not include query strings or fragments.`,
        })
        continue
      }
      if (!rawPath.startsWith('/')) {
        failedRules.push({
          rule: source,
          reason: 'Restriction path pattern must start with "/".',
        })
        continue
      }

      const rawPathSegments = rawPath === '/' ? [] : rawPath.slice(1).split('/')
      if (rawPathSegments.some((segment) => segment.length === 0)) {
        failedRules.push({
          rule: source,
          reason: 'Restriction path pattern must not contain empty segments.',
        })
        continue
      }

      const invalidRawPathSegment = rawPathSegments.find((segment) => {
        if (segment === '**') {
          return false
        }

        return segment.includes('**') || segment === '.' || segment === '..' || !SEGMENT_PATTERN.test(segment)
      })
      if (invalidRawPathSegment) {
        failedRules.push({
          rule: source,
          reason: invalidRawPathSegment === '.' || invalidRawPathSegment === '..'
            ? `Restriction segment "${invalidRawPathSegment}" is not allowed.`
            : invalidRawPathSegment.includes('**')
              ? `Invalid restriction segment "${invalidRawPathSegment}". "**" must be its own path segment.`
              : `Restriction segment "${invalidRawPathSegment}" contains unsupported characters.`,
        })
        continue
      }

      parsedRules.push({
        type: 'deny',
        method: (!rawMethod || rawMethod === '*') ? '*' : rawMethod as HttpMethod,
        pathPattern: rawPath,
        source,
      })
      continue
    }

    if (source.includes('?') || source.includes('#')) {
      failedRules.push({
        rule: source,
        reason: `Restriction pattern "${source}" must not include query strings or fragments.`,
      })
      continue
    }
    if (!source.startsWith('/')) {
      failedRules.push({
        rule: source,
        reason: 'Restriction path pattern must start with "/".',
      })
      continue
    }

    const sourceSegments = source === '/' ? [] : source.slice(1).split('/')
    if (sourceSegments.some((segment) => segment.length === 0)) {
      failedRules.push({
        rule: source,
        reason: 'Restriction path pattern must not contain empty segments.',
      })
      continue
    }

    const invalidSourceSegment = sourceSegments.find((segment) => {
      if (segment === '**') {
        return false
      }

      return segment.includes('**') || segment === '.' || segment === '..' || !SEGMENT_PATTERN.test(segment)
    })
    if (invalidSourceSegment) {
      failedRules.push({
        rule: source,
        reason: invalidSourceSegment === '.' || invalidSourceSegment === '..'
          ? `Restriction segment "${invalidSourceSegment}" is not allowed.`
          : invalidSourceSegment.includes('**')
            ? `Invalid restriction segment "${invalidSourceSegment}". "**" must be its own path segment.`
            : `Restriction segment "${invalidSourceSegment}" contains unsupported characters.`,
      })
      continue
    }

    parsedRules.push({
      type: 'deny',
      method: '*',
      pathPattern: source,
      source,
    })
  }

  return {
    parsedRules,
    failedRules,
  }
}

export function parseAllowRule(input: string | readonly string[]): AllowParseResult {
  const inputs = typeof input === 'string' ? [input] : input
  const parsedRules: AllowRule[] = []
  const failedRules: InvalidAllowRule[] = []

  for (const source of inputs) {
    if (!source) {
      failedRules.push({
        rule: source,
        reason: 'Allow value must not be empty.',
      })
      continue
    }

    const sep = source.indexOf(':')
    if (sep > 0 && !source.startsWith('/')) {
      const rawMethod = source.slice(0, sep).toUpperCase()
      const rawPath = source.slice(sep + 1)

      if (!rawPath) {
        failedRules.push({
          rule: source,
          reason: 'Allow path pattern must not be empty.',
        })
        continue
      }
      if (rawMethod && rawMethod !== '*' && !HTTP_METHOD_SET.has(rawMethod)) {
        failedRules.push({
          rule: source,
          reason: `Unsupported allow method "${source.slice(0, sep)}".`,
        })
        continue
      }
      if (rawPath.includes('?') || rawPath.includes('#')) {
        failedRules.push({
          rule: source,
          reason: `Allow pattern "${rawPath}" must not include query strings or fragments.`,
        })
        continue
      }
      if (!rawPath.startsWith('/')) {
        failedRules.push({
          rule: source,
          reason: 'Allow path pattern must start with "/".',
        })
        continue
      }

      const rawPathSegments = rawPath === '/' ? [] : rawPath.slice(1).split('/')
      if (rawPathSegments.some((segment) => segment.length === 0)) {
        failedRules.push({
          rule: source,
          reason: 'Allow path pattern must not contain empty segments.',
        })
        continue
      }

      const invalidRawPathSegment = rawPathSegments.find((segment) => {
        if (segment === '**') {
          return false
        }

        return segment.includes('**') || segment === '.' || segment === '..' || !SEGMENT_PATTERN.test(segment)
      })
      if (invalidRawPathSegment) {
        failedRules.push({
          rule: source,
          reason: invalidRawPathSegment === '.' || invalidRawPathSegment === '..'
            ? `Allow segment "${invalidRawPathSegment}" is not allowed.`
            : invalidRawPathSegment.includes('**')
              ? `Invalid allow segment "${invalidRawPathSegment}". "**" must be its own path segment.`
              : `Allow segment "${invalidRawPathSegment}" contains unsupported characters.`,
        })
        continue
      }

      parsedRules.push({
        type: 'allow',
        method: (!rawMethod || rawMethod === '*') ? '*' : rawMethod as HttpMethod,
        pathPattern: rawPath,
        source,
      })
      continue
    }

    if (source.includes('?') || source.includes('#')) {
      failedRules.push({
        rule: source,
        reason: `Allow pattern "${source}" must not include query strings or fragments.`,
      })
      continue
    }
    if (!source.startsWith('/')) {
      failedRules.push({
        rule: source,
        reason: 'Allow path pattern must start with "/".',
      })
      continue
    }

    const sourceSegments = source === '/' ? [] : source.slice(1).split('/')
    if (sourceSegments.some((segment) => segment.length === 0)) {
      failedRules.push({
        rule: source,
        reason: 'Allow path pattern must not contain empty segments.',
      })
      continue
    }

    const invalidSourceSegment = sourceSegments.find((segment) => {
      if (segment === '**') {
        return false
      }

      return segment.includes('**') || segment === '.' || segment === '..' || !SEGMENT_PATTERN.test(segment)
    })
    if (invalidSourceSegment) {
      failedRules.push({
        rule: source,
        reason: invalidSourceSegment === '.' || invalidSourceSegment === '..'
          ? `Allow segment "${invalidSourceSegment}" is not allowed.`
          : invalidSourceSegment.includes('**')
            ? `Invalid allow segment "${invalidSourceSegment}". "**" must be its own path segment.`
            : `Allow segment "${invalidSourceSegment}" contains unsupported characters.`,
      })
      continue
    }

    parsedRules.push({
      type: 'allow',
      method: '*',
      pathPattern: source,
      source,
    })
  }

  return {
    parsedRules,
    failedRules,
  }
}

export function parseDisabledOpenApiParts(input: string | readonly string[]): OpenApiPartsParseResult {
  const inputs = typeof input === 'string' ? [input] : input
  const disabledApis: string[] = []
  const failedValues: Array<{ value: string, reason: string }> = []

  for (const source of inputs) {
    if (!source) {
      failedValues.push({
        value: source,
        reason: 'OpenAPI value must not be empty.',
      })
      continue
    }

    const normalized = source.trim().toLowerCase()
    if (!OPENAPI_PART_SET.has(normalized)) {
      failedValues.push({
        value: source,
        reason: `Unsupported OpenAPI value "${source}". Available: ${OPENAPI_PARTS.join(', ')}.`,
      })
      continue
    }

    if (!disabledApis.includes(normalized)) {
      disabledApis.push(normalized)
    }
  }

  return {
    disabledApis,
    failedValues,
  }
}
