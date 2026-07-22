import { sanitizeToolName, toPascalCase } from './operation-naming'

// ─────────────────────────────────────────────────────────────────────────
// JSON Schema → TypeScript declaration rendering.
//
// Renders compact inline TS declarations for LLM context on demand —
// deliberately dependency-free (no json-schema-to-typescript/quicktype:
// those are file codegen tools, not inline renderers) with a depth guard,
// cycle detection, and per-method graceful degradation to `unknown`.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Loose local JSON Schema view — only the fields the renderer reads. Bundled
 * and discovered OpenAPI schemas arrive as `unknown`; callers cast into this.
 */
export interface JsonSchema {
  $ref?: string
  anyOf?: JsonSchemaDefinition[]
  oneOf?: JsonSchemaDefinition[]
  allOf?: JsonSchemaDefinition[]
  enum?: unknown[]
  const?: unknown
  type?: string | string[]
  properties?: Record<string, JsonSchemaDefinition>
  required?: string[]
  items?: JsonSchemaDefinition | JsonSchemaDefinition[]
  prefixItems?: JsonSchemaDefinition[]
  additionalProperties?: JsonSchemaDefinition
  description?: string
  format?: string
  nullable?: boolean
  minimum?: number
  maximum?: number
  example?: unknown
}

export type JsonSchemaDefinition = JsonSchema | boolean

export interface MethodDescriptor {
  description?: string
  inputSchema: JsonSchema
  outputSchema?: JsonSchema
}

function escapeControlChar(ch: string): string {
  const code = ch.charCodeAt(0)
  return code <= 0x1F || code === 0x7F ? `\\u${code.toString(16).padStart(4, '0')}` : ch
}

function escapeStringLiteral(value: string): string {
  let out = ''
  for (const ch of value) {
    if (ch === '\\')
      out += '\\\\'
    else if (ch === '"')
      out += '\\"'
    else if (ch === '\n')
      out += '\\n'
    else if (ch === '\r')
      out += '\\r'
    else if (ch === '\t')
      out += '\\t'
    else if (ch === '\u2028')
      out += '\\u2028'
    else if (ch === '\u2029')
      out += '\\u2029'
    else out += escapeControlChar(ch)
  }
  return out
}

function quoteProp(name: string): string {
  if (/^[a-z_$][\w$]*$/i.test(name))
    return name
  return `"${escapeStringLiteral(name)}"`
}

/**
 * Prevent premature JSDoc closure from star-slash sequences.
 * @param text
 */
