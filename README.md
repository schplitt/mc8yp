# mc8yp - Cumulocity IoT MCP Server

![Version](https://img.shields.io/npm/v/mc8yp)
![License](https://img.shields.io/npm/l/mc8yp)
![Node Version](https://img.shields.io/node/v/mc8yp)

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that gives AI agents full access to the Cumulocity IoT platform through code execution. Instead of exposing dozens of fixed tools, the server provides two code-mode tools — `query` and `execute` — that let the agent write JavaScript to inspect the OpenAPI spec and call any API endpoint.

**Two Deployment Modes:**

- **CLI Mode**: Run locally with `pnpm dlx mc8yp` for development and testing with AI agents like Claude Desktop. Uses your system's secure keyring to store credentials.
- **Microservice Mode**: Deploy as a Cumulocity microservice for production use. The MCP endpoint (`/mcp`) integrates with Cumulocity's agents manager, using the service user's permissions automatically.

## Installation

### CLI Mode (Local Development & Testing)

```sh
# Run directly (recommended)
pnpm dlx mc8yp

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

| Tool | Description |
|------|-------------|
| `query` | Search and inspect the Cumulocity OpenAPI spec by running a JavaScript module. The spec is injected as a top-level `spec` binding. Export the result with `export default`. |
| `execute` | Execute JavaScript against the live Cumulocity API. Provide an async JavaScript function expression. A top-level `cumulocity` binding provides `cumulocity.request({ method, path, body?, headers? })`. Return the final value from that function. |
| `list-credentials` | *(CLI mode only)* List stored credentials from your system keyring. |

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

| Prompt | Description |
|--------|-------------|
| `code-mode-guide` | Full reference for the `query` and `execute` tools, including available types, examples, and restriction info for the current connection. |

## API Restrictions

Restrictions are deny rules that block specific API operations. They can be applied per-connection to limit what an AI agent can access.

### Rule Format

```
[METHOD:]<path-pattern>
```

- **Without a method prefix** — blocks all HTTP methods for matching paths
- **With a method prefix** — blocks only that method (e.g. `GET:`, `DELETE:`, `POST:`)
- **Path patterns** support `*` (single segment wildcard) and `**` (recursive wildcard)
- Query strings and fragments are not allowed in patterns

### Examples

| Rule | Effect |
|------|--------|
| `/inventory/**` | Block all methods on all inventory paths |
| `DELETE:/inventory/**` | Block only DELETE on inventory paths |
| `/alarm/alarms` | Block all methods on the exact path `/alarm/alarms` |
| `GET:/measurement/measurements` | Block only GET on measurements |
| `POST:/inventory/managedObjects` | Block creating new managed objects |
| `/user/**` | Block all user management |

### CLI Mode

Pass restrictions as CLI arguments. Repeat `-r` / `--restriction` for multiple rules:

```sh
# Block all inventory access
mc8yp -r "/inventory/**"

# Block deletes on inventory and all alarm access
mc8yp -r "DELETE:/inventory/**" -r "/alarm/**"

# Block everything under user management
mc8yp --restriction "/user/**"
```

### Microservice Mode (HTTP)

Pass restrictions as `restriction` query parameters on the MCP endpoint URL:

```
/mcp?restriction=/inventory/**&restriction=DELETE:/alarm/**
```

### How Restrictions Work

1. **OpenAPI spec annotation**: The `query` tool annotates blocked operations in the spec with `x-mc8yp-restricted` and related `x-mc8yp-*` metadata fields. The operations remain visible so the agent understands what exists, but they are clearly marked as blocked.

2. **Sandbox request enforcement**: The `execute` tool checks restrictions inside the generated sandbox request helper, where the actual HTTP method and normalized path are both available. Matching requests are blocked before any `fetch` is attempted.

3. **Network boundary**: The secure-exec permission layer independently restricts network access to the configured tenant host. Other network operations are denied.

When an `execute` request is blocked by MCP restrictions, the tool returns explanatory text stating that the operation was intentionally denied by MCP connection policy, no request was sent to Cumulocity, and retrying through the same connection will not help.

## Development

### Prerequisites

- Node.js ≥22.0.0
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

Add the dev server to your local MCP client configuration:

```json
{
  "servers": {
    "local_mc8yp": {
      "type": "stdio",
      "command": "pnpm",
      "args": ["dlx", "jiti", "/path/to/your/project/src/cli/index.ts"]
    }
  }
}
```

## License

MIT
