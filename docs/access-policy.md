# Access policy

mc8yp supports two per-connection rule types:

- **Restrictions** — deny rules that block matching API operations.
- **Allow rules** — allow-list rules. When at least one allow rule is set, anything not matching is blocked.

If both apply to the same operation, **restrictions win**. This is how you expose broad API knowledge while still running an agent in a read-only or otherwise constrained mode.

## Rule format

```txt
<path-pattern>
<method>:<path-pattern>
```

- No method prefix → matches all HTTP methods.
- With a method prefix → only that method. Supported: `DELETE`, `GET`, `HEAD`, `OPTIONS`, `PATCH`, `POST`, `PUT`, `QUERY`, `TRACE`, or `*`. Case-insensitive.
- Patterns must start with `/`. Query strings and fragments are not allowed in patterns.
- Wildcards: `*` matches within a single path segment; `**` matches zero or more whole segments and must be its own segment.

<details>
<summary><strong>Path pattern examples</strong></summary>

| Pattern               | Matches                                                     | Does Not Match                             |
| --------------------- | ----------------------------------------------------------- | ------------------------------------------ |
| `/inventory`          | `/inventory`                                                | `/inventory/managedObjects`                |
| `/inventory/**`       | `/inventory`, `/inventory/managedObjects`, `/inventory/x/y` | `/alarm/alarms`                            |
| `/i*`                 | `/inventory`, `/identity`, `/i`                             | `/inventory/managedObjects`                |
| `/i*/**`              | `/inventory`, `/inventory/managedObjects`, `/identity/x`    | `/alarm/alarms`                            |
| `/inventory/m*`       | `/inventory/managedObjects`, `/inventory/measurements`      | `/inventory/events`, `/inventory/m/x`      |
| `/inventory/*/child`  | `/inventory/device-1/child`, `/inventory/x/child`           | `/inventory/child`, `/inventory/a/b/child` |
| `/inventory/**/child` | `/inventory/child`, `/inventory/a/b/child`                  | `/inventory/a/b/sibling`                   |

Notes:

- `/inventory/**` already matches `/inventory` itself.
- `/i**` is invalid — `**` must be its own segment. Use `/i*/**` instead.
- Rule patterns may not contain `//`, `.`, `..`, query strings, or fragments.

</details>

<details>
<summary><strong>Common rule examples</strong></summary>

| Rule                             | Restriction Effect                                           | Allow-list Effect                                             |
| -------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------- |
| `/inventory/**`                  | Block all methods on `/inventory` and below                  | Permit all methods on `/inventory` and below                  |
| `DELETE:/inventory/**`           | Block only DELETE on `/inventory` and below                  | Permit only DELETE on `/inventory` and below                  |
| `/alarm/alarms`                  | Block all methods on the exact path `/alarm/alarms`          | Permit all methods on the exact path `/alarm/alarms`          |
| `GET:/measurement/measurements`  | Block only GET on the exact path `/measurement/measurements` | Permit only GET on the exact path `/measurement/measurements` |
| `POST:/inventory/managedObjects` | Block creating new managed objects                           | Permit creating new managed objects                           |
| `/user/**`                       | Block all user management paths                              | Permit all user management paths                              |

</details>

## CLI usage

Repeat `-r`, `--restrict`, or `--restriction` for deny rules; `-a`, `--allow`, or `--allowed` for allow rules:

```sh
# Block all inventory writes and all alarm access
mc8yp -r "DELETE:/inventory/**" -r "/alarm/**"

# Only permit GET inventory + POST alarms
mc8yp --allow "GET:/inventory/**" --allowed "POST:/alarm/**"

# Allow inventory broadly, but still block one path
mc8yp -a "/inventory/**" -r "/inventory/managedObjects"
```

## Microservice usage (HTTP)

Use query parameters or project-scoped headers on the `/mcp` endpoint:

- Deny rules: `restriction`, `restrict`, or `r` query params, or `mc8yp-restriction` header.
- Allow rules: `allowed`, `allow`, or `a` query params, or `mc8yp-allow` header.

Both headers accept either repeated header instances or a comma-separated list. Query parameters and headers can be combined.

```txt
/mcp?r=/inventory/**&r=DELETE:/alarm/**&allow=GET:/measurement/**
```

```http
POST /mcp HTTP/1.1
Authorization: Bearer <token>
mc8yp-restriction: /inventory/**
mc8yp-allow: GET:/measurement/**
```

When a live call is blocked by connection policy, the codemode run returns explanatory text, no request is sent to Cumulocity, and retrying through the same connection will not help. Blocked operations are additionally omitted from `codemode.search`/`describe` and the docs index, so the agent never plans around a method it cannot call.

> **Note:** path-based restriction/allow rules apply to OpenAPI-derived namespaces only. Wrapped MCP tools have no METHOD:path identity and are not covered by these rules — use the `noMcp` opt-out to disable MCP wrapping for a connection if that matters for your deployment. The same gap applies to [external MCP servers](external-mcp-servers.md); there the lever is simply not configuring the server for that connection.
