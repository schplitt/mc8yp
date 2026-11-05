# External MCP servers

Besides the MCP servers a tenant exposes, a connection can bring its own. Pass one `mc8yp-mcp-server` header per server (or a JSON array in a single header); each becomes a codemode namespace for that connection only:

```http
mc8yp-mcp-server: {"name":"github","url":"https://api.githubcopilot.com/mcp/","token":"ghp_…"}
mc8yp-mcp-server: {"name":"linear","url":"https://mcp.linear.app/mcp"}
```

| Field         | Required | Meaning                                                                                                                                                                     |
| ------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | yes      | The sandbox namespace (`github.<tool>`). Must be a valid JS identifier and must not collide with a reserved namespace (`codemode`, `docs`, `sandbox`, `c8y`, `cumulocity`). |
| `url`         | yes      | Absolute `http`/`https` MCP endpoint, used as given.                                                                                                                        |
| `token`       | no       | Sent as `Authorization: Bearer <token>`.                                                                                                                                    |
| `headers`     | no       | Extra request headers, applied after `token` so an explicit `authorization` entry replaces the bearer shorthand.                                                            |
| `description` | no       | Shown in the `codemode.describe()` overview. Defaults to the server's own `instructions`.                                                                                   |

The CLI takes the same JSON via a repeatable flag:

```sh
mc8yp-cli --mcp-server '{"name":"github","url":"https://api.githubcopilot.com/mcp/","token":"ghp_…"}'
```

Behaviour worth knowing:

- **Config is header/flag-only.** There is deliberately no `?mcpServer=` query parameter even though the other connection options have one — the value can carry a bearer token, and query strings end up in access logs and proxy traces.
- **Tenant credentials are never forwarded.** An external server only ever receives the credentials in its own entry, and these namespaces work even when no tenant is active (CLI before `set-active-tenant`).
- **The agent is told which namespaces are external.** `codemode.describe()` labels them `EXTERNAL MCP server at <url> — configured for this connection, NOT part of this tenant`, and the per-method describe repeats it. Whether a tenant namespace is backed by OpenAPI or MCP stays hidden (an implementation detail the agent cannot act on); tenant-vs-third-party is a data boundary it must be able to report on.
- **Tool lists are fetched on first use and cached per MCP session**, then dropped 15 minutes after last use or immediately when the client closes its session cleanly. Rotating a token or changing a URL mid-session re-handshakes.
- **A malformed entry fails the request** (HTTP 400 in server mode, a startup error in CLI) rather than silently leaving the agent without a namespace it was supposed to have. A well-formed but _unreachable_ server is reported in the `codemode.describe()` overview and retried on the next call.
- **The tenant wins name collisions.** An external entry whose `name` matches a tenant namespace is skipped, so a header cannot shadow a real service. That skip is silent to the caller — use `POST /resolve-mcp-servers` (below) to catch it while configuring rather than discovering it as a missing namespace at run time.
- **Egress is unrestricted by design.** The URL is used as given — any host, no allowlist, no private-range filtering. The header is part of the connection's trusted configuration (the sandbox cannot set it), but the consequence is that whoever can set headers on the deployed microservice can make it issue requests to any address it can reach, including tenant-internal ones. Front the deployment accordingly.
- Path-based restriction/allow rules do **not** apply to these namespaces, same as for tenant-discovered MCP tools (see [Access policy](access-policy.md)).

## Checking a configuration before you store it: `POST /resolve-mcp-servers`

Whoever builds that header — a tenant admin UI, a deployment script — cannot answer three things on its own: which namespace an entry gets, whether that namespace is free, and whether the server actually answers with its credentials. This route answers all three in one call, so no consumer has to reimplement mc8yp's namespace rules or its MCP handshake:

```http
POST /service/mc8yp-server/resolve-mcp-servers
Content-Type: application/json

{ "servers": [{ "name": "MaStR registry", "url": "https://mastr.example/mcp", "token": "…" }] }
```

```jsonc
{
  "tenantUrl": "https://…cumulocity.com",
  "tenantId": "t123",
  "tenantNamespaces": ["c8y", "dtm", "knowledge_base_ms"], // null = the check could not run, see `warnings`
  "warnings": [],
  "servers": [
    {
      "name": "MaStR registry",
      "namespace": "MaStR_registry", // derived — store THIS and send it in the header from now on
      "status": "ok",                // ok | invalid | namespace-taken | unreachable
      "server": { "name": "mastr-mcp", "version": "1.0.0" },
      "tools": [{ "name": "search_units", "description": "…" }]
    }
  ]
}
```

- **`name` may be free-form here.** It is sanitized into the namespace exactly as a contextPath is (`MaStR registry` → `MaStR_registry`, the same rule that makes `knowledge-base-ms` into `knowledge_base_ms`). An identifier passes through unchanged.
- **`status` is the field to branch on**, and `namespace-taken` is the interesting one: reserved name, a namespace this tenant already holds, or a duplicate inside the same request. That is the collision that would otherwise be a silent skip at run time — `namespaceTakenBy` says who holds it. Tools are still reported for a taken entry, so renaming is the only fix needed.
- **The header contract does not change.** Derivation is a configure-time convenience: resolve once, store the `namespace` you got back, keep sending it verbatim. The agent-visible namespace stays stable even if the derivation is refined later.
- **Validation is the header's own**, so this route cannot green-light an entry the header would then 400.
- **Nothing is persisted, and nothing is cached.** mc8yp holds no external server configuration of its own, and the handshake bypasses the per-session tool-list cache so the answer always reflects the credentials as sent.
- Requires user auth (Authorization header or session cookie), like `POST /refresh-apis`.
