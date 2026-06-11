# AGENTS.md

## Project Overview

**mc8yp** is a Cumulocity IoT MCP server.

The project exposes a small code-mode surface to AI agents instead of a large fixed toolset:

- `query` inspects the bundled Cumulocity OpenAPI specs
- `execute` calls the live Cumulocity API through a sandboxed request helper
- `status` is available only in CLI mode: it lists the active tenant, stored credentials, and the specs currently visible to `query`. It accepts `{ refresh: true }` to force a fresh API discovery on demand (noop when no tenant is active). Server mode has no in-protocol equivalent yet — use the `POST /refresh-apis` HTTP route for ops-driven refresh; an in-protocol server-side flow will land in a separate PR.

The repository supports two runtime modes:

- **CLI mode** for local MCP usage over stdio, with credentials stored in the operating system keyring
- **Microservice mode** for deployment inside Cumulocity, exposing an HTTP MCP endpoint and using request auth plus platform configuration

## Architecture

```text
src/
  index.ts                    HTTP/microservice entrypoint
  server.ts                   Shared MCP server factory
  global.d.ts                 Global runtime declarations
  types.ts                    Shared public types
  cli/
    index.ts                  CLI entrypoint and stdio transport
    subcommands/
      creds.ts                Credential command group
      subcommands/
        add.ts                Store tenant credentials
        list.ts               List stored credentials
        remove.ts             Remove stored credentials
  codemode/
    execute.ts                Sandboxed query/execute runtime generation
    network-permissions.ts    Secure-exec network permission decisions for execute mode
    semaphore.ts              Concurrency limiter for sandbox execution
  ctx/
    auth.ts                   Per-request auth context for server mode
  prompts/
    codemode.ts               `code-mode-guide` prompt
    index.ts                  Prompt registration
  tools/
    codemode.ts               `query` and `execute` tool definitions
    status.ts                 `status` tool (CLI only: active tenant + stored credentials + visible specs + on-demand refresh)
    index.ts                  Tool registration
  types/
    mcp-context.ts            MCP custom context shape
  utils/
    api-discovery.ts          Per-tenant live OpenAPI discovery with 30-min refresh cache
    auth.ts                   Authorization header parsing for server mode
    c8y-types.ts              Cumulocity-specific shared types
    client.ts                 Auth/header resolution for live requests
    credentials.ts            OS keyring credential storage and lookup
    restriction-matcher.ts    Restriction compilation and path matching helpers
    restrictions.ts           Restriction parsing and query handling
    schema.ts                 Shared schema helpers
    spec-resolution.ts        `resolveSpecs` plus the shared `Spec`/`PathItem`/`OperationInfo` types
test/
  excute.test.ts
  restriction-core.test.ts
  restrictions.test.ts
  restrictions.bench.ts
  semaphore.test.ts
openapi.json                 Self-describing OpenAPI for mc8yp's non-MCP HTTP surface; referenced from cumulocity.json so the deployed microservice is discoverable via the standard openApiSpec discovery flow
openapi/
  core/
    release.json             Bundled latest Cumulocity core OpenAPI snapshot
    2026.json                Bundled 2026 Cumulocity core OpenAPI snapshot
    2025.json                Bundled 2025 Cumulocity core OpenAPI snapshot
    2024.json                Bundled 2024 Cumulocity core OpenAPI snapshot
  dtm/
    release.json             Bundled latest Cumulocity DTM OpenAPI snapshot
openapi-builds.json           Build matrix plus download URLs for bundled OpenAPI sources
scripts/
  cumulocity.mjs             Updates cumulocity.json metadata from package.json
  package-microservices.mjs  Builds versioned Docker-based Cumulocity release zips
tsdown.config.ts              CLI/server build configuration plus the `#core-openapi` and `#bundled-services` virtual module plugins
src/openapi-modules.d.ts      Ambient type declarations for the `#core-openapi` and `#bundled-services` virtual modules
```

### Runtime Flow

#### CLI mode

1. `src/cli/index.ts` parses CLI arguments and access-policy flags (`-r`, `--restrict`, `--restriction`, `-a`, `--allow`, and `--allowed`).
2. It accepts `--spec` / `-s` to select the bundled core-versioned OpenAPI build exposed by `query`.
3. It sets `globalThis.executionEnvironment = 'cli'`.
4. It exposes credential lookup helpers on `globalThis` for tools and subcommands.
5. It starts the shared MCP server over stdio transport.
6. `creds add` uses `@clack/prompts` so password entry is masked instead of echoed through the terminal prompt.

#### Microservice mode

1. `src/index.ts` starts the HTTP server and exposes `/mcp` and `/health`.
2. It sets `globalThis.executionEnvironment = 'server'`.
3. It extracts auth from request headers, restrictions from `restriction`, `restrict`, and `r` query parameters plus the `mc8yp-restriction` header, and allow rules from `allowed`, `allow`, and `a` query parameters plus the `mc8yp-allow` header.
4. It stores auth in request-local context and forwards the request to the shared MCP server.
5. It configures the HTTP transport in POST-only mode (`disableSse: true`) because the optional long-lived GET/SSE channel proved unstable behind Cumulocity microservice ingress.

#### Shared MCP surface

- `src/server.ts` creates the MCP server, registers tools and prompts, and conditionally enables `status` and `set-active-tenant` only in CLI mode.
- `openapi/core/` and `openapi/dtm/` contain the bundled OpenAPI snapshots consumed by the build.
- `src/tools/codemode.ts` defines the `query` and `execute` tools.
- `src/prompts/codemode.ts` defines the `code-mode-guide` prompt.

## Codemode Behavior

`src/codemode/execute.ts` is the main control surface for sandbox execution.

- `query` executes JavaScript against the bundled OpenAPI specs with network access disabled.
- `execute` executes JavaScript with a provided `cumulocity.request()` helper.
- Both runtimes use [`@iso4/sandbox`](https://www.npmjs.com/package/@iso4/sandbox) — a V8-isolate sandbox running in a separate Rust subprocess — with a 128 MB memory limit and 50 second CPU time limit. A single lazy-initialised `Sandbox` is shared across all `query`/`execute` calls; iso4's connection pool serialises runs across isolate slots.
- `execute` exposes the tenant API to sandbox code through a single bridged global: `cumulocity.request({ method, path, body, headers })`. The host-side handler (`createCumulocityRequestHandler` in `src/codemode/execute.ts`) injects auth headers, evaluates restriction/allow rules, performs the live request through [`@iso4/fetch`](https://www.npmjs.com/package/@iso4/fetch)'s `createSafeFetch` (which adds DNS-pinning and SSRF protection at the network layer), and returns plain parsed data. The sandbox never sees raw `fetch`.
- Input code is normalized before execution so fenced code blocks can still run.

### Bundled OpenAPI Selection

There are exactly two virtual modules:

- **`#core-openapi`** — the always-available core spec. Exports `specs`, `getCoreOpenApiSpec()`, `getCoreOpenApiVersion()`, `setCoreOpenApiVersion()`, `getCoreOpenApiLabel()`. Core is the only spec with a named sandbox binding (`coreSpec`).
- **`#bundled-services`** — a generic registry of all bundled service-backed specs (DTM today). Exports `BUNDLED_SERVICE_SPECS: ReadonlyArray<BundledServiceSpec>` where each entry has `{ contextPath, appLabel, specLabel, servicePrefix, spec }`. The plugin loops every entry in `openapi-builds.json` `sources.*` that has a `servicePrefix` and inlines the resolved version for that build, with paths already rewritten via `rewriteSpecPaths`.

