/**
 * Internal $ref resolution for OpenAPI documents.
 *
 * Both the build-time bundled specs (tsdown.config.ts) and the live-discovered
 * specs (api-discovery.ts) are run through this before use so consumers — the
 * code-mode query sandbox, prompt builders, tool generation — see fully inlined
 * schemas instead of `$ref` pointers.
 */

import $RefParser from '@apidevtools/json-schema-ref-parser'

/**
 * Dereference same-document ($ref: "#/...") pointers in place and return the
 * spec with refs inlined.
 *
 * - External file/URL resolution is disabled (`resolve.external = false`), so
 *   the operation is purely in-memory: no disk or network access, and only
 *   internal references are touched.
 * - Circular references are left untouched (`circular: 'ignore'`) so the result
 *   stays JSON-serialisable. The specs are later `JSON.stringify`'d into the
 *   sandbox entry script and inlined into the build output; a dereferenced
 *   circular structure would throw "Converting circular structure to JSON".
 *
 * On any parser error the original spec is returned unchanged so a malformed
 * or unusual document never breaks spec loading.
 * @param spec OpenAPI document to dereference. Mutated in place on success.
 */
export async function resolveInternalRefs<T extends object>(spec: T): Promise<T> {
  try {
    return await $RefParser.dereference(spec, {
      resolve: { external: false },
      dereference: { circular: 'ignore' },
    }) as T
  } catch {
    return spec
  }
}
