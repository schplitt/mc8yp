// ─────────────────────────────────────────────────────────────────────────
// Grounded retrieval eval set for the spec-search bake-off.
//
// Every `expect` / `crossRef` sourceId below was verified to exist in the real
// bundled specs (openapi/core/release.json, openapi/dtm/release.json) and to
// actually contain the relevant content. sourceId format mirrors the chunker:
//   `${spec}::spec` | `${spec}::tag::${name}` | `${spec}::op::${method}::${path}`
//
// Case kinds, hardest first:
//   • vocab-gap — the user's word (e.g. "tree") is ABSENT from the corpus; the
//     capability lives under different words (hierarchyof/bygroupid).
//   • deep      — the capability is real but buried in a long description / tag
//     prose / param text; no path or summary reveals it by name.
//   • cross-ref — the capability the agent needs lives in a DIFFERENT spec (or
//     a different tag) than the endpoint the query lexically matches. The
//     `crossRef` chunk is what neighbour expansion must surface.
//   • normal    — ordinary endpoint lookup; sanity that base retrieval holds.
// ─────────────────────────────────────────────────────────────────────────

export interface EvalCase {
  query: string
  /**
   * What makes this case interesting / why keyword search struggles.
   */
  note: string
  kind: 'vocab-gap' | 'deep' | 'cross-ref' | 'normal'
  /**
   * A hit on ANY of these sourceIds (primary OR related) counts as found.
   */
  expect: string[]
  /**
   * The specific chunk we hope NEIGHBOUR EXPANSION surfaces even when it is not
   * a direct hit on the query. Its appearance in `related` is the proof that
   * cross-reference following works.
   */
  crossRef?: string
}

