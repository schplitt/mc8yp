export const HTTP_METHODS = ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT', 'TRACE'] as const

export type HttpMethod = (typeof HTTP_METHODS)[number]
export type RestrictionMethod = HttpMethod | '*'

const HTTP_METHOD_SET: ReadonlySet<string> = new Set(HTTP_METHODS)

export interface RestrictionRule {
  method: RestrictionMethod
  pathPattern: string
  source: string
}

export interface CompiledRestrictionRule extends RestrictionRule {
  segments: ('**' | RegExp)[]
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
    if (segment.includes('**')) {
      throw new Error(`Invalid restriction segment "${segment}". "**" must be its own path segment.`)
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

export function escapeRestrictionRegex(value: string): string {
  let escaped = ''
  for (const char of value) {
    escaped += '\\^$.*+?()[]{}|'.includes(char) ? `\\${char}` : char
  }
  return escaped
}

export function compileRestrictionSegment(segment: string): '**' | RegExp {
  if (segment === '**') {
    return '**'
  }
  if (segment.includes('**')) {
    throw new Error(`Invalid restriction segment "${segment}". "**" must be its own path segment.`)
  }
  return new RegExp(`^${escapeRestrictionRegex(segment).split('\\*').join('[^/]*')}$`)
}

export function matchCompiledSegments(pattern: ('**' | RegExp)[], path: string[], pi = 0, si = 0): boolean {
  while (pi < pattern.length) {
    const seg = pattern[pi]
    if (seg === '**') {
      if (pi === pattern.length - 1) {
        return true
      }
      for (let i = si; i <= path.length; i++) {
        if (matchCompiledSegments(pattern, path, pi + 1, i)) {
          return true
        }
      }
      return false
    }
    if (si >= path.length || !(seg instanceof RegExp) || !seg.test(path[si]!)) {
      return false
    }
    pi++
    si++
  }

  return si === path.length
}

export function compileRestrictionRule(rule: RestrictionRule): CompiledRestrictionRule {
  return {
    ...rule,
    segments: rule.pathPattern === '/' ? [] : rule.pathPattern.slice(1).split('/').map(compileRestrictionSegment),
  }
}

export function matchesCompiledRule(rule: CompiledRestrictionRule, method: string, pathSegments: string[]): boolean {
  return (rule.method === '*' || rule.method === method) && matchCompiledSegments(rule.segments, pathSegments)
}

export function compileRestrictionSources(restrictionSources: readonly string[]): CompiledRestrictionRule[] {
  return restrictionSources.map(parseRestrictionRule).map(compileRestrictionRule)
}

export function getBlockedCompiledRestrictions(
  compiledRestrictions: readonly CompiledRestrictionRule[],
  method: string | undefined,
  pathname: string,
): CompiledRestrictionRule[] {
  const normalizedMethod = String(method ?? 'GET').trim().toUpperCase() || 'GET'
  const normalizedPath = normalizeRestrictionMatchPath(pathname)
  const pathSegments = normalizedPath === '/' ? [] : normalizedPath.slice(1).split('/')

  return compiledRestrictions.filter((rule) => matchesCompiledRule(rule, normalizedMethod, pathSegments))
}