Both modules return `Spec`-typed data (not `unknown`); the `Spec`/`PathItem`/`OperationInfo` types live in `src/utils/spec-resolution.ts` and are referenced from `src/openapi-modules.d.ts`.

Build-time behaviour:

- For the CLI build the core plugin inlines all `openapi/core/*.json` snapshots and `setCoreOpenApiVersion` switches between them at runtime. The bundled-services plugin inlines the `default` version of each service-backed source.
- For each server build, the plugins inline exactly the configured core+services combination for that build, taken from `builds[].apis`.
  - Types for both virtual modules live together in `src/openapi-modules.d.ts`; no `tsconfig.paths` entry is needed.
  - `openapi-builds.json` is the source of truth for both the download URLs used by `scripts/update-openapi.mjs` and the server build/package matrix used by `tsdown.config.ts` and `scripts/package-microservices.mjs`.
  - `tsdown.config.ts` emits one server bundle per supported build version into `.output/<version>/`.
  - `scripts/package-microservices.mjs` turns those built server outputs into one Docker-based zip per build, for example `mc8yp-core-2026-dtm-v2.x.x.zip`.
  - The packaging script writes a temporary generated Dockerfile under `.c8y/`, builds from the repository root, copies the selected `.output/<version>/` bundle into `/app/server/`, and installs production dependencies inside the Linux image with pnpm before copying them into the runtime stage.
  - The packaging script builds Docker images for `linux/amd64` by default so release zips created on Apple Silicon remain deployable in typical Cumulocity environments; override with `DOCKER_PLATFORM` only when you intentionally need a different target.

