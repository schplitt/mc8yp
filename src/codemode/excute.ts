import { encode } from '@toon-format/toon'
import openapi from '../../openapi.json' with { type: 'json' }
import { NodeRuntime, createNodeDriver, createNodeRuntimeDriverFactory } from 'secure-exec'
import { applyRestrictionsToOpenApiSpec } from './openapi-restrictions'
import { AsyncSemaphore } from './semaphore'
import { createC8yAuthHeaders, resolveC8yAuth } from '../utils/client'
import {
  createNetworkPermissionDecision,
  type RestrictionRule,
} from '../utils/restrictions'

const NO_DEFAULT_EXPORT_MESSAGE = 'Execution completed without returning a value.'
const QUERY_ENTRY_PATH = '/codemode-query.mjs'
const EXECUTE_ENTRY_PATH = '/codemode-execute.mjs'
const runtimeSemaphore = new AsyncSemaphore(3)

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

function createExecuteRuntime(restrictions: readonly RestrictionRule[] = []) {
  return new NodeRuntime({
    systemDriver: createNodeDriver({
      useDefaultNetwork: true,
      permissions: {
        network: (request) => createNetworkPermissionDecision(restrictions, request),
      },
    }),
    runtimeDriverFactory: createNodeRuntimeDriverFactory(),
    memoryLimit: 128,
    cpuTimeLimitMs: 50000,
  })
}

function formatResult(result: unknown): string {
  if (typeof result === 'string') {
    return result
  }

  try {
    return encode(result)
  } catch {
    return String(result)
  }
}

function normalizeCode(functionCode: string): string {
  let normalized = functionCode.trim()

  normalized = normalized
    .replace(/^```(?:js|javascript|ts|typescript)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()

  return normalized
}

function buildQueryScript(sourceCode: string, restrictions: readonly RestrictionRule[]): string {
  const restrictedSpec = applyRestrictionsToOpenApiSpec(openapi, restrictions)

  return [
    `const spec = ${JSON.stringify(restrictedSpec)};`,
    normalizeCode(sourceCode),
  ].join('\n\n')
}

function buildExecuteScript(sourceCode: string, tenantUrl: string, headers: Record<string, string>): string {
  return [
    'const cumulocity = Object.freeze((() => {',
    `  const tenantUrl = ${JSON.stringify(tenantUrl)};`,
    `  const authHeaders = ${JSON.stringify(headers)};`,
    '  const resolveUrl = (descriptor) => {',
    '    if (descriptor.startsWith(tenantUrl)) {',
    '      return descriptor;',
    '    }',
    '    if (descriptor.startsWith("/")) {',
    '      return tenantUrl + descriptor;',
    '    }',
    '    return tenantUrl + "/" + descriptor;',
    '  };',
    '  const normalizeRequest = (options) => {',
    '    if (!options || typeof options !== "object") {',
    '      throw new TypeError("request options must be an object");',
    '    }',
    '    const { path, ...rest } = options;',
    '    return { path, init: rest };',
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
    '      const headers = new Headers(init.headers ?? {});',
    '      for (const [key, value] of Object.entries(authHeaders)) {',
    '        headers.set(key, value);',
    '      }',
    '      const body = normalizeBody(headers, init.body);',
    '      const requestHeaders = Object.fromEntries(headers.entries());',
    '      const response = await fetch(resolveUrl(path), {',
    '        ...init,',
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
    normalizeCode(sourceCode),
  ].join('\n\n')
}

function extractDefaultExport(exportsObject: unknown): unknown {
  if ((typeof exportsObject === 'object' && exportsObject !== null) || typeof exportsObject === 'function') {
    if (Object.prototype.hasOwnProperty.call(exportsObject, 'default')) {
      return (exportsObject as { default: unknown }).default
    }
  }

  if (typeof exportsObject !== 'undefined') {
    return exportsObject
  }

  throw new Error(NO_DEFAULT_EXPORT_MESSAGE)
}

async function runExecuteScript(code: string, restrictions: readonly RestrictionRule[]): Promise<unknown> {
  return runModule(code, EXECUTE_ENTRY_PATH, createExecuteRuntime(restrictions))
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

export async function query(functionCode: string, restrictions: readonly RestrictionRule[] = []): Promise<string> {
  const result = await runQueryScript(buildQueryScript(functionCode, restrictions))
  return formatResult(result)
}

export async function execute(functionCode: string, input?: unknown, restrictions: readonly RestrictionRule[] = []): Promise<string> {
  const auth = await resolveC8yAuth(input)
  const authHeaders = createC8yAuthHeaders(auth)

  const result = await runExecuteScript(buildExecuteScript(functionCode, auth.tenantUrl, authHeaders), restrictions)
  return formatResult(result)
}
