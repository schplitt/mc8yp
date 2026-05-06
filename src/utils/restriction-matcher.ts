import type { RestrictionRule } from './restrictions'

export interface CompiledRestrictionRule extends RestrictionRule {
  segments: ('**' | RegExp)[]
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
    const segment = pattern[pi]
    if (segment === '**') {
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

    if (si >= path.length || !(segment instanceof RegExp) || !segment.test(path[si]!)) {
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

export function findBlockingRestrictions(
  rules: readonly RestrictionRule[],
  method: string | undefined,
  pathname: string,
): RestrictionRule[] {
  const normalizedMethod = typeof method === 'string' ? method.trim().toUpperCase() : ''
  const pathSegments = pathname === '/' ? [] : pathname.slice(1).split('/')

  return rules.filter((rule) => {
    const compiledRule = compileRestrictionRule(rule)
    if (!normalizedMethod) {
      return compiledRule.method === '*' && matchCompiledSegments(compiledRule.segments, pathSegments)
    }

    return matchesCompiledRule(compiledRule, normalizedMethod, pathSegments)
  })
}
