import { encode } from '@toon-format/toon'
import { getCoreOpenApiSpec } from '#core-openapi'
import { NodeRuntime, createNodeDriver, createNodeRuntimeDriverFactory } from 'secure-exec'
import { applyRestrictionsToOpenApiSpec } from './openapi-restrictions'
import { AsyncSemaphore } from './semaphore'
import { createNetworkPermissionDecision } from './network-permissions'
import { createC8yAuthHeaders, resolveC8yAuth } from '../utils/client'
import {
  compileRestrictionRule,
  compileRestrictionSegment,
  escapeRestrictionRegex,
  matchCompiledSegments,
  matchesCompiledRule,
} from '../utils/restriction-matcher'
import { HTTP_METHODS } from '../utils/restrictions'
import type { AllowRule, RestrictionRule } from '../utils/restrictions'

const NO_DEFAULT_EXPORT_MESSAGE = 'Execution completed without returning a value.'
const QUERY_ENTRY_PATH = '/codemode-query.mjs'
const EXECUTE_ENTRY_PATH = '/codemode-execute.mjs'
const runtimeSemaphore = new AsyncSemaphore(3)
const BLOCKED_REQUEST_PREFIX = 'Request blocked by MCP connection policy.'

interface ExecuteSuccessEnvelope {
  status: 'success'
  result: unknown
}

interface ExecuteErrorEnvelope {
  status: 'blocked' | 'failed'
  error: {
    message: string
  }
}

type ExecuteEnvelope = ExecuteSuccessEnvelope | ExecuteErrorEnvelope

function serializeExecuteConfig(
  tenantUrl: string,
  headers: Record<string, string>,
  restrictions: readonly RestrictionRule[],
  allowRules: readonly AllowRule[],
): string {
  const normalizedTenantUrl = new URL(tenantUrl).toString()
  const serializedRestrictions = restrictions.map(({ type, method, pathPattern, source }) => ({ type, method, pathPattern, source }))
  const serializedAllowRules = allowRules.map(({ type, method, pathPattern, source }) => ({ type, method, pathPattern, source }))

  return JSON.stringify({
    tenantUrl: normalizedTenantUrl,
    authHeaders: headers,
    restrictions: serializedRestrictions,
    allowRules: serializedAllowRules,
  })
}

function createQueryRuntime() {
  return new NodeRuntime({
    systemDriver: createNodeDriver({
      useDefaultNetwork: true,
      permissions: {
        network: () => ({ allow: false, reason: 'Network access is disabled for query execution.' }),
      },
    }),
    runtimeDriverFactory: createNodeRuntimeDriverFactory(),
    memoryLimit: 128,
    cpuTimeLimitMs: 50000,
  })
}

function createExecuteRuntime(
  tenantUrl: string,
  restrictions: readonly RestrictionRule[],
  allowRules: readonly AllowRule[],
) {
  return new NodeRuntime({
    systemDriver: createNodeDriver({
      useDefaultNetwork: true,
      permissions: {
        network: (request) => createNetworkPermissionDecision(tenantUrl, request, restrictions, allowRules),
      },
    }),
    runtimeDriverFactory: createNodeRuntimeDriverFactory(),
    memoryLimit: 128,
    cpuTimeLimitMs: 50000,
  })
}