### Query vs Execute

- `query` expects a JavaScript function expression and returns strings directly or other values as JSON text.
- `query` injects two deterministic top-level bindings into the sandbox: `coreSpec` and `serviceSpecs`.
- `coreSpec` is the main Cumulocity REST surface (always present). `serviceSpecs` is a `Record<string, Spec>` keyed by contextPath; bundled and discovered service specs like DTM land here as `serviceSpecs.dtm` only when actually available on the tenant.
- An unavailable spec is **absent** from `serviceSpecs`, not `null`. Agent code should check `serviceSpecs.dtm` (or `'dtm' in serviceSpecs`) before reaching into an optional surface.
- `execute` expects a JavaScript function expression and returns successful results in Toon format.
- Visible operations remain raw OpenAPI data; blocked live requests fail before network access.

### Restrictions

Restrictions and allow rules both use the format `[METHOD:]<path-pattern>`.

- Restrictions are deny rules.
- Allow rules are allow-list entries. When any allow rule exists, requests must match at least one allow rule unless a restriction blocks them first.
- Restrictions take priority over allow rules.
- In microservice mode, prefer the project-scoped `mc8yp-restriction` and `mc8yp-allow` headers for HTTP policy transport; repeated headers and comma-separated values are both accepted.
- Bundled services that are not installed on the tenant are simply absent from `serviceSpecs`. There is no pre-emptive auto-restriction layer — if an `execute` call ends up hitting an uninstalled service route, the Cumulocity API itself returns the failure and the sandbox propagates it. The connection-level restriction/allow policy is the only layer above that.

The restriction system is implemented in two places:

- `src/utils/restrictions.ts` parses both deny rules and allow rules and handles CLI/query input.
- `src/utils/restriction-matcher.ts` owns rule compilation, path matching, and restriction-vs-allow precedence.
- Restriction and allow-rule enforcement live entirely on the host inside `createCumulocityRequestHandler`. There is no separate network-permission layer file — `evaluateAccessPolicy` from `src/utils/restriction-matcher.ts` is called directly before any HTTP request leaves the host.

## Authentication And Credentials

### CLI mode

- Credentials are stored with `@napi-rs/keyring` in the OS credential manager.
- `src/utils/credentials.ts` is the source of truth for storing, listing, resolving, and deleting tenant credentials.
- Stored credentials are normalized by tenant URL.
- User/password credentials may resolve and persist the tenant ID if it is not provided.
- The active tenant is persisted to `~/.config/mc8yp/active-tenant.json` by the `set-active-tenant` MCP tool. `src/cli/active-tenant.ts` owns read/write. Any read error or bad JSON shape returns null silently. Tools that require a tenant (`query`, `execute`) throw a descriptive error when null.

### Microservice mode

- Auth is derived from the incoming `Authorization` header.
- `src/utils/auth.ts` parses Basic and Bearer auth.
- `src/ctx/auth.ts` keeps auth request-local so concurrent HTTP requests do not leak credentials.
- Tenant base URL is provided by deployment configuration rather than by end-user input.

## Development

```sh
pnpm install
pnpm lint
pnpm typecheck
pnpm test:run
pnpm build
pnpm package:microservices
```

### Important scripts

```sh
pnpm test:run      # Vitest one-shot test run
pnpm test:bench    # Vitest benchmark run
pnpm lint          # ESLint
pnpm lint:fix      # ESLint autofix
pnpm typecheck     # TypeScript noEmit check
pnpm build         # tsdown build for CLI plus all versioned server outputs
pnpm package:microservices # Docker-based zip packaging for all built server variants
pnpm prerelease    # lint + typecheck + build
```

### Build outputs

