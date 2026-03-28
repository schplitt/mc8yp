import openapi from '../../openapi.json' with { type: 'json' }
import { NodeRuntime, createNodeDriver, createNodeRuntimeDriverFactory } from 'secure-exec'
import { createC8yAuthHeaders, resolveC8yAuth } from '../utils/client'

let runtime: NodeRuntime | null = null
const queryContext = Object.freeze({
  spec: openapi,
})

const RESULT_PREFIX = '__RESULT__'
const ERROR_PREFIX = '__ERROR__'
const NO_RESULT_MESSAGE = 'Execution completed without returning a value. The function likely did not return anything.'

const executeScriptSuffix = [
  'const __userFunction = (__USER_FUNCTION__);',
  'if (typeof __userFunction !== "function") {',
  '  throw new TypeError("Code must evaluate to a function");',
  '}',
  'const __fn = async () => __userFunction((() => {',
  '  const __resolveUrl = (descriptor) => {',
  '    if (descriptor.startsWith(__TENANT_URL__)) {',
  '      return descriptor;',
  '    }',
  '    if (descriptor.startsWith("/")) {',
  '      return __TENANT_URL__ + descriptor;',
  '    }',
  '    return __TENANT_URL__ + "/" + descriptor;',
  '  };',
  '  const __normalizeRequest = (descriptor, input) => {',
  '    if (typeof descriptor === "string") {',
  '      return { path: descriptor, init: input ?? {} };',
  '    }',
  '    if (!descriptor || typeof descriptor !== "object") {',
  '      throw new TypeError("descriptor must be a path string or object");',
  '    }',
  '    const { path, ...rest } = descriptor;',
  '    return { path, init: { ...rest, ...(input ?? {}) } };',
  '  };',
  '  const __normalizeBody = (headers, body) => {',
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
  '  const __readBody = async (response) => {',
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
  '  return Object.freeze({',
  '    cumulocity: Object.freeze({',
  '      request: async (descriptor, input = {}) => {',
  '        const { path, init } = __normalizeRequest(descriptor, input);',
  '        if (typeof path !== "string" || path.length === 0) {',
  '          throw new TypeError("request path must be a non-empty string");',
  '        }',
  '        const headers = new Headers(init.headers ?? {});',
  '        for (const [key, value] of Object.entries(__AUTH_HEADERS__)) {',
  '          headers.set(key, value);',
  '        }',
  '        const body = __normalizeBody(headers, init.body);',
  '        const requestHeaders = Object.fromEntries(headers.entries());',
  '        const response = await fetch(__resolveUrl(path), {',
  '          ...init,',
  '          headers: requestHeaders,',
  '          body,',
  '        });',
  '        const data = await __readBody(response);',
  '        if (!response.ok) {',
  '          const detail = typeof data === "string" ? data : JSON.stringify(data);',
  '          throw new Error("Cumulocity request failed with " + response.status + " " + response.statusText + (detail ? ": " + detail : ""));',
  '        }',
  '        return data;',
  '      },',
  '    }),',
  '  });',
  '})());',
  '__fn().then(',
  `  (result) => console.log(${JSON.stringify(RESULT_PREFIX)} + JSON.stringify({ hasValue: result !== undefined, value: result ?? null })),`,
  `  (error) => console.error(${JSON.stringify(ERROR_PREFIX)} + (error instanceof Error ? error.message : String(error))),`,
  ');',
].join('\n')

function getRuntime() {
  if (!runtime) {
    runtime = new NodeRuntime({
      systemDriver: createNodeDriver({
        useDefaultNetwork: true,
        permissions: {
          network: () => ({ allow: true }),
        },
      }),
      runtimeDriverFactory: createNodeRuntimeDriverFactory(),
      memoryLimit: 64,
      cpuTimeLimitMs: 5000,
    })
  }

  return runtime
}

function formatResult(result: unknown): string {
  if (typeof result === 'string') {
    return result
  }

  if (typeof result === 'undefined') {
    return 'undefined'
  }

  try {
    return JSON.stringify(result, null, 2)
  } catch {
    return String(result)
  }
}