function normalizeCode(functionCode: string): string {
  let normalized = functionCode.trim()

  normalized = normalized
    .replace(/^```(?:js|javascript|ts|typescript)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()

  return normalized
}

function buildQueryScript(
  sourceCode: string,
  restrictions: readonly RestrictionRule[],
  allowRules: readonly AllowRule[],
): string {
  const restrictedSpec = applyRestrictionsToOpenApiSpec(
    getCoreOpenApiSpec() as Parameters<typeof applyRestrictionsToOpenApiSpec>[0],
    restrictions,
    allowRules,
  )
  const functionExpression = normalizeCode(sourceCode)

  return [
    `const spec = ${JSON.stringify(restrictedSpec)};`,
    `const __mc8ypQuery = (${functionExpression});`,
    '',
    'if (typeof __mc8ypQuery !== "function") {',
    '  throw new TypeError("Query code must evaluate to a function.");',
    '}',
    '',
    'export default await __mc8ypQuery();',
  ].join('\n\n')
}

export function buildExecutePrelude(
  tenantUrl: string,
  headers: Record<string, string>,
  restrictions: readonly RestrictionRule[] = [],
  allowRules: readonly AllowRule[] = [],
): string {
  const serializedConfig = JSON.stringify(serializeExecuteConfig(tenantUrl, headers, restrictions, allowRules))

  return [
    'const cumulocity = Object.freeze((() => {',
    `  const config = JSON.parse(${serializedConfig});`,
    '  if (!config || typeof config !== "object") {',
    '    throw new TypeError("Invalid execute configuration.");',
    '  }',
    '  const { tenantUrl, authHeaders, restrictions, allowRules } = config;',
    '  if (typeof tenantUrl !== "string") {',
    '    throw new TypeError("Execute configuration must contain a string tenant URL.");',
    '  }',
    '  if (!Array.isArray(restrictions) || restrictions.some((rule) => !rule || typeof rule !== "object" || typeof rule.type !== "string" || typeof rule.method !== "string" || typeof rule.pathPattern !== "string" || typeof rule.source !== "string")) {',
    '    throw new TypeError("Execute configuration must contain valid restriction rules.");',
    '  }',
    '  if (!Array.isArray(allowRules) || allowRules.some((rule) => !rule || typeof rule !== "object" || typeof rule.type !== "string" || typeof rule.method !== "string" || typeof rule.pathPattern !== "string" || typeof rule.source !== "string")) {',
    '    throw new TypeError("Execute configuration must contain valid allow rules.");',
    '  }',
    '  const resolveUrl = (descriptor) => {',
    '    return new URL(descriptor, tenantUrl.endsWith("/") ? tenantUrl : tenantUrl + "/");',
    '  };',
    '  const normalizeRequest = (options) => {',
    '    if (!options || typeof options !== "object") {',
    '      throw new TypeError("request options must be an object");',
    '    }',
    '    const { path, ...rest } = options;',
    '    return { path, init: rest };',
    '  };',
    `  const HTTP_METHODS = ${JSON.stringify(HTTP_METHODS)};`,
    '  const HTTP_METHOD_SET = new Set(HTTP_METHODS);',
    `  const escapeRestrictionRegex = ${escapeRestrictionRegex.toString()};`,
    `  const compileRestrictionSegment = ${compileRestrictionSegment.toString()};`,
    `  const matchCompiledSegments = ${matchCompiledSegments.toString()};`,
    `  const compileRestrictionRule = ${compileRestrictionRule.toString()};`,
    `  const matchesCompiledRule = ${matchesCompiledRule.toString()};`,
    '  const compiledRestrictions = restrictions.map(compileRestrictionRule);',
    '  const compiledAllowRules = allowRules.map(compileRestrictionRule);',
    '  const findMatchingRules = (compiledRules, method, pathname) => {',
    '    const normalizedMethod = typeof method === "string" ? method.trim().toUpperCase() : "";',
    '    const pathSegments = pathname === "/" ? [] : pathname.slice(1).split("/");',
    '    return compiledRules.filter((rule) => {',
    '      if (!normalizedMethod) {',
    '        return rule.method === "*" && matchCompiledSegments(rule.segments, pathSegments);',
    '      }',
    '      return matchesCompiledRule(rule, normalizedMethod, pathSegments);',
    '    });',
    '  };',
    '  const evaluateAccessPolicy = (method, pathname) => {',
    '    const matchingRestrictions = findMatchingRules(compiledRestrictions, method, pathname);',
    '    if (matchingRestrictions.length > 0) {',
    '      return { blocked: true, blockedBy: "restriction", matchingRestrictions };',
    '    }',
    '    if (compiledAllowRules.length === 0) {',
    '      return { blocked: false };',
    '    }',
    '    const matchingAllowRules = findMatchingRules(compiledAllowRules, method, pathname);',
    '    if (matchingAllowRules.length > 0) {',
    '      return { blocked: false };',
    '    }',
    '    return { blocked: true, blockedBy: "allow" };',
    '  };',
    '  const validateRequestMethod = (method) => {',
    '    if (typeof method !== "string" || method.trim().length === 0) {',
    '      throw new TypeError("request method must be a non-empty string");',
    '    }',
    '    const normalizedMethod = method.trim().toUpperCase();',
    '    if (!HTTP_METHOD_SET.has(normalizedMethod)) {',
    '      throw new TypeError("request method must be one of: " + HTTP_METHODS.join(", "));',
    '    }',
    '    return normalizedMethod;',
    '  };',
    '  const formatBlockedRequestMessage = (method, path, accessDecision) => {',
    '    if (accessDecision.blockedBy === "allow") {',
    '      return [',
    '        "Request blocked by MCP connection policy.",',
    '        "",',
    '        "This operation is intentionally blocked because it is not included in the current MCP connection allow list.",',
    '        "It did not fail at the Cumulocity API and it was not executed against the tenant.",',
    '        "Retrying or trying the same operation again through this connection will not succeed.",',
    '        "",',
    '        "Report this to the user as a connection-level access restriction.",',
    '        "If the operation is needed, the MCP allow list for this connection must be updated by whoever manages that configuration.",',
    '        "",',
    '        "Blocked operation:",',
    '        "Method: " + method,',
    '        "Path: " + path,',
    '        "Configured allow rules:",',
    '        ...(allowRules.length > 0 ? allowRules.map((rule) => "- " + rule.source) : ["- (none)"]),',
    '      ].join("\\n");',
    '    }',
    '    return [',
    '      "Request blocked by MCP connection policy.",',
    '      "",',
    '      "This operation is intentionally denied by the current MCP connection configuration.",',
    '      "It did not fail at the Cumulocity API and it was not executed against the tenant.",',
    '      "Retrying or trying the same operation again through this connection will not succeed.",',
    '      "",',
    '      "Report this to the user as a connection-level access restriction.",',
    '      "If the operation is needed, the MCP restrictions for this connection must be updated by whoever manages that configuration.",',
    '      "",',
    '      "Blocked operation:",',
    '      "Method: " + method,',
    '      "Path: " + path,',
    '      "Matching restrictions:",',
    '      ...accessDecision.matchingRestrictions.map((rule) => "- " + rule.source),',
    '    ].join("\\n");',
    '  };',
    '  const normalizeBody = (headers, body) => {',
    '    if (body == null || typeof body === "string") {',
    '      return body;',
    '    }',
    '    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body) || body instanceof Blob || body instanceof FormData || body instanceof URLSearchParams) {',
    '      return body;',
    '    }',
    '    if (!headers.has("Content-Type")) {',
    '      headers.set("Content-Type", "application/json");',
    '    }',
    '    return JSON.stringify(body);',
    '  };',
    '  const readBody = async (response) => {',
    '    const text = await response.text();',
    '    if (!text) {',
    '      return null;',
    '    }',
    '    const contentType = response.headers.get("content-type") ?? "";',
    '    if (contentType.includes("json")) {',
    '      return JSON.parse(text);',
    '    }',
    '    return text;',
    '  };',
    '  return {',
    '    request: async (options) => {',
    '      const { path, init } = normalizeRequest(options);',
    '      if (typeof path !== "string" || path.length === 0) {',
    '        throw new TypeError("request path must be a non-empty string");',
    '      }',
    '      const method = validateRequestMethod(init.method);',
    '      const resolvedUrl = resolveUrl(path);',
    '      const accessDecision = evaluateAccessPolicy(method, resolvedUrl.pathname);',
    '      if (accessDecision.blocked) {',
    '        throw new Error(formatBlockedRequestMessage(method, resolvedUrl.pathname, accessDecision));',
    '      }',
    '      const headers = new Headers(init.headers ?? {});',
    '      for (const [key, value] of Object.entries(authHeaders)) {',
    '        headers.set(key, value);',
    '      }',
    '      const body = normalizeBody(headers, init.body);',
    '      const requestHeaders = Object.fromEntries(headers.entries());',
    '      const response = await fetch(resolvedUrl.toString(), {',
    '        ...init,',
    '        method,',
    '        headers: requestHeaders,',
    '        body,',
    '      });',
    '      const data = await readBody(response);',
    '      if (!response.ok) {',
    '        const detail = typeof data === "string" ? data : JSON.stringify(data);',
    '        throw new Error("Cumulocity request failed with " + response.status + " " + response.statusText + (detail ? ": " + detail : ""));',
    '      }',
    '      return data;',
    '    },',
    '  };',
    '})());',
  ].join('\n\n')
}

export function buildExecuteScript(
  sourceCode: string,
  tenantUrl: string,
  headers: Record<string, string>,
  restrictions: readonly RestrictionRule[] = [],
  allowRules: readonly AllowRule[] = [],
): string {
  const functionExpression = normalizeCode(sourceCode)

  return [
    buildExecutePrelude(tenantUrl, headers, restrictions, allowRules),
    `const __mc8ypExecute = (${functionExpression});`,
    '',
    'const __mc8ypErrorMessage = (error) => error instanceof Error ? error.message : String(error);',
    '',
    'let __mc8ypEnvelope;',
    'try {',
    '  if (typeof __mc8ypExecute !== "function") {',
    '    throw new TypeError("Execute code must evaluate to a function.");',
    '  }',
    '  __mc8ypEnvelope = {',
    '    status: "success",',
    '    result: await __mc8ypExecute(),',
    '  };',
    '} catch (error) {',
    '  const message = __mc8ypErrorMessage(error);',
    '  __mc8ypEnvelope = {',
    `    status: message.startsWith(${JSON.stringify(BLOCKED_REQUEST_PREFIX)}) ? "blocked" : "failed",`,
    '    error: {',
    '      message,',
    '    },',
    '  };',
    '}',
    '',
    'export default __mc8ypEnvelope;',
  ].join('\n\n')
}

function extractDefaultExport(exportsObject: unknown): unknown {
  if ((typeof exportsObject === 'object' && exportsObject !== null) || typeof exportsObject === 'function') {
    if (Object.hasOwn(exportsObject, 'default')) {
      return (exportsObject as { default: unknown }).default
    }
  }

  if (typeof exportsObject !== 'undefined') {
    return exportsObject
  }

  throw new Error(NO_DEFAULT_EXPORT_MESSAGE)
}

async function runExecuteScript(
  code: string,
  tenantUrl: string,
  restrictions: readonly RestrictionRule[],
  allowRules: readonly AllowRule[],
): Promise<unknown> {
  const release = await runtimeSemaphore.acquire()
  const runtime = createExecuteRuntime(tenantUrl, restrictions, allowRules)

  try {
    const result = await runtime.run<unknown>(code, EXECUTE_ENTRY_PATH)

    if (result.code !== 0) {
      const errorMessage = `Execution failed with code ${result.code}${result.errorMessage ? `: ${result.errorMessage}` : ''}`
      throw new Error(errorMessage)
    }

    return extractDefaultExport(result.exports)
  } finally {
    runtime.dispose()
    release()
  }
}

async function runQueryScript(code: string): Promise<unknown> {
  return runModule(code, QUERY_ENTRY_PATH, createQueryRuntime())
}

async function runModule(code: string, entryPath: string, runtime: NodeRuntime): Promise<unknown> {
  const release = await runtimeSemaphore.acquire()

  try {
    const result = await runtime.run<unknown>(code, entryPath)

    if (result.code !== 0) {
      const errorMessage = `Execution failed with code ${result.code}${result.errorMessage ? `: ${result.errorMessage}` : ''}`
      throw new Error(errorMessage)
    }

    return extractDefaultExport(result.exports)
  } finally {
    runtime.dispose()
    release()
  }
}

export async function query(
  functionCode: string,
  restrictions: readonly RestrictionRule[] = [],
  allowRules: readonly AllowRule[] = [],
): Promise<string> {
  const result = await runQueryScript(buildQueryScript(functionCode, restrictions, allowRules))
  // dont encode as toon to make spec easier to understand
  return typeof result === 'string' ? result : JSON.stringify(result)
}

export async function execute(
  functionCode: string,
  input?: unknown,
  restrictions: readonly RestrictionRule[] = [],
  allowRules: readonly AllowRule[] = [],
): Promise<string> {
  const auth = await resolveC8yAuth(input)
  const authHeaders = createC8yAuthHeaders(auth)

  const result = await runExecuteScript(
    buildExecuteScript(functionCode, auth.tenantUrl, authHeaders, restrictions, allowRules),
    auth.tenantUrl,
    restrictions,
    allowRules,
  ) as ExecuteEnvelope

  if (result.status === 'success') {
    return encode(result.result)
  }

  return result.error.message
}