- `tsdown.config.ts` builds versioned HTTP server bundles into `.output/<version>/`
- `tsdown.config.ts` builds the CLI bundle into `dist/`
- Both CLI and server bundles use `noExternal: [/^(?!@iso4\/sandbox$|@napi-rs\/)/]` to inline all non-native dependencies. Only `@iso4/sandbox` (per-platform Rust binaries) and `@napi-rs/keyring` (N-API, CLI only) remain external and are the only packages in `dependencies`. Everything else lives in `devDependencies` and is inlined at build time.
- Release zip artifacts are created in the repository root by `pnpm package:microservices`
- `pnpm package:microservices` names artifacts from the bundled API combination, for example `mc8yp-core-2026-dtm-v2.x.x.zip`.
- `pnpm package:microservices` uses a temporary `.c8y/` staging directory, deletes old root `*.zip` artifacts before creating fresh ones, installs production dependencies inside a Linux Docker build so platform-specific optional native packages resolve correctly, and builds `linux/amd64` images unless `DOCKER_PLATFORM` is set explicitly.

## Code Style And Conventions

- ESM only (`"type": "module"`)
- TypeScript strict mode enabled
- Node.js `>=24.0.0`
- Keep the MCP registration surface in `src/server.ts`, `src/tools/`, and `src/prompts/`
- Keep restriction/allow parsing and query handling logic in `src/utils/restrictions.ts`, and keep rule compilation/matching logic in `src/utils/restriction-matcher.ts`
- Keep sandbox/runtime behavior in `src/codemode/execute.ts` rather than duplicating execution logic in tools
- Prefer mode-aware behavior instead of branching deep in unrelated modules

### Practical editing guidance

- If a change affects tool behavior, inspect both the tool definition and the codemode runtime.
- If a change affects bundled OpenAPI selection, update the `#core-openapi` / `#bundled-services` plugins in `tsdown.config.ts`, the ambient declarations in `src/openapi-modules.d.ts`, and the source/build matrix in `openapi-builds.json`.
- If you add a new bundled **service-backed** OpenAPI spec in the future: drop the JSON under `openapi/<key>/<version>.json` and add one entry under `sources.<key>` in `openapi-builds.json` with a `servicePrefix` (e.g. `"servicePrefix": "/service/<key>"`). `bundledServicesPlugin` picks it up automatically; `resolveSpecs`, `buildQueryScript`, and the auto-restriction logic all handle new entries generically. No code edits required.
- If you add a new always-available (non-service-backed) bundled spec like core: that needs a new virtual module wired into `tsdown.config.ts`, `src/openapi-modules.d.ts`, and a new named binding in `buildQueryScript`. This is a much bigger change and the bundled-services flow is _not_ the right place for it.
- If a change affects restrictions or allow rules, verify both policy messaging and live request blocking.
- If a change affects auth, verify the CLI and server paths separately.
- If a change affects public MCP behavior, update `README.md` as well as this file.
- Strongly prefer running ESLint autofix first (`pnpm lint:fix` or targeted `eslint --fix`) to save time. If the linter can fix an issue automatically, that is preferred over manually fixing the same issue by hand. For validation, prefer this exact order: `pnpm test:run` → `pnpm lint:fix` → `pnpm typecheck`.
- Do not introduce tiny one-line helper/utility functions for trivial logic; inline that logic directly where it is used instead.

## Testing

- Tests live in `test/`
- Use `*.test.ts` for tests and `*.bench.ts` for benchmarks
- Prefer adding targeted tests near the affected behavior:
  - restriction/allow parsing or matching changes: `test/restriction-core.test.ts` or `test/restrictions.test.ts`
  - codemode runtime changes: `test/excute.test.ts`
  - concurrency behavior: `test/semaphore.test.ts`
  - spec resolution logic: `test/spec-resolution.test.ts`
  - active tenant persistence: `test/active-tenant.test.ts`

Run these before finishing meaningful changes:

1. `pnpm test:run`
2. `pnpm lint:fix`
3. `pnpm typecheck`

## Maintaining Documentation

When making changes to the project:

- **`AGENTS.md`** — Update with repo-specific architecture, workflows, conventions, and implementation notes for coding agents
- **`README.md`** — Update for any user-facing MCP behavior changes, new prompts/tools, changed CLI usage, changed restriction/allow behavior, deployment changes, or credential changes

## Agent Guidelines

When working on this project:

