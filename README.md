# mc8yp

![Version](https://img.shields.io/npm/v/mc8yp)
![License](https://img.shields.io/npm/l/mc8yp)
![Node Version](https://img.shields.io/node/v/mc8yp)

An [MCP](https://modelcontextprotocol.io) server that gives AI agents the full Cumulocity API through one tool, `codemode`.

The agent writes a short async JavaScript function. It runs in a sandbox where every API is a typed namespace (`c8y` for core, plus one per microservice on the tenant, such as `dtm`), together with search and docs helpers to find the right method:

```js
async () => {
  const { results } = await codemode.search('managed objects')
  const devices = await c8y.getManagedObjectCollectionResource({ pageSize: 20 })
  return devices.managedObjects?.map((d) => ({ id: d.id, name: d.name }))
}
```

Any microservice on the tenant that ships an OpenAPI spec or an MCP server is picked up automatically. No rebuild needed.

## CLI or microservice

|             | CLI                                           | Microservice                                   |
| ----------- | --------------------------------------------- | ---------------------------------------------- |
| Runs        | Locally, over stdio                           | Inside Cumulocity, over HTTP at `/mcp`         |
| Credentials | OS keyring (`mc8yp creds add`)                | The caller's `Authorization` header            |
| Tenant      | The agent picks one with `set-active-tenant`  | Fixed by the deployment                        |
| Extra tools | `status`, `set-active-tenant`                 | Optional `sandbox` shell (opt-in)              |
| Platforms   | macOS, Linux, [WSL 2](docs/wsl-setup.md)      | Any Cumulocity tenant                          |
| Use it for  | Local development with Claude Code or similar | Shared and production agents, AI Agent Manager |

## Microservice

1. Download the release zip from [GitHub Releases](https://github.com/schplitt/mc8yp/releases).
2. Upload it in Cumulocity **Application Management** and subscribe it.
3. Point your agent at `https://<tenant>.cumulocity.com/service/mc8yp-server/mcp`.

The app auto-registers with [AI Agent Manager](https://cumulocity.com/docs/ai/aim-introduction/), so no manual MCP server entry is needed there.

## CLI

```sh
pnpm dlx mc8yp creds add   # store tenant URL, user and password in the OS keyring
pnpm dlx mc8yp creds list
pnpm dlx mc8yp creds remove
```

Users with two-factor authentication are prompted for their code; the agent's MCP client asks for a new one when the session expires.

Adding credentials does not select a tenant. The agent calls `status` to see stored tenants and `set-active-tenant` to pick one. The choice is saved per working directory, so agents in different projects do not switch each other's tenant. Every `codemode` result starts with the tenant it ran against.

## Add to Claude

**Claude Code, local CLI:**

```sh
claude mcp add mc8yp -- pnpm dlx mc8yp

# available in every project
claude mcp add -s user mc8yp -- pnpm dlx mc8yp
```

**Claude Code, deployed microservice:**

```sh
claude mcp add --transport http mc8yp \
  https://<tenant>.cumulocity.com/service/mc8yp-server/mcp \
  --header "Authorization: Bearer <token>"
```

**Claude Desktop or any other stdio client:**

```json
{
  "mcpServers": {
    "mc8yp": { "command": "pnpm", "args": ["dlx", "mc8yp"] }
  }
}
```

Everything after `--` in `claude mcp add` goes to mc8yp, so access rules (below) go there too.

## Restrict access

Two rule types, set per connection:

- **Restrictions** block matching operations.
- **Allow rules** block everything that does not match one of them.

Restrictions win when both match. A rule is `[METHOD:]/path`, where `*` matches within one path segment and `**` matches any number of segments.

| Rule                   | Means                                 |
| ---------------------- | ------------------------------------- |
| `/alarm/**`            | every method on `/alarm` and below    |
| `GET:/inventory/**`    | only GET on `/inventory` and below    |
| `DELETE:/inventory/**` | only DELETE on `/inventory` and below |

**CLI:** `-r` for restrictions, `-a` for allow rules.

```sh
# read-only agent
claude mcp add mc8yp -- pnpm dlx mc8yp \
  -a "GET:/inventory/**" -a "GET:/alarm/**" -a "GET:/measurement/**"

# no inventory deletes, no user management
pnpm dlx mc8yp -r "DELETE:/inventory/**" -r "/user/**"
```

**Microservice:** `mc8yp-restriction` and `mc8yp-allow` headers (repeated or comma-separated), or the `r` and `a` query parameters.

```http
POST /service/mc8yp-server/mcp
mc8yp-allow: GET:/inventory/**, GET:/alarm/**
mc8yp-restriction: /user/**
```

Blocked operations are hidden from the agent's search and are refused before any request reaches Cumulocity. Rules apply to OpenAPI-backed APIs only, not to MCP-backed ones. See <docs/access-policy.md> for the full syntax and the MCP caveat.

## More

- [Access policy reference](docs/access-policy.md)
- [External MCP servers](docs/external-mcp-servers.md): attach third-party MCP servers to a connection
- [Advanced](docs/advanced.md): how discovery works, the `sandbox` shell, MCP-backed services, bundled specs, `--spec`
- [WSL 2 keyring setup](docs/wsl-setup.md)

## Development

Requires Node.js 24 or later and pnpm.

```sh
pnpm install
pnpm test:run
pnpm lint:fix
pnpm typecheck
pnpm build                  # CLI in dist/, server bundles in .output/<version>/
pnpm package:microservices  # one Cumulocity zip per bundled core version
```

## License

MIT
