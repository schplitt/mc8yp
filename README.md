# mc8yp - Full Cumulocity API Access for AI Agents

![Version](https://img.shields.io/npm/v/mc8yp)
![License](https://img.shields.io/npm/l/mc8yp)
![Node Version](https://img.shields.io/node/v/mc8yp)

mc8yp is a [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that gives AI agents access to the **full Cumulocity API surface** through a compact code-mode interface.

It supports the two bundled Cumulocity API families exposed by this project:

- **Core API**
- **DTM API**

Instead of limiting agents to a small fixed set of prebuilt tools, mc8yp gives them broad access to Cumulocity through two code-mode tools:

- `query` — inspect the bundled Core + DTM OpenAPI specs
- `execute` — call the live Cumulocity API

The result is an MCP integration where agents can work across the broader Cumulocity platform, while operators still keep **fine-grained control** over what is actually allowed at runtime.

mc8yp is available in two modes:

- **Cumulocity microservice mode** for production use with [AI Agent Manager](https://cumulocity.com/docs/ai/aim-introduction/)
- **CLI mode** for local debugging, testing, and development

## Why mc8yp

### Full API power for agents

mc8yp is built to give agents access to the **complete Cumulocity API surface available through the bundled Core and DTM specs**, instead of a tiny curated subset of actions.

That means agents are not blocked just because a specific endpoint was never wrapped as a custom MCP tool.

### Built for AI Agent Manager first

The primary production deployment model is **Cumulocity microservice mode**.

Deploy mc8yp as a Cumulocity microservice and expose `/mcp` to **AI Agent Manager**, so agents can use broad Cumulocity API capabilities inside the platform.

### Full power, controlled access

Broad capability does **not** have to mean unrestricted access.

mc8yp lets you constrain live API usage with:

- **restrictions** to deny specific methods or paths
- **allow rules** to define an allow-list
- **bundled OpenAPI disablement** for selected API families
- **sandboxed execution** and a tenant-host network boundary
- normal **Cumulocity permissions** from the authenticated user or service user

This makes setups like these possible:

- **read-only agents**
- **non-destructive production agents**
- agents limited to **inventory**, **alarms**, or other selected API families
- agents allowed to write only to a small approved set of endpoints

### Token efficiency comes from the small MCP surface

The agent gets broad API reach without requiring a huge fixed tool inventory. Instead of many endpoint-specific tools, mc8yp keeps the MCP surface compact and lets the model reason over the bundled OpenAPI specs.

## How it works

1. The agent uses `query` to inspect the bundled Cumulocity OpenAPI specs.
2. The agent decides which Core or DTM endpoint it needs.
3. The agent uses `execute` to call the live Cumulocity API.
4. mc8yp enforces configured restrictions and allow rules before sending the request.

## Deployment Modes

### 1. Cumulocity Microservice Mode (recommended)

Designed for deployment inside **Cumulocity IoT**.

In this mode, mc8yp exposes an HTTP MCP endpoint at `/mcp` and is intended for use with **AI Agent Manager**.

- deploy through Cumulocity microservice packaging
- integrate with [AI Agent Manager](https://cumulocity.com/docs/ai/aim-introduction/)
- use the service user's permissions automatically
- configure per-connection MCP policy with restrictions, allow rules, and bundled OpenAPI disablement

### 2. CLI Mode (local development)

CLI mode is ideal for:

- local debugging
- testing agent prompts and workflows
- validating access-policy setups before deployment
- working with MCP clients such as Claude Desktop

Credentials are stored in your operating system's secure credential manager.

## Quick Start: AI Agent Manager / Microservice

1. Download the latest release package from [GitHub Releases](https://github.com/schplitt/mc8yp/releases)
2. Upload the `.zip` in **Application Management**
3. Subscribe the application in your tenant
4. Connect your agent workflow to:

```txt
https://<tenant>.cumulocity.com/service/mc8yp-server/mcp
```

No extra tenant credential setup is required in microservice mode. The microservice uses Cumulocity's deployment environment and request authentication model.

### Example: production-safe read-only microservice connection

You can expose broad API knowledge to the agent while allowing only safe read access at runtime.

Example MCP endpoint configuration patterns:

```txt
/mcp?allow=GET:/inventory/**&allow=GET:/alarm/**&allow=GET:/measurement/**
```

Or with headers:

```http
POST /mcp HTTP/1.1
mc8yp-allow: GET:/inventory/**
mc8yp-allow: GET:/alarm/**
mc8yp-allow: GET:/measurement/**
```

## Quick Start: Local CLI

```sh
# Run directly (recommended)
pnpm dlx mc8yp

# Pick a specific bundled OpenAPI build for query
pnpm dlx mc8yp --spec 2025

# Or install globally
npm install -g mc8yp
mc8yp
```

### Credential Storage

The interactive `mc8yp creds add` flow uses masked password input and stores credentials in your operating system's secure credential manager.

- **macOS**: Keychain
- **Windows**: Credential Vault
- **Linux**: Secret Service API (libsecret)

### Managing Credentials

```sh
# Add credentials (prompts for tenant URL, username, and a masked password)
pnpm dlx mc8yp creds add

# List stored credentials
pnpm dlx mc8yp creds list

# Remove stored credentials
pnpm dlx mc8yp creds remove
```

### Active Tenant Flow

Adding credentials does not automatically activate a tenant. CLI sessions only run `query` against live tenant data and `execute` against the live API once a tenant has been selected via the `set-active-tenant` MCP tool.

First-time setup an agent will perform once the MCP client is connected:

1. Call `cli-status` to see stored credentials and the current active tenant.
2. Call `set-active-tenant` with one of the tenant URLs from `cli-status`. The selection is written to `~/.config/mc8yp/active-tenant.json` and re-applied automatically on every subsequent CLI start.
3. Call `query` and `execute` as needed. The query footer and execute marker keep the active tenant visible on every result.

To switch tenants mid-session, call `set-active-tenant` again with the new URL. To deliberately stop working against any tenant and just browse the bundled OpenAPI snapshots, call `set-active-tenant` with `tenantUrl: null`. In that state `query` continues to work against every bundled spec and `execute` returns a missing-auth error — so an agent cannot accidentally hit a tenant it has not selected.

If the stored credentials for the active tenant are removed (for example by `mc8yp creds remove`), the next `cli-status` call — or the next CLI restart — detects the drift and automatically resets the active tenant to `(none)`, preventing stale auth headers from going on the wire.

### Connecting a Local MCP Client

For Claude Desktop or any MCP client, add:

```json
{
  "servers": {
    "mc8yp": {
      "type": "stdio",
      "command": "pnpm",
      "args": ["dlx", "mc8yp"]
    }
  }
}
```

Example with read-only access rules:

```json
{
  "servers": {
    "mc8yp": {
      "type": "stdio",
      "command": "pnpm",
      "args": [
        "dlx",
        "mc8yp",
        "-a",
        "GET:/inventory/**",
        "-a",
        "GET:/alarm/**",
        "-a",
        "GET:/measurement/**"
      ]
    }
  }
}
```

## Bundled OpenAPI Coverage

The `query` tool exposes the bundled OpenAPI snapshots included by this project:

- **Core** snapshots: `release`, `2026`, `2025`, and `2024`
- **DTM** snapshot: bundled alongside each supported core build

In CLI mode, use `--spec` or `-s` to choose which bundled **core** OpenAPI snapshot `query` exposes:

```sh
# Default: latest bundled release build
mc8yp

# Explicitly use the 2025 bundled build
mc8yp --spec 2025

# Short form
mc8yp -s 2024
```

This only changes the bundled OpenAPI data that `query` sees. The `execute` tool still calls the live Cumulocity API of the selected tenant or deployed service environment.

## Tools & Prompts

### Tools

| Tool                | Description                                                                                                                                                                                                                                                                       |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `query`             | Search and inspect the bundled and discovered OpenAPI specs by running a JavaScript function expression. The sandbox exposes `coreSpec` and `serviceSpecs` (microservice APIs keyed by `contextPath`).                                                                            |
| `execute`           | Execute JavaScript against the live Cumulocity API. Provide an async JavaScript function expression. A top-level `cumulocity` binding provides `cumulocity.request({ method, path, body?, headers? })`. Return the final value from that function.                                |
| `cli-status`        | _(CLI mode only)_ Read the active tenant (or note that none is set) and the list of stored credentials from your system keyring. Auto-clears the active tenant if its credentials have been removed. Call this before `query` / `execute` so you know which tenant they will hit. |
| `set-active-tenant` | _(CLI mode only)_ Select the tenant `query` and `execute` operate against, persisted to `~/.config/mc8yp/active-tenant.json` across CLI restarts. Pass `tenantUrl: null` to clear the selection and fall back to browsing the bundled OpenAPI snapshots.                          |

Both code-mode tools run in a sandboxed V8 runtime ([@iso4/sandbox](https://github.com/schplitt/iso4)) hosted in a separate Rust subprocess.

- `query` returns JSON text for easier inspection of OpenAPI data. Every result ends with a footer line naming the active tenant (or noting there is none) so the agent can verify which tenant the visible specs reflect.
- `execute` returns the successful function result in [Toon format](https://github.com/nicepkg/toon). If execution is blocked or fails, it returns a plain text message instead. In CLI mode every `execute` result is prefixed with an `Executed against tenant: <url>` marker line so the active tenant is always visible — the active tenant is global to a CLI session and can be flipped between calls by `set-active-tenant`.

### Prompts

| Prompt            | Description                                                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `code-mode-guide` | Full reference for the `query` and `execute` tools, including available types, examples, and access-policy info for the current connection. |

## Execute Input Shape

The `execute` tool expects an async function expression, not module source with `export default`.

Recommended shape:

```js
async () => {
  return await cumulocity.request({
    method: 'GET',
    path: '/inventory/managedObjects?pageSize=5',
  })
}
```

You can also perform intermediate processing before returning the final value:

```js
async () => {
  const devices = await cumulocity.request({
    method: 'GET',
    path: '/inventory/managedObjects?pageSize=20&withTotalPages=true',
  })

  return devices.managedObjects?.map((device) => ({ id: device.id, name: device.name }))
}
```

## API Access Policy

mc8yp supports two per-connection rule types:

- **Restrictions** — deny rules that block matching API operations
- **Allow rules** — allow-list rules that permit matching API operations and block everything else when at least one allow rule is configured

If both apply to the same operation, **restrictions take priority**.

This is what makes it possible to expose broad API capability while still keeping an agent in a **read-only** or otherwise **non-destructive** operating mode.

Example: allowing `/inventory/**` but restricting `/inventory/managedObjects` still blocks `/inventory/managedObjects`.

Both rule types use the same syntax.

### Restrictions

Restrictions are deny rules that block specific API operations.

### Allow Rules

Allow rules are the inverse of restrictions. They define what is permitted. When one or more allow rules are configured, any operation that does not match at least one allow rule is blocked.

### Rule Format

A restriction or allow rule can be written in either of these forms:

```txt
<path-pattern>
<method>:<path-pattern>
```

- **Without a method prefix** — matches all HTTP methods for matching paths
- **With a method prefix** — matches only that method (for example `GET:`, `DELETE:`, `POST:`)
- **The `:` separator is only present when a method prefix is provided**
- **Supported methods** — `DELETE`, `GET`, `HEAD`, `OPTIONS`, `PATCH`, `POST`, `PUT`, `TRACE`, or `*`
- Method names are case-insensitive when parsed (`get:/inventory/**` becomes `GET:/inventory/**`)

### Path Pattern Syntax

Patterns are matched against the request **pathname**.

- Query strings and fragments are **not allowed in rule patterns**
- Incoming request query strings are ignored for matching, so `/inventory/**` also matches requests such as `/inventory?pageSize=5`
- Patterns must start with `/`
- Matching is path-segment aware: `/` separates segments

Supported wildcards:

- `*` — wildcard **inside a single path segment**. It matches any characters except `/`
- `**` — recursive wildcard across **zero or more whole path segments**. `**` must be its own complete segment

### Path Pattern Examples

| Pattern               | Matches                                                     | Does Not Match                             |
| --------------------- | ----------------------------------------------------------- | ------------------------------------------ |
| `/inventory`          | `/inventory`                                                | `/inventory/managedObjects`                |
| `/inventory/**`       | `/inventory`, `/inventory/managedObjects`, `/inventory/x/y` | `/alarm/alarms`                            |
| `/i*`                 | `/inventory`, `/identity`, `/i`                             | `/inventory/managedObjects`                |
| `/i*/**`              | `/inventory`, `/inventory/managedObjects`, `/identity/x`    | `/alarm/alarms`                            |
| `/inventory/m*`       | `/inventory/managedObjects`, `/inventory/measurements`      | `/inventory/events`, `/inventory/m/x`      |
| `/inventory/*/child`  | `/inventory/device-1/child`, `/inventory/x/child`           | `/inventory/child`, `/inventory/a/b/child` |
| `/inventory/**/child` | `/inventory/child`, `/inventory/a/b/child`                  | `/inventory/a/b/sibling`                   |

### Common Rule Examples

| Rule                             | Restriction Effect                                           | Allow-list Effect                                             |
| -------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------- |
| `/inventory/**`                  | Block all methods on `/inventory` and everything below it    | Permit all methods on `/inventory` and everything below it    |
| `DELETE:/inventory/**`           | Block only DELETE on `/inventory` and everything below it    | Permit only DELETE on `/inventory` and everything below it    |
| `/alarm/alarms`                  | Block all methods on the exact path `/alarm/alarms`          | Permit all methods on the exact path `/alarm/alarms`          |
| `GET:/measurement/measurements`  | Block only GET on the exact path `/measurement/measurements` | Permit only GET on the exact path `/measurement/measurements` |
| `POST:/inventory/managedObjects` | Block creating new managed objects                           | Permit creating new managed objects                           |
| `/i*/**`                         | Block all routes whose first path segment starts with `i`    | Permit all routes whose first path segment starts with `i`    |
| `/user/**`                       | Block all user management paths                              | Permit all user management paths                              |

### Important Notes

- `/inventory/**` already matches `/inventory` itself, so you do **not** need both `/inventory` and `/inventory/**`
- `/i**` is **not valid** because `**` must be its own segment. Use `/i*/**` if you want to match a first segment starting with `i` and everything below it
- `*:/inventory/**` is allowed and means the same thing as `/inventory/**`
- Root paths across the bundled Core and DTM specs are intentionally treated as disjoint, so path-based restriction and allow rules are enough for request enforcement
- Rule patterns may not contain empty segments (`//`), `.` or `..` segments, query strings, or fragments

### CLI Mode

Pass restrictions and allow rules as CLI arguments.

Repeat `-r`, `--restrict`, or `--restriction` for deny rules:

```sh
# Block all inventory access
mc8yp -r "/inventory/**"

# Block deletes on inventory and all alarm access
mc8yp -r "DELETE:/inventory/**" -r "/alarm/**"

# Same thing using the long alias
mc8yp --restrict "/user/**"
```

Repeat `-a`, `--allow`, or `--allowed` for allow rules:

```sh
# Only permit inventory access
mc8yp -a "/inventory/**"

# Permit GET inventory access and POST alarms
mc8yp --allow "GET:/inventory/**" --allowed "POST:/alarm/**"

# Allow inventory broadly, but still block one path with a restriction
mc8yp -a "/inventory/**" -r "/inventory/managedObjects"
```

### Microservice Mode (HTTP)

Pass restrictions as `restriction`, `restrict`, or `r` query parameters on the MCP endpoint URL.
Pass allow rules as `allowed`, `allow`, or `a` query parameters.
You can also send project-scoped HTTP headers to avoid conflicts with well-known headers:

- `mc8yp-restriction` for deny rules
- `mc8yp-allow` for allow-list rules

Both headers accept either repeated header instances or a comma-separated list of values. Query parameters and headers can be combined on the same connection.

```txt
/mcp?restriction=/inventory/**&restrict=DELETE:/alarm/**
/mcp?r=/inventory/**&r=DELETE:/alarm/**
/mcp?allow=/inventory/**&allowed=POST:/alarm/**
```

```http
POST /mcp HTTP/1.1
Authorization: Bearer <token>
mc8yp-restriction: /inventory/**
mc8yp-restriction: DELETE:/alarm/**
mc8yp-allow: GET:/measurement/**
```

### How Access Policy Works

1. **Query visibility**: The `query` tool exposes resolved OpenAPI specs through `coreSpec` and `serviceSpecs`. With an active tenant, services not installed on that tenant are dropped from the sandbox surface so the agent only sees what is actually reachable. In CLI mode with no active tenant, every bundled snapshot is exposed for reference browsing only — `execute` is unavailable in that state.

2. **Request enforcement**: The host-side bridge that backs `cumulocity.request` evaluates restrictions and allow rules before any HTTP request leaves the host. Matching deny rules block first. If any allow rules are configured, requests must also match at least one allow rule. Blocked requests never reach Cumulocity.

3. **Network boundary**: The sandbox itself has no `fetch` global. Sandbox code reaches the tenant only through the host-bridged `cumulocity.request` helper, which injects auth, evaluates restriction and allow rules, and issues the live HTTP call via [@iso4/fetch](https://www.npmjs.com/package/@iso4/fetch) (DNS-pinned, SSRF-hardened). Every other network egress is unavailable to the agent.

When an `execute` request is blocked by MCP connection policy, the tool returns explanatory text stating whether the operation was denied by a restriction or blocked because it is outside the configured allow list, no request was sent to Cumulocity, and retrying through the same connection will not help.

## Build And Packaging

The repository bundles multiple OpenAPI specs for CLI use and builds one microservice server bundle per configured build version.

### Build Outputs

`pnpm build` produces:

- CLI bundle in `dist/`
- Versioned server bundles in `.output/release/`, `.output/2026/`, `.output/2025/`, and `.output/2024/`

The build matrix is driven by [`openapi-builds.json`](openapi-builds.json). Core snapshots live under `openapi/core/`, DTM snapshots live under `openapi/dtm/`, and each server bundle contains the configured combination for that build.

### Release Packaging

Use the dedicated packaging command after `pnpm build` to create Docker-based Cumulocity release zips:

The packaging step writes a temporary generated Dockerfile under `.c8y/`, copies the selected versioned server bundle into `/app/server/`, and installs production dependencies inside the Linux image with pnpm before copying them into the runtime stage. This avoids cross-platform native optional dependency issues when release artifacts are built on macOS but deployed as `linux/amd64` microservices.

The deployed HTTP transport uses POST-only streamable HTTP (`GET /mcp` intentionally returns `405`) because some reverse proxies and microservice ingress layers do not keep the optional long-lived SSE notification channel stable enough for reliable MCP tool calls.

```sh
pnpm package:microservices
```

That command creates one zip per bundled server variant in the repository root, for example:

- `mc8yp-core-release-dtm-v1.2.3.zip`
- `mc8yp-core-2026-dtm-v1.2.3.zip`
- `mc8yp-core-2025-dtm-v1.2.3.zip`
- `mc8yp-core-2024-dtm-v1.2.3.zip`

The GitHub release workflow uses that packaging command when building tagged releases.

## Development

### Prerequisites

- Node.js ≥24.0.0
- pnpm

### Setup

```sh
pnpm install
pnpm lint
pnpm typecheck
pnpm build
```

### Testing

```sh
# Run tests
pnpm test:run

# Run benchmarks
pnpm test:bench
```

### Run Locally From Source

Build first, then point your MCP client at the compiled CLI:

```sh
pnpm build
```

Then add to your local MCP client configuration:

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

## License

MIT