1. Start from the actual controlling surface. For most feature work that is `src/tools/`, `src/prompts/`, `src/codemode/execute.ts`, or restriction/auth utilities.
2. Treat CLI mode and microservice mode as separate execution environments with different auth and tool availability.
3. Run focused tests first when changing a narrow subsystem, then run the full validation set if the change is broader. Use this exact validation order: `pnpm test:run`, then `pnpm lint:fix`, then `pnpm typecheck`.
4. The `query` sandbox reads `ResolvedSpecs` (`{ core: Spec, specs: Record<string, Spec> }`) from `c8yMcpServer.ctx.custom?.specs`. In server mode it is computed per-request by the H3 handler via `resolveSpecs(discoveredSpecs, installedContextPaths)`. In CLI mode it is set on tenant activation by `setCliTenantContext` and falls back to `getBundledOnlySpecs()` (every bundled snapshot, no removal) before any tenant is active. Spec removal is unconditional inside `resolveSpecs`: when a tenant is active the agent only sees what is reachable on that tenant. The no-tenant CLI fallback is the only path that exposes all bundled snapshots, and `execute` errors loudly on missing auth in that state. In CLI mode only, the `query` tool appends a one-line footer to every result naming the active tenant (or noting there is none) and `execute` prepends an `Executed against tenant: <url>` marker, so the agent can verify which tenant the result reflects. Server mode omits both — the tenant is fixed by deployment/request auth there, so the marker would just be noise. Both hints read from `c8yMcpServer.ctx.custom.auth.tenantUrl` — no extra metadata is threaded. `buildQueryScript` is pure injection — no resolution logic belongs there.
5. Keep public MCP tool and prompt descriptions aligned with actual runtime behavior.
6. Preserve the current sandbox limits and request boundary logic unless the task explicitly changes them.
7. Record recurring project-specific lessons in the section below when they are likely to prevent future mistakes.
8. Notify the user when `AGENTS.md` or `README.md` has changed so those docs can be reviewed explicitly.
9. When the user asks for branch/commit/PR workflow, use the available MCP/devtools for branch creation, commits, pushes, and PRs. Only fall back to `gh` CLI when those tools are not available. Never assume Claude Code or any other external workflow helper.
10. For branch/commit/PR workflow, branch names should use the same conventional type prefixes as commits and PR titles where appropriate. Prefer prefixes such as `feat/`, `test/`, `chore/`, `fix/`, `docs/`, `refactor/`, `build/`, `types/`, `examples/`, `style/`, `perf/`, and `ci/`. Commit subjects and PR titles must use conventional-commit style and should choose the most appropriate type from this set: `feat`, `perf`, `fix`, `refactor`, `docs`, `build`, `types`, `chore`, `examples`, `test`, `style`, `ci`. The project maps them as follows: `feat` → 🚀 Enhancements (minor), `perf` → 🔥 Performance (patch), `fix` → 🩹 Fixes (patch), `refactor` → 💅 Refactors (patch), `docs` → 📖 Documentation (patch), `build` → 📦 Build (patch), `types` → 🌊 Types (patch), `chore` → 🏡 Chore, `examples` → 🏀 Examples, `test` → ✅ Tests, `style` → 🎨 Styles, `ci` → 🤖 CI.
11. When the user asks for a PR while the current branch already contains related work, assume the PR should be opened from the current branch to `main` unless the user explicitly asks to isolate only a subset of changes or use a different base branch. Do not create a fresh branch off an in-progress feature branch just to hold the latest agent-only changes unless the user asks for that.
12. PRs created for the user must include a body. If the work clearly addresses an existing issue and the issue identifier is known, include it in the PR body using the appropriate GitHub-style reference.

## Project Context & Learnings

This section captures project-specific knowledge, tool quirks, and lessons learned during development. Add recurring patterns here when they are likely to matter again.

### Tools & Dependencies

- `@iso4/sandbox` is the execution boundary for both `query` and `execute`. It spawns a long-lived Rust child process on first use; `disposeSandbox()` shuts it down (called from the `excute.test.ts` `afterAll` hook and via a `process.once('exit')` handler in `execute.ts`).
- `@iso4/fetch` provides the hardened `safeFetch` used by the `cumulocity.request` host handler.
- `tsdown` produces separate server and CLI bundles.
- `@napi-rs/keyring` is used for local(cli) credential storage.
- `@clack/prompts` is used for interactive CLI credential entry so password input is masked.
- `@iso4/sandbox` must stay external in server builds. It depends on per-platform Rust binaries (`@iso4/v8-linux-x64-gnu`, etc.) shipped as optional dependencies, and bundling the entry would break the platform binary resolution. The microservice Dockerfile must install production dependencies inside the Linux image so the correct `@iso4/v8-linux-*` binary is fetched.

