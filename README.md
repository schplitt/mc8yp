# mc8yp — Cumulocity API access for AI agents

![Version](https://img.shields.io/npm/v/mc8yp)
![License](https://img.shields.io/npm/l/mc8yp)
![Node Version](https://img.shields.io/node/v/mc8yp)

mc8yp is a [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that gives AI agents access to the **full Cumulocity API surface** through just two code-mode tools instead of a huge fixed tool inventory:

- **`query`** — inspect the OpenAPI specs available on the current tenant
- **`execute`** — call the live Cumulocity API

The agent sees not only the bundled **Core** and **DTM** specs, but **any microservice installed on the tenant** that declares an OpenAPI spec in its manifest — mc8yp discovers those live and exposes them alongside the bundled ones. No code changes or rebuild required to support a new service.

Operators stay in control through per-connection **restrictions** and **allow rules**, so the same broad capability can be deployed as a read-only agent, a non-destructive production agent, or anything in between.

## How it works

1. mc8yp discovers every microservice installed on the tenant that declares an OpenAPI spec, and exposes those alongside the bundled Core (+ DTM) specs.
2. The agent uses `query` to inspect the available specs and pick an endpoint.
3. The agent uses `execute` to call the live Cumulocity API.
4. mc8yp enforces configured restrictions and allow rules before the request leaves the host.

### Live microservice API discovery

When a tenant is active, mc8yp asks Cumulocity which applications the tenant is subscribed to, reads the `openApiSpec` declaration from each application manifest, fetches the spec, prefixes its paths with the service's `contextPath`, and exposes it to the sandbox as `serviceSpecs[contextPath]`. Results are cached per tenant for 30 minutes.

The practical effect: **any Cumulocity microservice that ships an OpenAPI spec is automatically usable by the agent**, whether it is one of the bundled snapshots, a Cumulocity-provided service, or a custom microservice built in-house. The bundled specs are just guaranteed offline coverage; the discovery layer fills in everything else.

## Two ways to run it

- **Microservice mode** (recommended for production) — deploy inside Cumulocity IoT, expose `/mcp`, integrate with [AI Agent Manager](https://cumulocity.com/docs/ai/aim-introduction/). Auth comes from the request and the service user.
- **CLI mode** (local development) — run locally over stdio with an MCP client such as Claude Desktop. Credentials are stored in the OS keyring.

---

## Quick start — Microservice (recommended)

1. Download the latest release zip from [GitHub Releases](https://github.com/schplitt/mc8yp/releases).
2. Upload the `.zip` in Cumulocity **Application Management**.
3. Subscribe the application in your tenant.
4. Point your agent at:

   ```txt
   https://<tenant>.cumulocity.com/service/mc8yp-server/mcp
   ```

No extra credential setup is required — the microservice uses Cumulocity's deployment environment and request authentication.

The microservice manifest declares `exposeMcpServers`, so once the application is subscribed it auto-registers with AI Agent Manager as an MCP server at `/service/mc8yp-server/mcp` (with the user's authentication forwarded). No manual MCP server entry is needed in AI Agent Manager.

**Example: read-only production agent** (allow only safe GETs):

```txt
/mcp?allow=GET:/inventory/**&allow=GET:/alarm/**&allow=GET:/measurement/**
```

Or via headers:

```http
POST /mcp HTTP/1.1
mc8yp-allow: GET:/inventory/**
mc8yp-allow: GET:/alarm/**
mc8yp-allow: GET:/measurement/**
```

See [Access policy](#access-policy) for the full rule syntax.

---

## Quick start — Local CLI

### Platform support

| Platform | Supported | Notes                                                                                                                                            |
| -------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| macOS    | ✅ native | Keychain is used for credentials                                                                                                                 |
| Linux    | ✅ native | Secret Service (libsecret) is used for credentials                                                                                               |
| Windows  | ❌        | Use [WSL 2](https://learn.microsoft.com/windows/wsl/) (see [WSL 2 one-time setup](#wsl-2-one-time-setup) below) or the microservice mode instead |

The sandboxed V8 runtime ([`@iso4/sandbox`](https://www.npmjs.com/package/@iso4/sandbox)) communicates with a Rust subprocess over Unix domain sockets, which is why native Windows is not supported.

### Install and run

```sh
# Run directly (recommended)
pnpm dlx mc8yp

# Pick a specific bundled core OpenAPI build for `query`
pnpm dlx mc8yp --spec 2025

# Or install globally
npm install -g mc8yp
mc8yp
```

### Add credentials

`mc8yp creds add` prompts for tenant URL, username, and a masked password, and writes them to the OS keyring.

```sh
pnpm dlx mc8yp creds add     # add credentials (interactive, masked password)
pnpm dlx mc8yp creds list    # list stored credentials
pnpm dlx mc8yp creds remove  # remove stored credentials
```

On macOS and standard desktop Linux this works out of the box. On **WSL 2** the keyring stack is not wired up by default and needs a one-time bootstrap:

<details>
<summary><strong>WSL 2 one-time setup</strong> — required before <code>mc8yp creds add</code> works on WSL</summary>

A fresh WSL 2 distro has no Secret Service provider, no session D-Bus, and no `login` keyring collection, so `@napi-rs/keyring` (used by `mc8yp creds add`) has nothing to talk to. On a normal desktop Linux all of this is wired up automatically by the display manager and PAM; on WSL you have to do it once manually.

**1. Inside WSL, install the keyring stack:**

```sh
sudo apt install -y libsecret-tools dbus-x11
sudo apt install -y libpam-gnome-keyring
```

- `libsecret-tools` provides `secret-tool` and pulls in `libsecret` (the client library `@napi-rs/keyring` uses).
- `dbus-x11` provides `dbus-launch` so a session D-Bus can be started in a headless shell.
- `libpam-gnome-keyring` installs `gnome-keyring-daemon` (the actual Secret Service provider) and its PAM module.

**2. Force the keyring database to initialize:**

```sh
secret-tool store --label="init" init init
```

A throwaway write so `gnome-keyring-daemon` creates its on-disk store.

**3. Wire up PAM so the keyring auto-unlocks at login:**

```sh
sudo bash -c 'cat >> /etc/pam.d/login <<EOF
auth optional pam_gnome_keyring.so
session optional pam_gnome_keyring.so auto_start
EOF'
```

**4. From PowerShell, fully restart WSL so PAM picks up the new config:**

```powershell
wsl --shutdown
```

**5. Back in WSL, start a session D-Bus (WSL doesn't get one by default):**

```sh
echo $DBUS_SESSION_BUS_ADDRESS   # should be empty
eval $(dbus-launch --sh-syntax)
```

**6. Create the `login` collection that libsecret writes into.** On a normal desktop this is created by the graphical login session; on WSL it does not exist and credential writes will fail without it:

```sh
gdbus call --session \
  --dest org.freedesktop.secrets \
  --object-path /org/freedesktop/secrets \
  --method org.freedesktop.Secret.Service.OpenSession \
  "plain" \
  "<''>"

gdbus call --session \
  --dest org.freedesktop.secrets \
  --object-path /org/freedesktop/secrets \
  --method org.freedesktop.Secret.Service.CreateCollection \
  "{'org.freedesktop.Secret.Collection.Label': <'login'>}" \
  ""
```

**7. Trigger the keyring passphrase prompt once:**

```sh
secret-tool store --label="test" service myservice username myuser
```

This opens a prompt to set the keyring passphrase. You can leave it **empty** — the keyring will then auto-unlock without prompting later, which is what you want for headless WSL.

After this, `mc8yp creds add` will work.

</details>

### Activate a tenant

Adding credentials does **not** auto-activate a tenant. `execute` only runs against a live tenant once one has been selected, and the agent does that itself through MCP tools:

1. The agent calls `cli-status` to see stored credentials and the current active tenant.
2. The agent calls `set-active-tenant` with one of the tenant URLs. The selection is written to `~/.config/mc8yp/active-tenant.json` and reused across CLI restarts.
3. The agent runs `query` and `execute` as needed. Each result includes a footer or marker line showing which tenant it ran against.

To switch tenants, call `set-active-tenant` again. To stop targeting any tenant (browse bundled specs only), call it with `tenantUrl: null` — `query` keeps working, `execute` returns a missing-auth error so the agent cannot accidentally hit a tenant.

If the active tenant's credentials are removed via `mc8yp creds remove`, the next `cli-status` call clears the active tenant automatically.

### Connect a local MCP client

For Claude Desktop or any stdio MCP client:

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

With read-only access rules:

```json
{
  "servers": {
    "mc8yp": {
      "type": "stdio",
      "command": "pnpm",
      "args": [
        "dlx",
        "mc8yp",
        "-a", "GET:/inventory/**",
        "-a", "GET:/alarm/**",
        "-a", "GET:/measurement/**"
      ]
    }
  }
}
```

---

## Tools and prompts

| Tool                | Description                                                                                                                                                                                                                |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `query`             | Inspect the bundled and discovered OpenAPI specs by running a JavaScript function expression in a sandbox. Exposes `coreSpec` and `serviceSpecs` (keyed by `contextPath`). Returns JSON text.                              |
| `execute`           | Run an async JavaScript function expression that calls the live Cumulocity API via `cumulocity.request({ method, path, body?, headers? })`. Returns the function result in [Toon format](https://github.com/nicepkg/toon). |
| `cli-status`        | _(CLI only)_ Show the active tenant and stored credentials. Auto-clears the active tenant if its credentials are gone.                                                                                                     |
| `set-active-tenant` | _(CLI only)_ Select the tenant `query` and `execute` operate against. Pass `tenantUrl: null` to clear.                                                                                                                     |

Both code-mode tools run in a sandboxed V8 runtime ([`@iso4/sandbox`](https://github.com/schplitt/iso4)) hosted in a separate Rust subprocess. The sandbox has no `fetch` global — the only path to the tenant is the host-bridged `cumulocity.request` helper, which is DNS-pinned and SSRF-hardened via [`@iso4/fetch`](https://www.npmjs.com/package/@iso4/fetch).

The **`code-mode-guide`** prompt contains the full reference for `query` and `execute`, including types, examples, and the active access policy for the current connection.

### `execute` input shape

`execute` expects an async function expression:

```js
async () => {
  return await cumulocity.request({
    method: 'GET',
    path: '/inventory/managedObjects?pageSize=5',
  })
}
```

You can do intermediate work before returning:

```js
async () => {
  const devices = await cumulocity.request({
    method: 'GET',
    path: '/inventory/managedObjects?pageSize=20&withTotalPages=true',
  })

  return devices.managedObjects?.map((d) => ({ id: d.id, name: d.name }))
}
```

---

## Access policy

mc8yp supports two per-connection rule types:

- **Restrictions** — deny rules that block matching API operations.
- **Allow rules** — allow-list rules. When at least one allow rule is set, anything not matching is blocked.

If both apply to the same operation, **restrictions win**. This is how you expose broad API knowledge while still running an agent in a read-only or otherwise constrained mode.

### Rule format

```txt
<path-pattern>
<method>:<path-pattern>
```

- No method prefix → matches all HTTP methods.
- With a method prefix → only that method. Supported: `DELETE`, `GET`, `HEAD`, `OPTIONS`, `PATCH`, `POST`, `PUT`, `TRACE`, or `*`. Case-insensitive.
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

### CLI usage

Repeat `-r`, `--restrict`, or `--restriction` for deny rules; `-a`, `--allow`, or `--allowed` for allow rules:

```sh
# Block all inventory writes and all alarm access
mc8yp -r "DELETE:/inventory/**" -r "/alarm/**"

# Only permit GET inventory + POST alarms
mc8yp --allow "GET:/inventory/**" --allowed "POST:/alarm/**"

# Allow inventory broadly, but still block one path
mc8yp -a "/inventory/**" -r "/inventory/managedObjects"
```

### Microservice usage (HTTP)

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

When `execute` is blocked by connection policy, the tool returns explanatory text, no request is sent to Cumulocity, and retrying through the same connection will not help.

---

## OpenAPI coverage

What the agent sees through `query` comes from two layers:

1. **Live-discovered specs** — every microservice subscribed on the active tenant whose manifest declares an `openApiSpec`. Discovered at runtime, cached for 30 minutes per tenant, exposed as `serviceSpecs[contextPath]`. This works for any service, not just the ones bundled here.
2. **Bundled snapshots** — shipped with the build so Core and DTM are always available even when discovery hasn't run yet:
   - **Core** snapshots: `release`, `2026`, `2025`, `2024`
   - **DTM** snapshot bundled alongside each supported core build

With an active tenant, services not installed on that tenant are dropped from the sandbox so the agent only sees what is actually reachable.

In CLI mode, pick which **core** snapshot `query` exposes:

```sh
mc8yp              # default: latest bundled release
mc8yp --spec 2025  # use the 2025 snapshot
mc8yp -s 2024      # short form
```

This only affects the bundled core view. `execute` always hits the live Cumulocity API of the selected tenant or deployed service environment.

---

## Development

Requires Node.js ≥ 24 and pnpm.

```sh
pnpm install
pnpm test:run     # tests
pnpm lint:fix     # lint with autofix
pnpm typecheck    # tsc --noEmit
pnpm build        # CLI bundle in dist/, server bundles in .output/<version>/
```

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

<details>
<summary><strong>Release packaging</strong></summary>

```sh
pnpm package:microservices
```

Produces one Docker-based Cumulocity zip per bundled server variant in the repository root, e.g.:

- `mc8yp-core-release-dtm-v1.2.3.zip`
- `mc8yp-core-2026-dtm-v1.2.3.zip`
- `mc8yp-core-2025-dtm-v1.2.3.zip`
- `mc8yp-core-2024-dtm-v1.2.3.zip`

The packaging step writes a temporary generated Dockerfile under `.c8y/`, copies the selected versioned server bundle into `/app/server/`, and installs production dependencies inside a `linux/amd64` Docker image so the per-platform native binaries of `@iso4/sandbox` resolve correctly. The deployed HTTP transport is POST-only (`GET /mcp` returns `405`) because some reverse proxies and Cumulocity ingress layers do not keep a long-lived SSE channel stable enough for reliable MCP tool calls.

The build matrix is driven by [`openapi-builds.json`](openapi-builds.json). Core snapshots live under `openapi/core/`, DTM snapshots under `openapi/dtm/`.

</details>

## License

MIT
