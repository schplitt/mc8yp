# AGENTS

## Restriction Model

- MCP HTTP requests may include repeated `restriction` query parameters.
- Restrictions are deny rules, not allow rules.
- A rule may be `METHOD:/path/**` or just `/path/**`.
- A rule without a method blocks all methods for matching paths.
- Query strings are ignored during restriction matching.

## Enforcement Layers

- The OpenAPI spec shown to code mode must keep blocked operations visible.
- Blocked operations must preserve the original OpenAPI summary and description.
- Blocked operations are annotated with `x-mc8yp-restricted` and related `x-mc8yp-*` metadata.
- Secure-exec network permissions are the enforcement point for blocked requests in execute mode.
- Do not duplicate restriction matching logic inside the generated execute script.
- Runtime restriction checks are path-based and must not depend on tenant origin or a fully qualified tenant URL.
- Execute-mode network permissions should only allow `fetch` operations.

## Runtime Rules

- Do not cache secure-exec runtimes between requests.
- Create runtimes on demand and dispose them after use.
- Keep separate runtime creation paths for query and execute when their permissions differ.
- Keep at most 3 code-mode runtimes active concurrently.

## Parsing

- Use `ufo` in server/main code when request URL parsing is needed.
- Do not add runtime dependencies inside the generated sandbox modules.

## Testing

- Restriction matching is security-sensitive and must have dedicated unit tests.
- Add Vitest benchmarks for matcher and spec rewrite hot paths when changing restriction logic.
- Test path matching, method matching, top-level spec annotations, and runtime concurrency limits.