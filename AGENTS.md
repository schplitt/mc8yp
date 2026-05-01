# AGENTS.md

## Project Overview

**mc8yp** is a Cumulocity IoT MCP server.

The project exposes a small code-mode surface to AI agents instead of a large fixed toolset:

- `query` inspects the bundled Cumulocity OpenAPI spec
- `execute` calls the live Cumulocity API through a sandboxed request helper
- `list-credentials` is available only in CLI mode to inspect locally stored tenants

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
    openapi-restrictions.ts   OpenAPI restriction annotation
    semaphore.ts              Concurrency limiter for sandbox execution
  ctx/
    auth.ts                   Per-request auth context for server mode
  prompts/
    codemode.ts               `code-mode-guide` prompt
    index.ts                  Prompt registration
  tools/
    codemode.ts               `query` and `execute` tool definitions
    credentials.ts            `list-credentials` tool
    index.ts                  Tool registration
  types/
    mcp-context.ts            MCP custom context shape
  utils/
    auth.ts                   Authorization header parsing for server mode
    c8y-types.ts              Cumulocity-specific shared types
    client.ts                 Auth/header resolution for live requests
    credentials.ts            OS keyring credential storage and lookup
    restriction-core.ts       Restriction parsing and matching (path.matchesGlob-based)
    restrictions.ts           Restriction query parsing and network decisions
    schema.ts                 Shared schema helpers
test/
  excute.test.ts
  openapi-restrictions.test.ts
  restriction-core.test.ts
  restrictions.test.ts
  restrictions.bench.ts
  semaphore.test.ts
core-openapi/
  release.json               Bundled latest Cumulocity core OpenAPI snapshot
  2026.json                  Bundled 2026 Cumulocity core OpenAPI snapshot
  2025.json                  Bundled 2025 Cumulocity core OpenAPI snapshot
  2024.json                  Bundled 2024 Cumulocity core OpenAPI snapshot
scripts/
  cumulocity.mjs             Updates cumulocity.json metadata from package.json
  package-microservices.mjs  Builds versioned Docker-based Cumulocity release zips
tsdown.config.ts              CLI/server build configuration plus the `#core-openapi` virtual module plugin
src/core-openapi.d.ts         Ambient type declarations for the `#core-openapi` virtual module
```

### Runtime Flow

#### CLI mode

1. `src/cli/index.ts` parses CLI arguments and restriction flags.
2. It accepts `--spec` / `-s` to select the bundled core OpenAPI snapshot exposed by `query`.
3. It sets `globalThis.executionEnvironment = 'cli'`.
4. It exposes credential lookup helpers on `globalThis` for tools and subcommands.
5. It starts the shared MCP server over stdio transport.

#### Microservice mode

1. `src/index.ts` starts the HTTP server and exposes `/mcp` and `/health`.
2. It sets `globalThis.executionEnvironment = 'server'`.
3. It extracts auth from request headers and restrictions from query parameters.
4. It stores auth in request-local context and forwards the request to the shared MCP server.

#### Shared MCP surface

- `src/server.ts` creates the MCP server, registers tools and prompts, and conditionally enables `list-credentials` only in CLI mode.
- `core-openapi/` contains the versioned Cumulocity core OpenAPI snapshots consumed by the build.
- `src/tools/codemode.ts` defines the `query` and `execute` tools.
- `src/prompts/codemode.ts` defines the `code-mode-guide` prompt.

## Codemode Behavior

`src/codemode/execute.ts` is the main control surface for sandbox execution.

- `query` executes JavaScript against the selected bundled core OpenAPI spec with network access disabled.
- `execute` executes JavaScript with a provided `cumulocity.request()` helper.
- Both runtimes use `secure-exec` with a 128 MB memory limit and 50 second CPU time limit.
- A semaphore limits concurrent sandbox runs to 3.
- Input code is normalized before execution so fenced code blocks can still run.

### Core OpenAPI Selection

- All consumers import from the virtual module `#core-openapi`, which exposes `getCoreOpenApiSpec`, `getCoreOpenApiVersion`, `setCoreOpenApiVersion`, and `getCoreOpenApiLabel`.
- The module body is synthesized by a small tsdown plugin in `tsdown.config.ts`:
  - For the CLI build the plugin inlines all `core-openapi/*.json` snapshots and `setCoreOpenApiVersion` switches between them at runtime.
  - For each server build the plugin inlines exactly one snapshot and `setCoreOpenApiVersion` only accepts that build's version.
- Types for the virtual module live in `src/core-openapi.d.ts` (ambient `declare module '#core-openapi'`); no `tsconfig.paths` entry is needed.
- `tsdown.config.ts` emits one server bundle per supported core OpenAPI version into `.output/<version>/`.
- `scripts/package-microservices.mjs` turns those built server outputs into one Docker-based zip per version for releases.

### Query vs Execute

- `query` expects a JavaScript function expression and returns strings directly or other values as JSON text.
- `execute` expects a JavaScript function expression and returns successful results in Toon format.
- Restricted operations remain visible in the OpenAPI spec, but blocked live requests fail before network access.

### Restrictions

Restrictions are deny rules with the format `[METHOD:]<path-pattern>`.

The restriction system is implemented in two places:

- `src/codemode/openapi-restrictions.ts` annotates blocked OpenAPI operations with `x-mc8yp-*` metadata.
- `src/utils/restrictions.ts` and `src/utils/restriction-core.ts` enforce matching rules for live requests and query parsing.

Path matching uses Node.js `path.matchesGlob` (available from Node.js 22+). The `matchesRestrictionPath` helper adds one edge-case workaround: patterns ending with `/**` also match the base path (e.g. `/inventory/**` matches `/inventory`), which `matchesGlob` on older Node builds does not do natively.

