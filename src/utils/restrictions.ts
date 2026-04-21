import { createNodeDriver } from 'secure-exec'
import { parseURL } from 'ufo'
import {
    HTTP_METHODS,
    compileRestrictionRule,
    matchesCompiledRule,
    parseRestrictionRule,
    type CompiledRestrictionRule,
    type HttpMethod,
    type RestrictionMethod,
    type RestrictionRule,
} from './restriction-core'

export const RESTRICTION_EXTENSION_KEY = 'x-mc8yp-restrictions'
export const RESTRICTED_OPERATION_FLAG = 'x-mc8yp-restricted'
export const RESTRICTED_OPERATION_MESSAGE = 'x-mc8yp-restrictionMessage'
export const RESTRICTED_OPERATION_RULES = 'x-mc8yp-restrictionRules'
export const RESTRICTED_OPERATION_TYPE = 'x-mc8yp-restrictionType'
export const RESTRICTED_AGENT_NOTE = 'x-mc8yp-agentNote'

export {
    HTTP_METHODS,
    compileRestrictionRule,
    matchesCompiledRule,
    parseRestrictionRule,
    type CompiledRestrictionRule,
    type HttpMethod,
    type RestrictionMethod,
    type RestrictionRule,
}

const HTTP_METHOD_SET: ReadonlySet<string> = new Set(HTTP_METHODS)

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


export function createNetworkPermissionDecision(tenantUrl: string, request: NetworkPermissionRequest): NetworkPermissionDecision {
    const tenantHostname = new URL(tenantUrl).hostname

    if (request.op === 'connect') {
        return {
            allow: request.hostname === tenantHostname,
            reason: request.hostname === tenantHostname
                ? undefined
                : `Network connect blocked: only ${tenantHostname} is allowed in execute mode.`,
        }
    }

    return { allow: false, reason: `Unsupported network operation "${request.op}". Only "connect" is allowed.` }
}