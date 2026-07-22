// ─────────────────────────────────────────────────────────────────────────
// Operation and identifier naming.
//
// These names are the primary human/agent-facing surface of the derived
// namespaces — everything an agent reads in search results, describe output,
// and code it writes goes through here.
//
// Naming rules:
//   1. An operation with an `operationId` uses it, sanitized into a valid JS
//      identifier. Verb disambiguation on a shared URL comes from the spec
//      author's convention (Cumulocity embeds it: getAlarmCollectionResource
//      vs postAlarmCollectionResource on the same /alarm/alarms path).
//   2. Without an `operationId`, a readable camelCase name is synthesized
//      from the HTTP method and path: static segments are PascalCased and
//      concatenated, `{param}` segments become `By<Param>`:
//        GET  /alarm/alarms          → getAlarmAlarms
//        POST /alarm/alarms          → postAlarmAlarms
//        GET  /alarm/alarms/{id}     → getAlarmAlarmsById
//        GET  /service/dtm/assets    → getServiceDtmAssets
//      The verb prefix keeps methods on the same path distinct.
// ─────────────────────────────────────────────────────────────────────────

const JS_RESERVED = new Set([
  'abstract',
  'arguments',
  'await',
  'boolean',
  'break',
  'byte',
  'case',
  'catch',
  'char',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'double',
  'else',
  'enum',
  'eval',
  'export',
  'extends',
  'false',
  'final',
  'finally',
  'float',
  'for',
  'function',
  'goto',
  'if',
  'implements',
  'import',
  'in',
  'instanceof',
  'int',
  'interface',
  'let',
  'long',
  'native',
  'new',
  'null',
  'package',
  'private',
  'protected',
  'public',
  'return',
  'short',
  'static',
  'super',
  'switch',
  'synchronized',
  'this',
  'throw',
  'throws',
  'transient',
  'true',
  'try',
  'typeof',
  'undefined',
  'var',
  'void',
  'volatile',
  'while',
  'with',
  'yield',
])

/**
 * Sanitize a name into a valid JavaScript identifier: separators become `_`,
 * invalid characters are stripped, digit-leading names get a `_` prefix, and
 * JS reserved words get a `_` suffix.
 * @param name
 */
export function sanitizeToolName(name: string): string {
  if (!name)
    return '_'
  let sanitized = name.replace(/[-.\s]/g, '_').replace(/[^\w$]/g, '')
  if (!sanitized)
    return '_'
  if (/^\d/.test(sanitized))
    sanitized = `_${sanitized}`
  if (JS_RESERVED.has(sanitized))
    sanitized = `${sanitized}_`
  return sanitized
}

export function toPascalCase(value: string): string {
  return value
    .replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())
    .replace(/^[a-z]/, (letter) => letter.toUpperCase())
}

/**
 * Resolve the namespace method name for one operation: the sanitized
 * `operationId` when present, otherwise a camelCase name synthesized from
 * the HTTP method and path (see module header for the rules).
 * @param method
 * @param path
 * @param operationId
 */
export function operationName(method: string, path: string, operationId?: string): string {
  if (operationId)
    return sanitizeToolName(operationId)

  let name = method.toLowerCase()
  for (const segment of path.split('/')) {
    if (!segment)
      continue
    if (segment.startsWith('{') && segment.endsWith('}'))
      name += `By${toPascalCase(sanitizeToolName(segment.slice(1, -1)))}`
    else
      name += toPascalCase(sanitizeToolName(segment))
  }
  return sanitizeToolName(name)
}
