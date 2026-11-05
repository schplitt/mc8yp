# Advanced

## How it works

1. mc8yp discovers every microservice installed on the tenant that declares an OpenAPI spec, and derives typed method namespaces from those alongside the bundled Core (+ DTM) specs.
2. Inside a `codemode` run, the agent finds the right method with `codemode.search`, inspects its exact input/output types with `codemode.describe`, and reads prose documentation (domain query languages, parameter syntax) with `docs.search`/`docs.read`.
   `codemode.describe` works at three altitudes: no target lists the namespaces on this tenant, `describe("<namespace>")` lists every method in one namespace one line each — the callable target (`c8y.getAlarmCollectionResource`), `METHOD /path`, summary, no types — and `describe("<namespace>.<method>")` renders the full input/output types. The namespace listing is the survey step for when search keeps missing a domain's vocabulary; all ~250 core methods cost roughly 7k tokens, which is why full types stay method-level.
3. In the same run, the agent calls the live Cumulocity API through the derived methods (`c8y.<method>({ ... })`). The namespaces are the complete surface — there is no raw-request escape hatch.
4. mc8yp enforces configured restrictions and allow rules before any request leaves the host — blocked operations are also omitted from discovery entirely.

## Live API discovery

When a tenant is active, mc8yp asks Cumulocity which applications the tenant is subscribed to, reads the `openApiSpec` declaration from each application manifest, fetches the spec, prefixes its paths with the service's `contextPath`, and exposes it to the sandbox as a typed namespace named after the contextPath. Results are cached per tenant for 30 minutes.

The practical effect: **any Cumulocity microservice that ships an OpenAPI spec is automatically usable by the agent**, whether it is one of the bundled snapshots, a Cumulocity-provided service, or a custom microservice built in-house. The bundled specs are just guaranteed offline coverage; the discovery layer fills in everything else.

The same discovery run also picks up MCP servers declared via `exposeMcpServers` (type `http`) and fetches their tool lists. A service exposing both an MCP server and an OpenAPI spec is wrapped as an MCP namespace; per connection you can opt services back to their spec with the `mc8yp-no-mcp` header / `noMcp` query param (server mode) or `--no-mcp` (CLI) — pass `*` for all services or a comma-separated contextPath list. Wrapped MCP tools run with the end user's credentials; elicitation and sampling are NOT forwarded (mc8yp advertises no such capabilities, so compliant servers use their fallbacks).

When a new service is subscribed mid-session, CLI agents can call the `status` tool with `refresh: true` to bust the cache without waiting for the 30-minute window. Server mode does not yet expose an in-protocol refresh trigger — use the `POST /refresh-apis` HTTP route from ops/CI scripts that sit outside the MCP protocol.
## Tools and prompts