function escapeJsDoc(text: string): string {
  return text.replace(/\*\//g, '*\\/')
}

interface ConversionContext {
  root: JsonSchema
  depth: number
  seen: Set<unknown>
  maxDepth: number
}

/**
 * Resolve an internal JSON Pointer `$ref` (e.g. `#/definitions/Foo`) against
 * the root schema. Returns null for external URLs or unresolvable paths.
 * @param ref
 * @param root
 */
function resolveRef(ref: string, root: JsonSchema): JsonSchemaDefinition | null {
  if (ref === '#')
    return root
  if (!ref.startsWith('#/'))
    return null

  const segments = ref.slice(2).split('/').map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'))
  let current: unknown = root
  for (const segment of segments) {
    if (current === null || typeof current !== 'object')
      return null
    current = (current as Record<string, unknown>)[segment]
    if (current === undefined)
      return null
  }

  if (typeof current === 'boolean')
    return current
  if (current === null || typeof current !== 'object')
    return null
  return current as JsonSchema
}

/**
 * Apply OpenAPI 3.0 `nullable: true` to a rendered type.
 * @param result
 * @param schema
 */
function applyNullable(result: string, schema: unknown): string {
  if (result !== 'unknown' && result !== 'never' && (schema as JsonSchema | undefined)?.nullable === true)
    return `${result} | null`
  return result
}

function renderEnumMember(value: unknown): string {
  if (value === null)
    return 'null'
  if (typeof value === 'string')
    return `"${escapeStringLiteral(value)}"`
  if (typeof value === 'object')
    return JSON.stringify(value) ?? 'unknown'
  return String(value)
}

export function jsonSchemaToTypeString(schema: JsonSchemaDefinition, indent: string, ctx: ConversionContext): string {
  if (typeof schema === 'boolean')
    return schema ? 'unknown' : 'never'
  if (ctx.depth >= ctx.maxDepth)
    return 'unknown'
  if (ctx.seen.has(schema))
    return 'unknown'

  ctx.seen.add(schema)
  const nextCtx: ConversionContext = { ...ctx, depth: ctx.depth + 1 }

  try {
    if (schema.$ref) {
      const resolved = resolveRef(schema.$ref, ctx.root)
      if (!resolved)
        return 'unknown'
      return applyNullable(jsonSchemaToTypeString(resolved, indent, nextCtx), schema)
    }

    if (schema.anyOf)
      return applyNullable(schema.anyOf.map((s) => jsonSchemaToTypeString(s, indent, nextCtx)).join(' | '), schema)
    if (schema.oneOf)
      return applyNullable(schema.oneOf.map((s) => jsonSchemaToTypeString(s, indent, nextCtx)).join(' | '), schema)
    if (schema.allOf)
      return applyNullable(schema.allOf.map((s) => jsonSchemaToTypeString(s, indent, nextCtx)).join(' & '), schema)

    if (schema.enum) {
      if (schema.enum.length === 0)
        return 'never'
      return applyNullable(schema.enum.map(renderEnumMember).join(' | '), schema)
    }

    if (schema.const !== undefined)
      return applyNullable(renderEnumMember(schema.const), schema)

    const type = schema.type

    if (type === 'string')
      return applyNullable('string', schema)
    if (type === 'number' || type === 'integer')
      return applyNullable('number', schema)
    if (type === 'boolean')
      return applyNullable('boolean', schema)
    if (type === 'null')
      return 'null'

    if (type === 'array') {
      if (Array.isArray(schema.prefixItems))
        return applyNullable(`[${schema.prefixItems.map((s) => jsonSchemaToTypeString(s, indent, nextCtx)).join(', ')}]`, schema)
      if (Array.isArray(schema.items))
        return applyNullable(`[${schema.items.map((s) => jsonSchemaToTypeString(s, indent, nextCtx)).join(', ')}]`, schema)
      if (schema.items)
        return applyNullable(`${jsonSchemaToTypeString(schema.items, indent, nextCtx)}[]`, schema)
      return applyNullable('unknown[]', schema)
    }

    if (type === 'object' || schema.properties) {
      const props = schema.properties ?? {}
      const required = new Set(schema.required ?? [])
      const lines: string[] = []

      for (const [propName, propSchema] of Object.entries(props)) {
        const optionalMark = required.has(propName) ? '' : '?'

        if (typeof propSchema === 'boolean') {
          lines.push(`${indent}    ${quoteProp(propName)}${optionalMark}: ${propSchema ? 'unknown' : 'never'};`)
          continue
        }

        const propType = jsonSchemaToTypeString(propSchema, `${indent}    `, nextCtx)
        const desc = propSchema.description ? escapeJsDoc(propSchema.description.replace(/\r?\n/g, ' ')) : undefined
        // One compact tag line for what the type cannot express: numeric
        // bounds, a usage example (nearly every core parameter ships one —
        // for query-language params it is a working expression), and the
        // format marker (`@format c8y:query` is the hook that sends an
        // agent to docs.search for the grammar).
        const tags: string[] = []
        if (propSchema.minimum !== undefined)
          tags.push(`@minimum ${propSchema.minimum}`)
        if (propSchema.maximum !== undefined)
          tags.push(`@maximum ${propSchema.maximum}`)
        if (propSchema.example !== undefined) {
          const example = typeof propSchema.example === 'string' ? propSchema.example : JSON.stringify(propSchema.example) ?? ''
          tags.push(`@example ${escapeJsDoc(example.replace(/\s*\n\s*/g, ' '))}`)
        }
        if (propSchema.format)
          tags.push(`@format ${escapeJsDoc(propSchema.format)}`)
        const tagLine = tags.length > 0 ? tags.join(' ') : undefined

        if (desc && tagLine) {
          lines.push(`${indent}    /**`, `${indent}     * ${desc}`, `${indent}     * ${tagLine}`, `${indent}     */`)
        } else if (desc || tagLine) {
          lines.push(`${indent}    /** ${desc ?? tagLine} */`)
        }

        lines.push(`${indent}    ${quoteProp(propName)}${optionalMark}: ${propType};`)
      }

      if (schema.additionalProperties) {
        const valueType = schema.additionalProperties === true
          ? 'unknown'
          : jsonSchemaToTypeString(schema.additionalProperties, `${indent}    `, nextCtx)
        lines.push(`${indent}    [key: string]: ${valueType};`)
      }

      if (lines.length === 0)
        return applyNullable(schema.additionalProperties === false ? '{}' : 'Record<string, unknown>', schema)

      return applyNullable(`{\n${lines.join('\n')}\n${indent}}`, schema)
    }

    if (Array.isArray(type)) {
      const types = type.map((t) => {
        if (t === 'string')
          return 'string'
        if (t === 'number' || t === 'integer')
          return 'number'
        if (t === 'boolean')
          return 'boolean'
        if (t === 'null')
          return 'null'
        if (t === 'array')
          return 'unknown[]'
        if (t === 'object')
          return 'Record<string, unknown>'
        return 'unknown'
      })
      return applyNullable(types.join(' | '), schema)
    }

    return 'unknown'
  } finally {
    ctx.seen.delete(schema)
  }
}

export function jsonSchemaToType(schema: JsonSchema, typeName: string): string {
  const typeBody = jsonSchemaToTypeString(schema, '', {
    root: schema,
    depth: 0,
    seen: new Set(),
    maxDepth: 20,
  })
  return `type ${typeName} = ${typeBody}`
}

/**
 * Render a single method's input/output type aliases and its bare signature
 * line. No JSDoc wrapper and no `@param` lines — property descriptions
 * already live as JSDoc inside the input type, so repeating them would only
 * bloat describe output. Malformed schemas degrade this one method to
 * `unknown` types instead of failing the whole render.
 * @param namespace Sandbox namespace the method lives on (for the signature).
 * @param methodName
 * @param descriptor
 */
export function renderMethodDeclaration(namespace: string, methodName: string, descriptor: MethodDescriptor): { types: string, signature: string } {
  const typeName = toPascalCase(sanitizeToolName(methodName))

  let inputType: string
  let outputType: string
  try {
    inputType = jsonSchemaToType(descriptor.inputSchema, `${typeName}Input`)
    outputType = descriptor.outputSchema
      ? jsonSchemaToType(descriptor.outputSchema, `${typeName}Output`)
      : `type ${typeName}Output = unknown`
  } catch {
    inputType = `type ${typeName}Input = unknown`
    outputType = `type ${typeName}Output = unknown`
  }

  return {
    types: `${inputType}\n${outputType}`,
    signature: `${sanitizeToolName(namespace)}.${sanitizeToolName(methodName)}(input: ${typeName}Input): Promise<${typeName}Output>`,
  }
}