export const EVAL_SET: EvalCase[] = [
  // ── vocabulary gap: the searched word is absent; concept is elsewhere ──
  {
    query: 'walk the device tree',
    note: '"tree" appears nowhere in the corpus; capability is hierarchyof()/bygroupid() in the Query language tag',
    kind: 'vocab-gap',
    expect: ['core::tag::Query language', 'core::op::get::/inventory/managedObjects/{id}/childAssets'],
  },
  {
    query: 'traverse the asset hierarchy on the server instead of looping',
    note: 'should point at server-side hierarchy operators, not manual traversal',
    kind: 'vocab-gap',
    expect: ['core::tag::Query language', 'core::op::get::/inventory/managedObjects/{id}/childAssets'],
  },
  {
    query: 'match objects belonging to a group and all its descendants',
    note: 'descendants/group → bygroupid()/hierarchyof()',
    kind: 'vocab-gap',
    expect: ['core::tag::Query language'],
  },
  {
    query: 'sort the results of a query by a field ascending',
    note: '$orderby — only documented in the Query language tag description',
    kind: 'vocab-gap',
    expect: ['core::tag::Query language'],
  },
  {
    query: 'objects that are direct children of a given device',
    note: 'childAssets/childDevices subresource + query operators',
    kind: 'vocab-gap',
    expect: ['core::op::get::/inventory/managedObjects/{id}/childDevices', 'core::op::get::/inventory/managedObjects/{id}/childAssets', 'core::tag::Query language'],
  },

  // ── deep: capability buried in description / tag prose, not in any path ──
  {
    query: 'idempotent create or update of an asset coming from an external system',
    note: 'documented deep inside the DTM Assets tag prose (c8y_ExternalId upsert), not in any path/summary',
    kind: 'deep',
    expect: ['dtm::tag::Assets'],
  },
  {
    query: 'which permissions or roles are required to create or delete assets',
    note: 'ROLE_DIGITAL_TWIN_ASSETS_* explained deep in the DTM Assets tag prose',
    kind: 'deep',
    expect: ['dtm::tag::Assets'],
  },
  {
    query: 'subscribe to real-time notifications when inventory objects change',
    note: 'capability is the Notifications 2.0 / Real-time API, discoverable from prose not from a guessable path',
    kind: 'deep',
    expect: ['core::tag::Real-time notification API', 'core::tag::Subscriptions', 'core::op::post::/notification2/subscriptions'],
  },
  {
    query: 'aggregate measurement values into a series over a time range',
    note: 'measurement series/aggregation endpoint; "aggregate" not in path name',
    kind: 'deep',
    expect: ['core::op::get::/measurement/measurements/series'],
  },
  {
    query: 'find which measurement series a device supports',
    note: 'supportedSeries subresource on a managed object',
    kind: 'deep',
    expect: ['core::op::get::/inventory/managedObjects/{id}/supportedSeries'],
  },
  {
    query: 'submit many device operations at once in one request',
    note: 'bulk operations — capability lives in the Bulk operations tag',
    kind: 'deep',
    expect: ['core::tag::Bulk operations'],
  },

  // ── cross-ref: endpoint in one spec, needed capability in another ──
  {
    query: 'how do I filter DTM assets by a property value',
    note: 'DTM /assets ?query links by URL to core Query language; expansion should surface the core operator docs',
    kind: 'cross-ref',
    expect: ['dtm::op::get::/assets', 'dtm::tag::Assets'],
    crossRef: 'core::tag::Query language',
  },
  {
    query: '$filter query syntax and operators for assets',
    note: 'classic cross-spec case: $filter documented in core Query language, used by DTM',
    kind: 'cross-ref',
    expect: ['dtm::op::get::/assets', 'core::tag::Query language'],
    crossRef: 'core::tag::Query language',
  },
  {
    query: 'look up an asset by its external system identifier',
    note: 'DTM external id; the External IDs / Identity API that backs it lives in core',
    kind: 'cross-ref',
    expect: ['dtm::op::get::/assets/externalIds/{externalId}'],
    crossRef: 'core::tag::Identity API',
  },
  {
    query: 'attach time-series measurement data to an asset',
    note: 'DTM linked series; the underlying measurement series capability is core',
    kind: 'cross-ref',
    expect: ['dtm::tag::Linked Series', 'dtm::op::get::/assets/{assetId}/linkedSeries'],
    crossRef: 'core::op::get::/measurement/measurements/series',
  },
  {
    query: 'find sub-assets of an asset',
    note: 'DTM hierarchy subresource; related core hierarchy operators are the cross-ref',
    kind: 'cross-ref',
    expect: ['dtm::op::get::/assets/{assetId}/subAssets'],
    crossRef: 'core::tag::Query language',
  },
  {
    query: 'resolve a managed object from an external id and type',
    note: 'within core but cross-tag: endpoint under Identity, concept in External IDs tag',
    kind: 'cross-ref',
    expect: ['core::op::get::/identity/externalIds/{type}/{externalId}'],
    crossRef: 'core::tag::External IDs',
  },

  // ── normal lookups (sanity: ordinary retrieval must not regress) ──
  {
    query: 'list the child assets of a managed object',
    note: 'subresource endpoint; childAssets also referenced in Query language tag',
    kind: 'normal',
    expect: ['core::op::get::/inventory/managedObjects/{id}/childAssets', 'core::tag::Query language'],
  },
  {
    query: 'filter managed objects by name in a single request',
    note: 'query param on the list endpoint + operator syntax in the tag',
    kind: 'normal',
    expect: ['core::op::get::/inventory/managedObjects', 'core::tag::Query language'],
  },
  {
    query: 'list active alarms',
    note: 'plain endpoint lookup',
    kind: 'normal',
    expect: ['core::op::get::/alarm/alarms'],
  },
  {
    query: 'create a new event',
    note: 'plain endpoint lookup',
    kind: 'normal',
    expect: ['core::op::post::/event/events'],
  },
  {
    query: 'read measurements for a device',
    note: 'plain endpoint lookup',
    kind: 'normal',
    expect: ['core::op::get::/measurement/measurements'],
  },
  {
    query: 'list managed objects in the inventory',
    note: 'plain endpoint lookup',
    kind: 'normal',
    expect: ['core::op::get::/inventory/managedObjects'],
  },
  {
    query: 'get assets from the digital twin manager',
    note: 'plain DTM endpoint lookup',
    kind: 'normal',
    expect: ['dtm::op::get::/assets'],
  },
  {
    query: 'schema governance and asset definitions',
    note: 'DTM concept living in the Assets tag / definitions endpoint',
    kind: 'normal',
    expect: ['dtm::tag::Assets', 'dtm::op::get::/definitions/assets'],
  },
]
