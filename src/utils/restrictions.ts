import { createNodeDriver } from 'secure-exec'
import { parseURL } from 'ufo'

export const HTTP_METHODS = ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT', 'TRACE'] as const
export const RESTRICTION_EXTENSION_KEY = 'x-mc8yp-restrictions'
export const RESTRICTED_OPERATION_FLAG = 'x-mc8yp-restricted'
export const RESTRICTED_OPERATION_MESSAGE = 'x-mc8yp-restrictionMessage'
export const RESTRICTED_OPERATION_RULES = 'x-mc8yp-restrictionRules'
export const RESTRICTED_OPERATION_TYPE = 'x-mc8yp-restrictionType'
export const RESTRICTED_AGENT_NOTE = 'x-mc8yp-agentNote'

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

export interface RestrictionMatch {
  method: HttpMethod
  path: string
  matchingRules: RestrictionRule[]
}


type NetworkPermissionDecider = NonNullable<NonNullable<NonNullable<Parameters<typeof createNodeDriver>[0]>["permissions"]>["network"]>

type NetworkPermissionRequest = Parameters<NetworkPermissionDecider>[0]

type NetworkPermissionDecision = ReturnType<NetworkPermissionDecider>

// --- internals (3 functions: path norm, method norm, recursive segment match) ---

function normalizePath(value: string): string {
  let raw = value.trim()
  if (!raw) return '/'
  try {
    if (/^[A-Za-z][A-Za-z\d+\-.]*:\/\//.test(raw)) {
      raw = new URL(raw).pathname || '/'
    }
  } catch { /* use raw */ }
  raw = (raw.split('#', 1)[0] ?? raw).split('?', 1)[0] ?? raw
  raw = raw.startsWith('/') ? raw : `/${raw}`
  raw = raw.replace(/\/{2,}/g, '/')
  return (raw.length > 1 && raw.endsWith('/')) ? raw.slice(0, -1) : raw || '/'
}

function normalizeMethod(value?: string): HttpMethod {
  const upper = (value?.trim().toUpperCase() || 'GET') as Uppercase<string>
  if (HTTP_METHOD_SET.has(upper)) return upper as HttpMethod
  throw new Error(`Unsupported HTTP method "${value}".`)
}

function matchSegments(pattern: ('**' | RegExp)[], path: string[], pi = 0, si = 0): boolean {
  while (pi < pattern.length) {
    const seg = pattern[pi]
    if (seg === '**') {
      if (pi === pattern.length - 1) return true
      for (let i = si; i <= path.length; i++) {
        if (matchSegments(pattern, path, pi + 1, i)) return true
      }
      return false
    }
    if (si >= path.length || !(seg instanceof RegExp) || !seg.test(path[si]!)) return false
    pi++
    si++
  }
  return si === path.length
}

// --- public API ---

export function compileRestrictionRule(rule: RestrictionRule): CompiledRestrictionRule {
  const segments: ('**' | RegExp)[] = rule.pathPattern === '/'
    ? []
    : rule.pathPattern.slice(1).split('/').map((seg) => {
        if (seg === '**') return '**' as const
        if (seg.includes('**')) throw new Error(`Invalid segment "${seg}". "**" must be its own path segment.`)
        return new RegExp(`^${seg.replace(/[|\\{}()[\]^$+?.]/g, '\\$&').replace(/\\\*/g, '[^/]*')}$`)
      })
  return { ...rule, segments }
}

export function matchesCompiledRule(rule: CompiledRestrictionRule, method: string, pathSegments: string[]): boolean {
  return (rule.method === '*' || rule.method === method) && matchSegments(rule.segments, pathSegments)
}

export function parseRestrictionRule(input: string): RestrictionRule {
  const source = input.trim()
  if (!source) throw new Error('Restriction value must not be empty.')

  const sep = source.indexOf(':')
  if (sep > 0 && !source.startsWith('/')) {
    const rawMethod = source.slice(0, sep).trim().toUpperCase()
    const rawPath = source.slice(sep + 1).trim()
    if (!rawPath) throw new Error('Restriction path pattern must not be empty.')
    if (rawPath.includes('?') || rawPath.includes('#')) {
      throw new Error(`Restriction pattern "${rawPath}" must not include query strings or fragments.`)
    }
    if (rawMethod && rawMethod !== '*' && !HTTP_METHOD_SET.has(rawMethod)) {
      throw new Error(`Unsupported restriction method "${source.slice(0, sep)}".`)
    }
    const method: RestrictionMethod = (!rawMethod || rawMethod === '*') ? '*' : rawMethod as HttpMethod
    return { method, pathPattern: normalizePath(rawPath), source }
  }

  if (source.includes('?') || source.includes('#')) {
    throw new Error(`Restriction pattern "${source}" must not include query strings or fragments.`)
  }
  return { method: '*', pathPattern: normalizePath(source), source }
}

export function parseRestrictionQuery(url: string): RestrictionRule[] {
  return new URLSearchParams(parseURL(url).search ?? '').getAll('restriction').filter(Boolean).map(parseRestrictionRule)
}

export function evaluateRestrictions(rules: readonly RestrictionRule[], method: string, path: string): RestrictionMatch {
  const m = normalizeMethod(method)
  const p = normalizePath(path)
  const segs = p === '/' ? [] : p.slice(1).split('/')
  return {
    method: m,
    path: p,
    matchingRules: rules.filter((rule) => matchesCompiledRule(compileRestrictionRule(rule), m, segs)),
  }
}

export function createNetworkPermissionDecision(rules: readonly RestrictionRule[], request: NetworkPermissionRequest): NetworkPermissionDecision {
  if (request.op !== 'fetch') {
    return { allow: false, reason: 'Only fetch network operations are allowed in execute mode.' }
  }
  if (!request.url) {
    return { allow: false, reason: 'Network request URL is required.' }
  }

  const m = normalizeMethod(request.method)
  const p = normalizePath(request.url)
  const segs = p === '/' ? [] : p.slice(1).split('/')
  const blocked = rules.filter((rule) => matchesCompiledRule(compileRestrictionRule(rule), m, segs))

  if (blocked.length > 0) {
    return { allow: false, reason: `Network request blocked by MCP restrictions: ${blocked.map((r) => r.source).join(', ')}` }
  }
  return { allow: true }
}