The sandbox prelude injected by `buildExecuteScript` uses `matchesGlob` from the Node.js `node:path` module via a top-level ESM `import`. A small inline `matches` helper in the prelude applies the same `/**` edge-case fix.

Restriction evaluation uses **first-match semantics** (`findBlockedRestriction` returns the first matching rule). When a request is blocked, the error message contains only the method and path — not the full list of matching rules. This is intentional: agents do not need to know which specific restriction fired.

This dual behavior is intentional: agents can still inspect restricted operations for context, but cannot execute them through the same MCP connection.

## Authentication And Credentials

### CLI mode

- Credentials are stored with `@napi-rs/keyring` in the OS credential manager.
- `src/utils/credentials.ts` is the source of truth for storing, listing, resolving, and deleting tenant credentials.
- Stored credentials are normalized by tenant URL.
- User/password credentials may resolve and persist the tenant ID if it is not provided.

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
- Release zip artifacts are created in the repository root by `pnpm package:microservices`

## Code Style And Conventions

- ESM only (`"type": "module"`)
- TypeScript strict mode enabled
- Node.js `>=24.0.0`
- Keep the MCP registration surface in `src/server.ts`, `src/tools/`, and `src/prompts/`
- Keep restriction parsing and matching logic in `src/utils/restriction-core.ts` and `src/utils/restrictions.ts`
- Keep sandbox/runtime behavior in `src/codemode/execute.ts` rather than duplicating execution logic in tools
- Prefer mode-aware behavior instead of branching deep in unrelated modules

### Practical editing guidance

- If a change affects tool behavior, inspect both the tool definition and the codemode runtime.
- If a change affects core OpenAPI selection, update the `#core-openapi` plugin in `tsdown.config.ts` and the ambient declaration in `src/core-openapi.d.ts`.
- If a change affects restrictions, verify both spec annotation behavior and live request blocking.
- If a change affects auth, verify the CLI and server paths separately.
- If a change affects public MCP behavior, update `README.md` as well as this file.

## Testing

- Tests live in `test/`
- Use `*.test.ts` for tests and `*.bench.ts` for benchmarks
- Prefer adding targeted tests near the affected behavior:
  - restriction parsing/matching changes: `test/restriction-core.test.ts` or `test/restrictions.test.ts`
  - OpenAPI annotation changes: `test/openapi-restrictions.test.ts`
  - codemode runtime changes: `test/excute.test.ts`
  - concurrency behavior: `test/semaphore.test.ts`

Run these before finishing meaningful changes:

1. `pnpm test:run`
2. `pnpm lint`
3. `pnpm typecheck`

## Maintaining Documentation

When making changes to the project:

- **`AGENTS.md`** — Update with repo-specific architecture, workflows, conventions, and implementation notes for coding agents
- **`README.md`** — Update for any user-facing MCP behavior changes, new prompts/tools, changed CLI usage, changed restrictions behavior, deployment changes, or credential changes

## Agent Guidelines

When working on this project:

1. Start from the actual controlling surface. For most feature work that is `src/tools/`, `src/prompts/`, `src/codemode/execute.ts`, or restriction/auth utilities.
2. Treat CLI mode and microservice mode as separate execution environments with different auth and tool availability.
3. Run focused tests first when changing a narrow subsystem, then run the full validation set if the change is broader.
4. Do not remove restriction annotations from the OpenAPI view just because execution is blocked; visibility and enforcement are intentionally separate.
5. Keep public MCP tool and prompt descriptions aligned with actual runtime behavior.
6. Preserve the current sandbox limits and request boundary logic unless the task explicitly changes them.
7. Record recurring project-specific lessons in the section below when they are likely to prevent future mistakes.
8. Notify the user when `AGENTS.md` or `README.md` has changed so those docs can be reviewed explicitly.

## Project Context & Learnings

This section captures project-specific knowledge, tool quirks, and lessons learned during development. Add recurring patterns here when they are likely to matter again.

### Tools & Dependencies

- `secure-exec` is the execution boundary for both `query` and `execute`.
- `tsdown` produces separate server and CLI bundles.
- `@napi-rs/keyring` is used for local(cli) credential storage.

### Patterns & Conventions

- `execute` uses a generated ESM module entry and reads the default export from sandbox execution.
- `query` and `execute` accept function-expression style code and normalize fenced code input before evaluation.
- `#core-openapi` is a virtual module synthesized by a tsdown plugin; consumers must not import the JSON snapshots directly.
- The CLI build inlines all `core-openapi/*.json` snapshots; each server build inlines exactly one.
- Restrictions are both discoverability metadata and enforcement logic; both layers matter.
- Path matching uses `path.matchesGlob` from `node:path`. The `matchesRestrictionPath` helper wraps it with a `/**` edge-case fix.
- The sandbox prelude imports `matchesGlob` via a top-level ESM `import` added by `buildExecuteScript`. The test harness injects it as a `new Function` parameter.
- Restriction evaluation is **first-match**: `findBlockedRestriction` returns the first matching rule. `evaluateRestrictions` returns a `matchingRule` (single, not array).
- Server-mode auth must stay request-local.

### Common Mistakes To Avoid

- Do not assume tests live in `tests/`; this repository uses `test/`.
- Do not add tenant URL handling to server mode user flows; deployed mode derives tenant context from the environment and request auth.
- Do not bypass `src/codemode/execute.ts` when changing execution behavior; that file is the main runtime boundary.
- Do not try to use external npm packages in the sandbox prelude (including bundled devDependencies). The prelude is a serialized ESM module that only has access to Node.js built-ins. Only `node:path` (for `matchesGlob`) and other Node built-ins are safe to import.