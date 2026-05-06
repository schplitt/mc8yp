# mc8yp - Cumulocity IoT MCP Server

![Version](https://img.shields.io/npm/v/mc8yp)
![License](https://img.shields.io/npm/l/mc8yp)
![Node Version](https://img.shields.io/node/v/mc8yp)

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that gives AI agents full access to the Cumulocity IoT platform through code execution. Instead of exposing dozens of fixed tools, the server provides two code-mode tools — `query` and `execute` — that let the agent write JavaScript to inspect the core OpenAPI spec and call any API endpoint.

**Two Deployment Modes:**

- **CLI Mode**: Run locally with `pnpm dlx mc8yp` for development and testing with AI agents like Claude Desktop. Uses your system's secure keyring to store credentials.
- **Microservice Mode**: Deploy as a Cumulocity microservice for production use. The MCP endpoint (`/mcp`) integrates with Cumulocity's agents manager, using the service user's permissions automatically.

## Installation

### CLI Mode (Local Development & Testing)

```sh
# Run directly (recommended)
pnpm dlx mc8yp

# Pick a specific core OpenAPI snapshot for query
pnpm dlx mc8yp --spec 2025

# Or install globally
npm install -g mc8yp
mc8yp
```

**Credential Storage:**
Credentials are stored using your operating system's secure credential manager:

- **macOS**: Keychain
- **Windows**: Credential Vault
- **Linux**: Secret Service API (libsecret)

### Microservice Mode (Production Deployment)

Designed **exclusively for deployment on Cumulocity IoT**. The server exposes an HTTP endpoint at `/mcp` that integrates with Cumulocity's agents manager, automatically using the service user's credentials and permissions.

1. Download the latest release package from [GitHub Releases](https://github.com/schplitt/mc8yp/releases)
2. Upload the `.zip` to Cumulocity via **Application Management**
3. Subscribe to the application in your tenant
4. The MCP server will be available at: `https://<tenant>.cumulocity.com/service/mc8yp-server/mcp`

No additional credential configuration needed — the microservice uses Cumulocity's built-in service user authentication.

## Usage

### Managing Credentials (CLI)

```sh
# Add credentials (prompts for tenant URL, username, password)
pnpm dlx mc8yp creds add

# List stored credentials
pnpm dlx mc8yp creds list

# Remove credentials
pnpm dlx mc8yp creds remove
```

### Selecting The Core OpenAPI Snapshot (CLI)

Use `--spec` or `-s` to choose which bundled core OpenAPI snapshot the `query` tool exposes.

Supported values are `release`, `2026`, `2025`, and `2024`.

```sh
# Default: latest bundled release snapshot
mc8yp

# Explicitly use the 2025 core OpenAPI snapshot
mc8yp --spec 2025

# Short form
mc8yp -s 2024
```

This only affects the `query` tool's OpenAPI view. The `execute` tool still calls the live Cumulocity API of the selected tenant or deployed service environment.

### Connecting to AI Agents

For Claude Desktop or any MCP client, add to your MCP configuration:

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

With restrictions (see [API Restrictions](#api-restrictions)):

```json
{
  "servers": {
    "mc8yp": {
      "type": "stdio",
      "command": "pnpm",
      "args": ["dlx", "mc8yp", "-r", "/alarm/**", "-r", "DELETE:/inventory/**"]
    }
  }
}
```

## Tools & Prompts

### Tools

| Tool               | Description                                                                                                                                                                                                                                        |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `query`            | Search and inspect the bundled Cumulocity core OpenAPI spec by running a JavaScript module. The spec is injected as a top-level `spec` binding. Export the result with `export default`.                                                           |
| `execute`          | Execute JavaScript against the live Cumulocity API. Provide an async JavaScript function expression. A top-level `cumulocity` binding provides `cumulocity.request({ method, path, body?, headers? })`. Return the final value from that function. |
| `list-credentials` | _(CLI mode only)_ List stored credentials from your system keyring.                                                                                                                                                                                |

Both code-mode tools run in a sandboxed runtime ([secure-exec](https://github.com/nicepkg/secure-exec)).

- `query` returns JSON text for easier inspection of OpenAPI data.
- `execute` returns the successful function result in [Toon format](https://github.com/nicepkg/toon). If execution is blocked or fails, it returns a plain text message instead.

### Execute Input Shape

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

### Prompts

| Prompt            | Description                                                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `code-mode-guide` | Full reference for the `query` and `execute` tools, including available types, examples, and access-policy info for the current connection. |

## API Access Policy

mc8yp supports two per-connection rule types:

- **Restrictions** — deny rules that block matching API operations
- **Allow rules** — allow-list rules that permit matching API operations and block everything else when at least one allow rule is configured

If both apply to the same operation, **restrictions take priority**.

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
- Rule patterns may not contain empty segments (`//`), `.` or `..` segments, query strings, or fragments

### CLI Mode

Pass restrictions and allow rules as CLI arguments.

Repeat `-r`, `--restrict`, or `--restriction` for deny rules:

```sh
# Block all inventory access
mc8yp -r "/inventory/**"

# Block deletes on inventory and all alarm access
mc8yp -r "DELETE:/inventory/**" -r "/alarm/**"

# Block everything under user management
mc8yp --restriction "/user/**"

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

```
/mcp?restriction=/inventory/**&restrict=DELETE:/alarm/**
/mcp?r=/inventory/**&r=DELETE:/alarm/**
/mcp?allow=/inventory/**&allowed=POST:/alarm/**
/mcp?a=/inventory/**&r=/inventory/managedObjects
```

### How Access Policy Works

1. **Query visibility**: The `query` tool exposes the raw bundled OpenAPI snapshot for the current MCP connection. It does not annotate or filter operations based on restrictions or allow rules.

2. **Sandbox request enforcement**: The `execute` tool checks restrictions and allow rules inside the generated sandbox request helper, where the actual HTTP method and normalized path are both available. Matching deny rules block first. If any allow rules are configured, requests must also match at least one allow rule.

3. **Network boundary**: The secure-exec permission layer independently restricts network access to the configured tenant host. Other network operations are denied.

When an `execute` request is blocked by MCP connection policy, the tool returns explanatory text stating whether the operation was denied by a restriction or blocked because it is outside the configured allow list, no request was sent to Cumulocity, and retrying through the same connection will not help.

## Build And Packaging

The repository bundles multiple core OpenAPI snapshots for CLI use and builds one microservice server bundle per snapshot version.

### Build Outputs

`pnpm build` produces:

- CLI bundle in `dist/`
- Versioned server bundles in `.output/release/`, `.output/2026/`, `.output/2025/`, and `.output/2024/`

The versions built are driven by [`openapi-versions.json`](openapi-versions.json). Each server bundle contains only its own `core-openapi/<version>.json` snapshot.

### Release Packaging

Use the dedicated packaging command after `pnpm build` to create Docker-based Cumulocity release zips:

The packaging step writes a temporary generated Dockerfile under `.c8y/`, copies the selected versioned server bundle into `/app/server/`, and installs production dependencies inside the Linux image with pnpm before copying them into the runtime stage. This avoids cross-platform native optional dependency issues when release artifacts are built on macOS but deployed as `linux/amd64` microservices.

The deployed HTTP transport uses POST-only streamable HTTP (`GET /mcp` intentionally returns `405`) because some reverse proxies and microservice ingress layers do not keep the optional long-lived SSE notification channel stable enough for reliable MCP tool calls.

```sh
pnpm package:microservices
```

That command creates one zip per bundled server variant in the repository root, for example:

- `mc8yp-release-v1.2.3.zip`
- `mc8yp-2026-v1.2.3.zip`
- `mc8yp-2025-v1.2.3.zip`
- `mc8yp-2024-v1.2.3.zip`

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

### Run Locally

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