### Patterns & Conventions

- `execute` uses a generated ESM module entry and reads the default export from sandbox execution.
- `query` and `execute` accept function-expression style code and normalize fenced code input before evaluation.
- `#core-openapi` and `#bundled-services` are virtual modules synthesized by tsdown plugins; consumers must not import the JSON snapshots directly.
- The CLI build inlines all bundled core snapshots plus the default version of every service-backed source (currently DTM `release`); each server build inlines exactly the configured combination for that build.
- Bundled service specs land in the query sandbox as `serviceSpecs[contextPath]`, alongside any non-bundled services discovered live on the tenant. Core is the only named binding (`coreSpec`).
- `resolveSpecs` returns a single `{ core, specs }` object. An absent key in `specs` means the spec is unavailable for this tenant; there are no `null` values.
- `@iso4/fetch` is pure JS (`rou3` + `undici`) and is bundled into both CLI and server outputs. Only `@iso4/sandbox` must stay external in all builds.
- `scripts/package-microservices.mjs` intentionally targets `linux/amd64` by default to avoid Apple Silicon release images failing with `exec format error` in Cumulocity.
- Restrictions and allow rules are both discoverability metadata and enforcement logic; both layers matter.
- When creating branches for user-requested work, prefer conventional prefixes that match the intended change type, especially `feat/`, `test/`, and `chore/`.
- If the user asks to open a PR from an already-active feature branch, treat that existing branch as the PR head by default and target `main` unless they say otherwise.
- Server-mode auth must stay request-local.
- For deployed microservice mode, prefer POST-only streamable HTTP over long-lived GET/SSE. The optional SSE channel can go inactive behind Cumulocity ingress and break later tool calls even when initialization and tool discovery succeeded.
- The `status` tool is the in-protocol on-demand refresh path for CLI mode. It busts the per-tenant discovery cache via `refreshApiSpecs`, re-resolves specs, and patches both `getCliTenantContext().specs` and `c8yMcpServer.ctx.custom.specs` so the very next `query`/`execute` sees the new surface. There is no rate-limit — a local human-driven session has no runaway-agent risk and a forced refresh after a deploy should always work.
- Server mode has no in-protocol `status` tool yet; only the `POST /refresh-apis` HTTP route exists for ops/CI use. An in-protocol server-side equivalent (with rate-limiting) is planned for a separate PR and will need to re-introduce a tenant-ID stash on `c8yMcpServer.ctx.custom` and a global cooldown timestamp in `src/utils/api-discovery.ts`.
- mc8yp ships its own `openapi.json` (repo root) describing the non-MCP HTTP surface (`/refresh-apis`, `/health`). It is referenced from `cumulocity.json#openApiSpec` and served by the H3 server at `GET /openapi.json` via a `with { type: 'json' }` import in `src/index.ts` so it inlines into every server bundle. When mc8yp is subscribed on a tenant, the standard discovery loop in `src/utils/api-discovery.ts` picks it up and exposes it to agents as `serviceSpecs['mc8yp-server']`. The MCP endpoint at `/mcp` is intentionally NOT documented in this spec — MCP discovery is out-of-band via `tools/list`. Keep `openapi.json` in sync with any change to the HTTP surface, and never list `/mcp` there.
- CLI mode is a single stdio process; there is no IPC channel from a second terminal into the running CLI. Out-of-process triggers (e.g. "refresh from a shell after deploying") are intentionally not supported. Refresh has to flow through the in-protocol `status` tool.

### Common Mistakes To Avoid

- Do not assume tests live in `tests/`; this repository uses `test/`.
- Do not add tenant URL handling to server mode user flows; deployed mode derives tenant context from the environment and request auth.
- Do not bypass `src/codemode/execute.ts` when changing execution behavior; that file is the main runtime boundary.
- Do not rebundle `@iso4/sandbox` into any build. It resolves per-platform Rust binaries at runtime and cannot be statically inlined. `@iso4/fetch` is already bundled and does not need special treatment.
