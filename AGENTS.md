# AGENTS.md

## Project Overview

**mc8yp** is a Cumulocity IoT MCP server.

The project exposes a single code-mode tool to AI agents instead of a large fixed toolset:

- `codemode` runs an async JavaScript function in a sandbox where API discovery, documentation search, and typed live API calls are all available as globals:
  - `codemode.search(query)` / `codemode.describe(target?)` — ranked method search and on-demand TypeScript interface rendering over operations derived from the OpenAPI specs
  - `docs.search(query, opts?)` / `docs.read(id)` — MiniSearch-backed fuzzy full-text search over spec prose (tag docs like query-language grammars, info blocks, operation/parameter descriptions)
  - `c8y` (core, always present) plus one namespace per service available on the tenant (e.g. `dtm`) — one typed method per derived operation. Namespaces are the COMPLETE sandbox surface: there is no raw-request escape hatch, and the backing protocol (OpenAPI vs MCP) is deliberately invisible to the agent
  - services that declare `exposeMcpServers` in their manifest are wrapped from their **MCP server** instead (one typed method per MCP tool) — MCP is preferred over the OpenAPI spec when a service has both, with a per-connection opt-out (`mc8yp-no-mcp` header / `noMcp` query / `--no-mcp` CLI flag) that falls back to the spec
- `status` is available only in CLI mode: it lists the active tenant, stored credentials, and the API namespaces currently visible. It accepts `{ refresh: true }` to force a fresh API discovery on demand (noop when no tenant is active). Server mode has no in-protocol equivalent yet — use the `POST /refresh-apis` HTTP route for ops-driven refresh; an in-protocol server-side flow will land in a separate PR.

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
    execute.ts                Sandbox runtime: module assembly, host-side request dispatch, safeFetch wiring
    derive-operations.ts      OpenAPI spec → derived typed operations (cached by spec identity)
    namespaces.ts             Per-connection namespace assembly with policy filtering
    describe.ts               codemode.describe rendering (overview / namespace listing / method types)
    method-search.ts          MiniSearch-backed fuzzy method search (codemode.search), index cached per tenant
    docs-index.ts             Host-side MiniSearch index over spec tag topics + overviews (docs.search / docs.read)
    operation-naming.ts       Method naming policy: sanitized operationId, readable method+path synthesis fallback
    type-render.ts            JSON Schema → TypeScript declaration rendering
  ctx/
    auth.ts                   Per-request auth context for server mode
  prompts/
    codemode.ts               `code-mode-guide` prompt
    index.ts                  Prompt registration
  tools/
    codemode.ts               `codemode` tool definition
    status.ts                 `status` tool (CLI only: active tenant + stored credentials + visible namespaces + on-demand refresh)
    index.ts                  Tool registration
  types/
    mcp-context.ts            MCP custom context shape
  utils/
    capability-discovery.ts          Per-tenant live capability discovery (OpenAPI specs + MCP servers) with 30-min refresh cache
    auth.ts                   Authorization header parsing for server mode
    c8y-types.ts              Cumulocity-specific shared types
    client.ts                 Auth/header resolution for live requests
    credentials.ts            OS keyring credential storage and lookup
    mcp-client.ts             Minimal streamable-HTTP MCP client (tools only, no elicitation/sampling)
    restriction-matcher.ts    Restriction compilation and path matching helpers
    restrictions.ts           Restriction parsing, query handling, and the noMcp opt-out
    schema.ts                 Shared schema helpers
    capability-resolution.ts        `resolveCapabilities` plus the shared `Spec`/`PathItem`/`OperationInfo` types
test/
  excute.test.ts              Integration tests against the real sandbox (dispatch, policy, discovery, markers)
  derive-operations.test.ts
  describe.test.ts
  docs-index.test.ts
  method-search.test.ts
  type-render.test.ts
  mcp-namespaces.test.ts      MCP namespace assembly, prefer-MCP rule, noMcp parsing, describe rendering
  e2e-mcp.test.ts             Full middleman e2e: MCP client → mc8yp over HTTP → sandbox → mock downstream MCP (tmcp+srvx)
  restriction-core.test.ts
  restrictions.test.ts
  restrictions.bench.ts
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
2. It accepts `--spec` / `-s` to select the bundled core-versioned OpenAPI build the `c8y` namespace derives from.
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
- `src/tools/codemode.ts` defines the `codemode` tool.
- `src/prompts/codemode.ts` defines the `code-mode-guide` prompt.

