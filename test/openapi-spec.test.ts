/**
 * Sanity tests for the self-describing `openapi.json` that ships with
 * mc8yp's microservice manifest. The spec covers only the non-MCP HTTP
 * surface (`/refresh-apis`, `/health`) and is loaded at runtime by the
 * H3 server in src/index.ts via the `GET /openapi.json` route.
 *
 * These tests are not a schema validator — they just catch the realistic
 * regressions (file deleted, route removed, /mcp accidentally documented
 * here) that would silently break the discovery flow once mc8yp itself is
 * subscribed on a tenant.
 */
import { describe, expect, it } from 'vitest'
import cumulocityManifest from '../cumulocity.json' with { type: 'json' }
import openApiSpec from '../openapi.json' with { type: 'json' }

describe('openapi.json', () => {
  it('declares the routes the H3 server actually exposes', () => {
    expect(openApiSpec.paths).toBeDefined()
    expect(openApiSpec.paths['/refresh-apis']).toBeDefined()
    expect(openApiSpec.paths['/refresh-apis'].post).toBeDefined()
    expect(openApiSpec.paths['/health']).toBeDefined()
    expect(openApiSpec.paths['/health'].get).toBeDefined()
  })

  it('does NOT document the MCP endpoint — MCP discovery is out-of-band', () => {
    expect(openApiSpec.paths['/mcp']).toBeUndefined()
  })

  it('uses OpenAPI 3.x so Cumulocity discovery treats it as a spec', () => {
    expect(openApiSpec.openapi).toMatch(/^3\./)
  })
})

describe('cumulocity.json wiring', () => {
  it('references openapi.json so mc8yp self-discovers when subscribed', () => {
    expect((cumulocityManifest as { openApiSpec?: string }).openApiSpec).toBe('openapi.json')
  })
})
