import { matchesGlob } from 'node:path'

export const HTTP_METHODS = ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT', 'TRACE'] as const

export type HttpMethod = (typeof HTTP_METHODS)[number]
export type RestrictionMethod = HttpMethod | '*'

const HTTP_METHOD_SET: ReadonlySet<string> = new Set(HTTP_METHODS)

export interface RestrictionRule {
  method: RestrictionMethod
  pathPattern: string
  source: string
}

export function normalizeRestrictionMatchPath(value: string): string {
  let raw = value.trim()
  if (!raw) {
    return '/'
  }
  raw = raw.startsWith('/') ? raw : `/${raw}`
  raw = raw.replace(/\/{2,}/g, '/')
  return raw.length > 1 && raw.endsWith('/') ? raw.slice(0, -1) : raw || '/'
}

export function normalizeAndValidateRestrictionPath(rawPath: string): string {
  const segmentPattern = /^[A-Za-z0-9._~*-]+$/

  if (rawPath.includes('?') || rawPath.includes('#')) {
    throw new Error(`Restriction pattern "${rawPath}" must not include query strings or fragments.`)
  }
  if (!rawPath.startsWith('/')) {
    throw new Error('Restriction path pattern must start with "/".')
  }

  const pathPattern = normalizeRestrictionMatchPath(rawPath)
  const segments = pathPattern === '/' ? [] : pathPattern.slice(1).split('/')

  for (const segment of segments) {
    if (segment === '.' || segment === '..') {
      throw new Error(`Restriction segment "${segment}" is not allowed.`)
    }
    if (segment === '**') {
      continue
    }
    if (!segmentPattern.test(segment)) {
      throw new Error(`Restriction segment "${segment}" contains unsupported characters.`)
    }
  }

  return pathPattern
}

export function parseRestrictionRule(input: string): RestrictionRule {
  const source = input.trim()
  if (!source) {
    throw new Error('Restriction value must not be empty.')
  }

  const sep = source.indexOf(':')
  if (sep > 0 && !source.startsWith('/')) {
    const rawMethod = source.slice(0, sep).trim().toUpperCase()
    const rawPath = source.slice(sep + 1).trim()

    if (!rawPath) {
      throw new Error('Restriction path pattern must not be empty.')
    }
    if (rawMethod && rawMethod !== '*' && !HTTP_METHOD_SET.has(rawMethod)) {
      throw new Error(`Unsupported restriction method "${source.slice(0, sep)}".`)
    }

    return {
      method: (!rawMethod || rawMethod === '*') ? '*' : rawMethod as HttpMethod,
      pathPattern: normalizeAndValidateRestrictionPath(rawPath),
      source,
    }
  }

  return {
    method: '*',
    pathPattern: normalizeAndValidateRestrictionPath(source),
    source,
  }
}

export function matchesRestrictionPath(path: string, pattern: string): boolean {
  return matchesGlob(path, pattern)
}

export function parseRestrictionSources(restrictionSources: readonly string[]): RestrictionRule[] {
  return restrictionSources.map(parseRestrictionRule)
}

export function findBlockedRestriction(
  rules: readonly RestrictionRule[],
  method: string | undefined,
  pathname: string,
): RestrictionRule | undefined {
  const normalizedMethod = String(method ?? 'GET').trim().toUpperCase() || 'GET'
  const normalizedPath = normalizeRestrictionMatchPath(pathname)
  return rules.find(
    rule => (rule.method === '*' || rule.method === normalizedMethod) && matchesRestrictionPath(normalizedPath, rule.pathPattern),
  )
}