function normalizeFunctionCode(functionCode: string): string {
  let normalized = functionCode.trim()

  normalized = normalized
    .replace(/^```(?:js|javascript|ts|typescript)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()

  normalized = normalized.replace(/^export\s+default\s+/i, '').trim()

  return normalized
}

function getUserFunction(functionCode: string): (input: unknown) => unknown {
  const normalized = normalizeFunctionCode(functionCode)
  // eslint-disable-next-line no-new-func
  const evaluated = Function(`"use strict"; return (${normalized});`)()

  if (typeof evaluated !== 'function') {
    throw new TypeError('Code must evaluate to a function')
  }

  return evaluated as (input: unknown) => unknown
}

function buildExecuteScript(functionCode: string, tenantUrl: string, headers: Record<string, string>): string {
  const normalized = normalizeFunctionCode(functionCode)

  return executeScriptSuffix
    .split('__TENANT_URL__')
    .join(JSON.stringify(tenantUrl))
    .split('__AUTH_HEADERS__')
    .join(JSON.stringify(headers))
    .replace('__USER_FUNCTION__', normalized)
}

async function runExecuteScript(code: string): Promise<unknown> {
  let returnedResult: unknown
  let receivedResult = false
  let executionError: string | undefined
  let stdoutBuffer = ''
  let stderrBuffer = ''

  function processLine(line: string, channel: 'stdout' | 'stderr') {
    const trimmed = line.trim()
    if (!trimmed) {
      return
    }

    if (channel === 'stderr') {
      if (trimmed.startsWith(ERROR_PREFIX)) {
        executionError = trimmed.slice(ERROR_PREFIX.length)
      }
      return
    }

    if (!trimmed.startsWith(RESULT_PREFIX)) {
      return
    }

    const parsed = JSON.parse(trimmed.slice(RESULT_PREFIX.length)) as {
      hasValue?: boolean
      value?: unknown
    }

    if (!parsed.hasValue) {
      executionError = NO_RESULT_MESSAGE
      receivedResult = true
      returnedResult = undefined
      return
    }

    returnedResult = parsed.value
    receivedResult = true
  }

  function consumeBuffer(channel: 'stdout' | 'stderr') {
    const source = channel === 'stdout' ? stdoutBuffer : stderrBuffer
    const lines = source.split(/\r?\n/)
    const remainder = lines.pop() ?? ''

    for (const line of lines) {
      processLine(line, channel)
    }

    if (channel === 'stdout') {
      stdoutBuffer = remainder
    } else {
      stderrBuffer = remainder
    }
  }

  const result = await getRuntime().exec(code, {
    onStdio: (event) => {
      if (event.channel === 'stderr') {
        stderrBuffer += event.message
        consumeBuffer('stderr')
      } else {
        stdoutBuffer += event.message
        consumeBuffer('stdout')
      }
    },
  })

  if (stdoutBuffer) {
    processLine(stdoutBuffer, 'stdout')
  }

  if (stderrBuffer) {
    processLine(stderrBuffer, 'stderr')
  }

  if (result.code !== 0) {
    const errorMessage = `Execution failed with code ${result.code}${result.errorMessage ? `: ${result.errorMessage}` : ''}`
    throw new Error(errorMessage)
  }

  if (executionError) {
    throw new Error(executionError)
  }

  if (!receivedResult) {
    throw new Error('Execution completed without producing a result marker.')
  }

  return returnedResult
}

export async function query(functionCode: string): Promise<string> {
  const userFunction = getUserFunction(functionCode)
  const result = await userFunction(queryContext)
  return formatResult(result)
}

export async function execute(functionCode: string, input?: unknown): Promise<string> {
  const auth = await resolveC8yAuth(input)
  const authHeaders = createC8yAuthHeaders(auth)
  const result = await runExecuteScript(buildExecuteScript(functionCode, auth.tenantUrl, authHeaders))
  return formatResult(result)
}