| Tool                | Description                                                                                                                                                                                                                                                                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `codemode`          | Run an async JavaScript function in a sandbox with discovery (`codemode.search`/`describe`), documentation (`docs.search`/`read`), and typed API namespaces (`c8y`, per-service globals) available. Returns the function result in [Toon format](https://github.com/nicepkg/toon).                                                                      |
| `status`            | _(CLI only)_ Show the active tenant, stored credentials, and the API namespaces currently visible. Auto-clears the active tenant if its credentials are gone. Pass `refresh: true` to bust the 30-minute discovery cache and re-run discovery for the active tenant — useful right after (un)subscribing a microservice. Noop when no tenant is active. |
| `set-active-tenant` | _(CLI only)_ Select the tenant `codemode` operates against. Pass `tenantUrl: null` to clear.                                                                                                                                                                                                                                                            |

The codemode tool runs in a sandboxed V8 runtime ([`@iso4/sandbox`](https://github.com/schplitt/iso4)) hosted in a separate Rust subprocess. The sandbox has no `fetch` global — every live call is dispatched host-side through a hardened request funnel built on [`@iso4/fetch`](https://www.npmjs.com/package/@iso4/fetch), which injects auth, enforces the access policy, and parses responses before anything reaches the sandbox.

The **`code-mode-guide`** prompt contains the full reference for the codemode tool, including types, examples, and the active access policy for the current connection.

## The sandbox surface

```js
async () => {
  // 1. Find the method
  const { results } = await codemode.search('managed objects')

  // 2. Inspect its exact typed interface (input/output types, per-field docs)
  const { content } = await codemode.describe(results[0].target)

  // 3. When parameter syntax is unknown, search the prose documentation
  const hits = await docs.search('inventory query language')
  const grammar = await docs.read(hits[0].id)

  // 4. Call it — path/query/header params and `body` share one flat object
  const devices = await c8y.getManagedObjectCollectionResource({
    query: '$filter=(type eq \'c8y_Device\')',
    pageSize: 20,
  })

  return devices.managedObjects?.map((d) => ({ id: d.id, name: d.name }))
}
```

There is deliberately no raw-request escape hatch — the typed namespaces are the complete surface. Whether a namespace wraps an OpenAPI spec or an MCP server is invisible to the agent; the backing protocol is an operator concern.

Operations can be hidden from derivation and discovery by annotating them in the OpenAPI spec with the vendor extension `x-mc8yp-exclude: true` — with no escape hatch, exclusion is absolute for the sandbox.
## The `sandbox` shell (microservice only, opt-in)

> **Experimental.** Available in deployed microservice mode only, and **disabled by default**; not exposed in the local CLI (agent harnesses there bring their own file I/O).

In microservice mode, codemode has one more optional global — `sandbox` — an in-memory shell with a virtual filesystem for wrangling data you fetched from the API (`jq`, `awk`, `sed`, `grep`, `sort`, `uniq`, `cut`, `sqlite3`, …). It has **no network access and no host filesystem access** — it never reaches Cumulocity. Fetch with `c8y`/service namespaces, process in the sandbox, read the result back.

**It is off unless you turn it on.** Enable it per connection with the `mc8yp-enable-sandbox` header or the `enableSandbox` query param (any of empty, `*`, or `true`). Without it, `sandbox` is absent — same as CLI mode.

```js
async () => {
  const alarms = await c8y.getAlarmCollectionResource({ pageSize: 2000 })
  await sandbox.writeFile('/alarms.json', JSON.stringify(alarms.alarms ?? []))
  const { stdout } = await sandbox.exec('jq "group_by(.severity) | map({severity: .[0].severity, count: length})" /alarms.json')
  return JSON.parse(stdout)
}
```

The surface mirrors [Flue's `SandboxApi`](https://flueframework.com/docs/api/sandbox-api/): `readFile`, `readFileBuffer`, `writeFile`, `stat`, `readdir`, `exists`, `mkdir`, `rm`, `exec`, plus an mc8yp-specific `clear()` that wipes the filesystem. It is backed by a swappable adapter (currently [`just-bash`](https://github.com/vercel-labs/just-bash), core shell only) so the provider can be replaced later without changing agent-facing code.

**Lifecycle:** one in-memory sandbox per MCP session, so files persist across `codemode` calls within a session. It is evicted from memory 15 minutes after its last use (or immediately via `sandbox.clear()`). Nothing is ever written to disk, and sessions never share state. (Cross-call persistence relies on your MCP client maintaining the `mcp-session-id`, which standard clients do.)
## OpenAPI coverage

What the agent sees through codemode discovery comes from two layers:

1. **Live-discovered specs** — every microservice subscribed on the active tenant whose manifest declares an `openApiSpec`. Discovered at runtime, cached for 30 minutes per tenant, exposed as a typed namespace named after the contextPath. This works for any service, not just the ones bundled here.
2. **Bundled snapshots** — shipped with the build so Core and DTM are always available even when discovery hasn't run yet:
   - **Core** snapshots: `release`, `2026`, `2025`, `2024`
   - **DTM** snapshot bundled alongside each supported core build

With an active tenant, services not installed on that tenant get no namespace at all, so the agent only sees what is actually reachable.

In CLI mode, pick which **core** snapshot the `c8y` namespace derives from:

```sh
mc8yp              # default: latest bundled release
mc8yp --spec 2025  # use the 2025 snapshot
mc8yp -s 2024      # short form
```

This only affects the bundled core view. Live calls always hit the Cumulocity API of the selected tenant or deployed service environment.

## Running from source

Run locally from source by pointing your MCP client at the built CLI:

```json
{
  "servers": {
    "local_mc8yp": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/your/project/dist/cli.mjs"]
    }
  }
}
```

## Release packaging

Produces one Docker-based Cumulocity zip per bundled server variant in the repository root, e.g.:

- `mc8yp-core-release-dtm-v1.2.3.zip`
- `mc8yp-core-2026-dtm-v1.2.3.zip`
- `mc8yp-core-2025-dtm-v1.2.3.zip`
- `mc8yp-core-2024-dtm-v1.2.3.zip`

The packaging step writes a temporary generated Dockerfile under `.c8y/`, copies the selected versioned server bundle into `/app/server/`, and installs production dependencies inside a `linux/amd64` Docker image so the per-platform native binaries of `@iso4/sandbox` resolve correctly. The deployed HTTP transport is POST-only (`GET /mcp` returns `405`) because some reverse proxies and Cumulocity ingress layers do not keep a long-lived SSE channel stable enough for reliable MCP tool calls.

The build matrix is driven by [`openapi-builds.json`](openapi-builds.json). Core snapshots live under `openapi/core/`, DTM snapshots under `openapi/dtm/`.