## Codemode Behavior

`src/codemode/execute.ts` is the main control surface for sandbox execution.

- The runtime uses [`@iso4/sandbox`](https://www.npmjs.com/package/@iso4/sandbox) (>= 0.2.x) — a V8-isolate sandbox running in a separate Rust subprocess — with a 128 MB memory limit, 50 s CPU / 120 s wall time, and 200 bridge calls per run. A single lazy-initialised `Sandbox` is shared across all `codemode` calls; iso4's connection pool serialises runs across isolate slots.
- Execution is module-based, not string-preamble-based: a **static entry module** imports the `mc8yp:api` host module and the `mc8yp:agent` source module, wires the API exports onto `globalThis` (`codemode`, `docs`, one global per namespace), and calls the agent function. The agent's code is wrapped into its own ESM module (`mc8yp:agent`) — the only string interpolation left in the pipeline.
- `mc8yp:api` is an iso4 **host module**: a plain object whose function leaves become bridge stubs inside a generated ESM module. Its shape is `{ codemode: { search, describe }, docs: { search, read }, namespaces: { c8y: { <method>..., request }, ... } }`, assembled per run by `buildApiModule`.
- Every live call on an OpenAPI-backed namespace dispatches host-side through `performRequest`, which builds the URL and invokes the `createSafeFetch` handler directly; MCP-backed methods dispatch through the per-run `McpHttpClient` session. The safeFetch middleware injects auth headers (last write wins so the agent cannot override), evaluates restriction/allow rules, and parses/unwraps responses. The sandbox has **no fetch surface at all**.
- Operation derivation (`deriveOperations`) is cached in a WeakMap by spec object identity and MUST stay policy-independent; per-connection policy filtering happens in `buildNamespaces` at namespace-assembly time. The docs index (`getDocsIndex`) is likewise cached by resolved-specs identity with policy applied at query time via an `isHidden` predicate.
- Operations annotated `x-mc8yp-exclude: true` in a spec are skipped by derivation and the docs index. With no escape hatch, exclusion is absolute for the sandbox.
- Input code is normalized before execution so fenced code blocks can still run.
- In CLI mode with no active tenant, execution degrades instead of failing: discovery (search/describe/docs) works against the bundled reference specs while the live-call dispatchers throw the missing-auth error.

### MCP Server Wrapping

- Discovery reads `exposeMcpServers` from application manifests (only `type: "http"` entries; first valid entry per contextPath wins; mc8yp's own contextPath is skipped to prevent recursion) and fetches each server's tool list during the discovery run — namespace building needs no live round-trips. Tool CALLS at runtime always run as the end user (auth forwarded when `sendAuthentication`), via one lazily-opened MCP session per namespace per run, closed after the run.
- **Prefer-MCP rule**: a service with both `exposeMcpServers` and `openApiSpec` is wrapped as an MCP namespace and its spec is skipped. The per-connection `noMcp` opt-out flips it back to the spec; an opted-out service with no spec gets no namespace. Resolution keeps BOTH views in `TenantCapabilities` so the choice happens per connection in `buildNamespaces`.
- The cached method index covers the UNION of the MCP-preferred and spec views, so any connection's visible-targets predicate finds its methods; the docs index is built from the spec view only (MCP tools carry no tag docs).
- `src/utils/mcp-client.ts` is a deliberate minimal client: initialize (EMPTY capability set — no elicitation, no sampling, no roots), tools/list with cursor pagination, tools/call with result unwrap (structuredContent → joined-text JSON parse → raw; `isError` throws). Spec-compliant downstream servers therefore never send server→client requests; a non-compliant one gets a JSON-RPC error naming the limitation. Elicitation/sampling pass-through is future work (suspend/resume via durable isolates).
- **Policy gap (documented)**: path-based restriction/allow rules do NOT apply to MCP tools — they have no METHOD:path identity. The `noMcp` opt-out is currently the only per-connection lever for MCP namespaces.
- **The backing protocol is invisible to the agent by design**: no `kind` field in search results, no protocol markers in describe/overview output, no per-namespace escape hatches (`request` and `callTool` were removed — MCP's `tools/list` is complete by protocol, and the OpenAPI hatch carried no knowledge the agent lacks). Search entries for MCP-backed methods simply omit `httpMethod`/`apiPath`. What backs a namespace is a host concern.

### Bundled OpenAPI Selection

There are exactly two virtual modules:

- **`#core-openapi`** — the always-available core spec. Exports `specs`, `getCoreOpenApiSpec()`, `getCoreOpenApiVersion()`, `setCoreOpenApiVersion()`, `getCoreOpenApiLabel()`. Core is the only spec with a fixed namespace name (`c8y`, `CORE_NAMESPACE` in `src/codemode/namespaces.ts`).
- **`#bundled-services`** — a generic registry of all bundled service-backed specs (DTM today). Exports `BUNDLED_SERVICE_SPECS: ReadonlyArray<BundledServiceSpec>` where each entry has `{ contextPath, appLabel, specLabel, servicePrefix, spec }`. The plugin loops every entry in `openapi-builds.json` `sources.*` that has a `servicePrefix` and inlines the resolved version for that build, with paths already rewritten via `rewriteSpecPaths`.

Both modules return `Spec`-typed data (not `unknown`); the `Spec`/`PathItem`/`OperationInfo` types live in `src/utils/capability-resolution.ts` and are referenced from `src/openapi-modules.d.ts`.

Build-time behaviour:

- For the CLI build the core plugin inlines all `openapi/core/*.json` snapshots and `setCoreOpenApiVersion` switches between them at runtime. The bundled-services plugin inlines the `default` version of each service-backed source.
- For each server build, the plugins inline exactly the configured core+services combination for that build, taken from `builds[].apis`.
  - Types for both virtual modules live together in `src/openapi-modules.d.ts`; no `tsconfig.paths` entry is needed.
  - `openapi-builds.json` is the source of truth for both the download URLs used by `scripts/update-openapi.mjs` and the server build/package matrix used by `tsdown.config.ts` and `scripts/package-microservices.mjs`.
  - `tsdown.config.ts` emits one server bundle per supported build version into `.output/<version>/`.
  - `scripts/package-microservices.mjs` turns those built server outputs into one Docker-based zip per build, for example `mc8yp-core-2026-dtm-v2.x.x.zip`.
  - The packaging script writes a temporary generated Dockerfile under `.c8y/`, builds from the repository root, copies the selected `.output/<version>/` bundle into `/app/server/`, and installs production dependencies inside the Linux image with pnpm before copying them into the runtime stage.
  - The packaging script builds Docker images for `linux/amd64` by default so release zips created on Apple Silicon remain deployable in typical Cumulocity environments; override with `DOCKER_PLATFORM` only when you intentionally need a different target.

### The Sandbox Surface

- `codemode` expects an async JavaScript function expression and returns successful results in Toon format.
- Discovery, documentation, and live calls compose inside one run: `codemode.search` → `codemode.describe` → `c8y.<method>({...})` without leaving the sandbox.
- Namespace names: `c8y` for core (always present) plus `sanitizeToolName(contextPath)` per available service. An unavailable service simply has **no global** — agent code checks `typeof dtm !== 'undefined'` before reaching into an optional surface.
- Method names come from `operationName` in `src/codemode/operation-naming.ts`: the sanitized `operationId` when present (all bundled specs have full coverage; Cumulocity's convention embeds the HTTP verb, e.g. `getAlarmCollectionResource` vs `postAlarmCollectionResource` on the same path), otherwise a readable camelCase synthesis from method+path where `{param}` segments become `By<Param>` (`GET /alarm/alarms/{id}` → `getAlarmAlarmsById`). Method input is a single flat object: path/query/header parameters as top-level keys, request payload under `body`. Output types render from the first 2xx JSON response schema.
- Rendered property JSDoc carries the description plus one compact tag line: `@minimum`/`@maximum`, `@example`, and `@format` (e.g. `@format c8y:query`, the docs.search hook). Deliberately excluded: `@default`, `@minLength` (113× `minLength: 1` noise in core), and `@explode` — serialization is handled host-side, so the tag would only invite the agent to pre-encode values.
- Query serialization honours per-parameter `explode`: arrays for `explode: false` params (nearly all Cumulocity multi-value params — the spec prose says "comma-separate the values") are comma-joined into one key by `toRequest`; the OpenAPI default stays repeated keys.
- Reserved namespaces: `codemode`, `docs`, `c8y`, `cumulocity` (`RESERVED_NAMESPACES`); reserved method name per namespace: `request`. Colliding services/operations are skipped with a warning.
- `codemode.describe("<ns>")` deliberately returns a one-line-per-method **listing**, not full types — core has ~250 operations and a full typed block would flood context. Full input/output types are method-level (`describe("<ns>.<method>")`).
- Policy-blocked operations are omitted from namespaces, search results, describe output, and docs hits; blocked live requests additionally fail in the middleware before network access (two layers, both required — the second covers template-vs-concrete path gaps, e.g. a rule targeting a concrete id that the templated method's visibility check cannot see).
- The set of operation keys walked during derivation/doc-indexing is `OPERATION_KEYS` in `derive-operations.ts`, derived from the shared `HTTP_METHODS` constant in `src/utils/restrictions.ts` (which includes the new `QUERY` method) — one source of truth for spec walking and restriction parsing.
- `docs.search` contains ONLY tag topics and spec info overviews — endpoints contribute nothing to the docs index. Per-endpoint prose (operation description, parameter docs) is delivered by `codemode.describe("<ns>.<method>")`, and finding endpoints is `codemode.search`'s job. The discovery chain for domain syntax is: param JSDoc says "details in Query language" → the agent turns that phrase into `docs.search("query language")` → the topic title match ranks first → `docs.read` returns the grammar (pinned by a real-spec test). No cross-reference/anchor tracing exists by design.

### Restrictions

Restrictions and allow rules both use the format `[METHOD:]<path-pattern>`.

- Restrictions are deny rules.
- Allow rules are allow-list entries. When any allow rule exists, requests must match at least one allow rule unless a restriction blocks them first.
- Restrictions take priority over allow rules.
- In microservice mode, prefer the project-scoped `mc8yp-restriction` and `mc8yp-allow` headers for HTTP policy transport; repeated headers and comma-separated values are both accepted.
- Bundled services that are not installed on the tenant simply get no namespace. The connection-level restriction/allow policy is the only access layer above the Cumulocity API itself.

The restriction system is implemented in two places:

- `src/utils/restrictions.ts` parses both deny rules and allow rules and handles CLI/query input.
- `src/utils/restriction-matcher.ts` owns rule compilation, path matching, and restriction-vs-allow precedence.
- Enforcement lives on the host in two spots: `buildNamespaces` (`src/codemode/namespaces.ts`) filters blocked operations out of discovery, and the safeFetch middleware in `src/codemode/execute.ts` calls `evaluateAccessPolicy` before any HTTP request leaves the host. Discovery filtering is a UX optimization; the middleware is the actual security boundary.

## Authentication And Credentials

### CLI mode

- Credentials are stored with `@napi-rs/keyring` in the OS credential manager.
- `src/utils/credentials.ts` is the source of truth for storing, listing, resolving, and deleting tenant credentials.
- Stored credentials are normalized by tenant URL.
- User/password credentials may resolve and persist the tenant ID if it is not provided.
- The active tenant is persisted to `~/.config/mc8yp/active-tenant.json` by the `set-active-tenant` MCP tool. `src/cli/active-tenant.ts` owns read/write. Any read error or bad JSON shape returns null silently. With no tenant, `codemode` runs in discovery-only mode and live calls throw a descriptive missing-auth error.

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
- If you add a new bundled **service-backed** OpenAPI spec in the future: drop the JSON under `openapi/<key>/<version>.json` and add one entry under `sources.<key>` in `openapi-builds.json` with a `servicePrefix` (e.g. `"servicePrefix": "/service/<key>"`). `bundledServicesPlugin` picks it up automatically; `resolveCapabilities`, `buildNamespaces`, derivation, and the docs index all handle new entries generically. No code edits required.
- If you add a new always-available (non-service-backed) bundled spec like core: that needs a new virtual module wired into `tsdown.config.ts`, `src/openapi-modules.d.ts`, and a new fixed namespace in `src/codemode/namespaces.ts`. This is a much bigger change and the bundled-services flow is _not_ the right place for it.
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
  - codemode runtime changes (real-sandbox integration): `test/excute.test.ts`
  - operation derivation: `test/derive-operations.test.ts`
  - namespace assembly / describe rendering: `test/describe.test.ts`
  - method search ranking: `test/method-search.test.ts`
  - method naming policy: `test/operation-naming.test.ts`
  - derivation/rendering against the real bundled specs: `test/real-spec.test.ts`
  - docs indexing/search: `test/docs-index.test.ts`
  - JSON Schema → TS rendering: `test/type-render.test.ts`
  - spec resolution logic: `test/capability-resolution.test.ts`
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
4. The codemode runtime reads `TenantCapabilities` (`{ core: Spec, specs: Record<string, Spec> }`) from `c8yMcpServer.ctx.custom?.specs`. In server mode it is computed per-request by the H3 handler via `resolveCapabilities(discoveredSpecs, installedContextPaths)`. In CLI mode it is set on tenant activation by `setCliTenantContext` and falls back to `getBundledOnlyCapabilities()` (every bundled snapshot, no removal) before any tenant is active. Spec removal is unconditional inside `resolveCapabilities`: when a tenant is active the agent only sees what is reachable on that tenant. The no-tenant CLI fallback is the only path that exposes all bundled snapshots, and in that state `codemode` runs discovery-only — live calls throw the missing-auth error and the result marker says `No active tenant — discovery only`. In CLI mode only, every `codemode` result starts with a marker line (`Executed against tenant: <url>` or the no-tenant notice) so the agent can verify which tenant the result reflects. Server mode omits it — the tenant is fixed by deployment/request auth there, so the marker would just be noise. The marker reads from `c8yMcpServer.ctx.custom.auth.tenantUrl` — no extra metadata is threaded.
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

- `@iso4/sandbox` (>= 0.2.x) is the execution boundary for `codemode`. It spawns a long-lived Rust child process on first use; `disposeSandbox()` shuts it down (called from the `excute.test.ts` `afterAll` hook and via a `process.once('exit')` handler in `execute.ts`). 0.2.x adds `imports` (source modules + host modules) — the runtime is built on those instead of string preambles, and its `ResourceLimits` include `wallTimeMs` (default 30 s — must be raised explicitly when `cpuTimeMs` exceeds it).
- `@iso4/fetch` provides the hardened `safeFetch`. Its `handler` is invoked directly host-side by `performRequest` (it is no longer installed as a sandbox global); the middleware carries policy enforcement, auth injection, and response unwrapping.
- `minisearch` powers the `docs.search` prose index; it is a devDependency inlined at build time.
- `tsdown` produces separate server and CLI bundles.
- `@napi-rs/keyring` is used for local(cli) credential storage.
- `@clack/prompts` is used for interactive CLI credential entry so password input is masked.
- `@iso4/sandbox` must stay external in server builds. It depends on per-platform Rust binaries (`@iso4/v8-linux-x64-gnu`, etc.) shipped as optional dependencies, and bundling the entry would break the platform binary resolution. The microservice Dockerfile must install production dependencies inside the Linux image so the correct `@iso4/v8-linux-*` binary is fetched.

### Patterns & Conventions

- `codemode` runs a static entry module that imports the `mc8yp:api` host module and the agent's `mc8yp:agent` source module, and reads the default export from sandbox execution.
- `codemode` accepts function-expression style code and normalizes fenced code input before evaluation.
- `#core-openapi` and `#bundled-services` are virtual modules synthesized by tsdown plugins; consumers must not import the JSON snapshots directly.
- The CLI build inlines all bundled core snapshots plus the default version of every service-backed source (currently DTM `release`); each server build inlines exactly the configured combination for that build.
- Service specs land in the sandbox as one typed namespace per contextPath (bundled and live-discovered alike). Core is the only fixed namespace name (`c8y`).
- `resolveCapabilities` returns a single `{ core, specs }` object. An absent key in `specs` means the spec is unavailable for this tenant; there are no `null` values.
- API discovery lists applications via paginated `GET /application/applications?tenant=<id>&type=MICROSERVICE` (100 per page), NOT `applicationsByTenant`. The unpaginated `applicationsByTenant?pageSize=2000` response included every HOSTED web-app manifest and got cut off by the internal gateway mid-body ("Premature close") on app-heavy tenants, permanently breaking discovery for that tenant. HOSTED/EXTERNAL apps can never contribute specs (spec download goes through `/service/<contextPath>/`, microservices only), so `installedContextPaths` intentionally contains only microservice context paths.
- `@iso4/fetch` is pure JS (`rou3` + `undici`) and is bundled into both CLI and server outputs. Only `@iso4/sandbox` must stay external in all builds.
- `scripts/package-microservices.mjs` intentionally targets `linux/amd64` by default to avoid Apple Silicon release images failing with `exec format error` in Cumulocity.
- Restrictions and allow rules are both discoverability metadata and enforcement logic; both layers matter.
- When creating branches for user-requested work, prefer conventional prefixes that match the intended change type, especially `feat/`, `test/`, and `chore/`.
- If the user asks to open a PR from an already-active feature branch, treat that existing branch as the PR head by default and target `main` unless they say otherwise.
- Server-mode auth must stay request-local.
- For deployed microservice mode, prefer POST-only streamable HTTP over long-lived GET/SSE. The optional SSE channel can go inactive behind Cumulocity ingress and break later tool calls even when initialization and tool discovery succeeded.
- The `status` tool is the in-protocol on-demand refresh path for CLI mode. It busts the per-tenant discovery cache via `refreshCapabilities`, re-resolves specs, and patches both `getCliTenantContext().specs` and `c8yMcpServer.ctx.custom.specs` so the very next `codemode` call sees the new surface. There is no rate-limit — a local human-driven session has no runaway-agent risk and a forced refresh after a deploy should always work.
- Server mode has no in-protocol `status` tool yet; only the `POST /refresh-apis` HTTP route exists for ops/CI use. An in-protocol server-side equivalent (with rate-limiting) is planned for a separate PR and will need to re-introduce a tenant-ID stash on `c8yMcpServer.ctx.custom` and a global cooldown timestamp in `src/utils/capability-discovery.ts`.
- mc8yp ships its own `openapi.json` (repo root) describing the non-MCP HTTP surface (`/refresh-apis`, `/health`). It is referenced from `cumulocity.json#openApiSpec` and served by the H3 server at `GET /openapi.json` via a `with { type: 'json' }` import in `src/index.ts` so it inlines into every server bundle. When mc8yp is subscribed on a tenant, the standard discovery loop in `src/utils/capability-discovery.ts` picks it up and exposes it to agents as the `mc8yp_server` namespace (contextPath `mc8yp-server`, sanitized). The MCP endpoint at `/mcp` is intentionally NOT documented in this spec — MCP discovery is out-of-band via `tools/list`. Keep `openapi.json` in sync with any change to the HTTP surface, and never list `/mcp` there.
- CLI mode is a single stdio process; there is no IPC channel from a second terminal into the running CLI. Out-of-process triggers (e.g. "refresh from a shell after deploying") are intentionally not supported. Refresh has to flow through the in-protocol `status` tool.

- The namespace/discovery layer: host-side derivation of one typed method per OpenAPI operation (or MCP tool), `search`/`describe` as the discovery SDK, deliberately NO escape hatch — namespaces are the complete surface. Design choices to know: namespace-level describe is deliberately rejected (core is too big for full type dumps), output types are derived from response schemas, and prose docs get their own MiniSearch-backed `docs` global because name-oriented method search scores long prose poorly.
- Caches in the codemode layer (`deriveOperations` WeakMap, `getDocsIndex` WeakMap) are keyed by spec/resolved-specs object identity and MUST stay policy-independent — restrictions differ per connection in server mode. Apply policy at assembly/query time (`buildNamespaces` filter, `isHidden` predicate), never inside the cached artifact.
- `codemode.search` is MiniSearch-backed (same engine as docs), replacing the hand-tuned CF token scorer: fuzzy matching absorbs singular/plural drift and OR-combination keeps recall when a query word has no counterpart in the spec vocabulary ("list assets" still ranks `getAssets`). It accepts `string | string[]` — the calling agent is the semantic layer and passes phrasing variants in one call. The index is policy-independent and cached per tenant (same WeakMap pattern as docs/derivation); the connection's policy filters hits at query time via a visible-targets predicate. Search RESULTS are deliberately never cached: they are policy-dependent, the query keyspace is unbounded, and a query over ~300 entries costs well under a millisecond. Host main-thread impact is negligible (agent code runs in the separate Rust sandbox process); if a tenant ever surfaces thousands of operations, moving index+query into a worker_thread is a clean follow-up.
- The whole cache chain hangs on object identity: per-tenant discovery cache (30-min TTL in `capability-discovery.ts`) → memoized `resolveCapabilities` (WeakMap on the (discoveredSpecs, installedContextPaths) pair, so the server's per-request call returns the same `TenantCapabilities` for a tenant until refresh) → `deriveOperations`/`getDocsIndex` keyed on those stable objects. A discovery refresh mints new objects, everything downstream repopulates lazily, and old entries are GC'd. Do NOT "clean up" the `resolveCapabilities` memoization — removing it silently turns the docs index into a per-request rebuild.

### Common Mistakes To Avoid

- Do not assume the runtime specs are dereferenced — `preprocessOpenApi` runs with `dereference: false` at both call sites (tsdown plugin and live discovery). Parameter entries, requestBody, and response objects may still be structural `$ref`s into `components`, Cumulocity content is keyed by vendor media types (`application/vnd.com.nsn.cumulocity.*+json`, so match any `json`-bearing media type, never just `application/json`), and `{id}` path parameters are declared at the **path-item** level, not on the operation. `derive-operations.ts` handles all three (`derefObject`, `jsonContentSchema`, path-item parameter merge); any new spec-reading code must too. `test/real-spec.test.ts` exists precisely because synthetic fixtures cannot catch this class of bug.
- Do not assume tests live in `tests/`; this repository uses `test/`.
- Do not add tenant URL handling to server mode user flows; deployed mode derives tenant context from the environment and request auth.
- Do not bypass `src/codemode/execute.ts` when changing execution behavior; that file is the main runtime boundary.
- Do not rebundle `@iso4/sandbox` into any build. It resolves per-platform Rust binaries at runtime and cannot be statically inlined. `@iso4/fetch` is already bundled and does not need special treatment.
- Do not pass an account/tenant URL as the second argument of `@napi-rs/keyring`'s `findCredentialsAsync` — that parameter filters by keyring _target_, not account. Entries are stored with the default target, so on macOS the filter is ignored and every entry for the service is returned (issue #42: `[0]` silently resolved to the wrong tenant's credentials), while libsecret/WSL2 backends can return empty. Always list all entries for the service and match by cleaned account (`cleanTenantUrl(entry.account)`), the way `getCredentialsByTenantUrl` and `deleteStoredC8yAuth` do.
