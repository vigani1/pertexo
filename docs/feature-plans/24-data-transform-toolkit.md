# F24 — Discoverable data transforms and batch tools

Status: proposed plan; not implementation-authorized by this document.
Created: 2026-09-28. Parent: [product roadmap](../product-roadmap.md).
Scope: New node UX over existing mapping/JSONata foundations. Relative size: **L**, not a calendar estimate.

## Outcome

Users perform common data preparation without needing to write expressions for every routine operation.

## Current implementation and evidence

Set/Map, Validate, restricted JSONata, bounded For Each and Merge exist. Dedicated sort/filter/deduplicate/aggregate/date/text conversion node coverage is not established; expressions may already solve many of these cases.

Inspected anchors (paths may move during the concurrent structural cleanup):

- [packages/nodes-core/src/definitions.ts](../../packages/nodes-core/src/definitions.ts)
- [docs/adr/009-restricted-jsonata.md](../../docs/adr/009-restricted-jsonata.md)
- [apps/web/src/features/workflow-editor/model/input-mappings.ts](../../apps/web/src/features/workflow-editor/model/input-mappings.ts)

“Not established” means no complete product was found in this targeted inventory,
not proof of absence from every file. Recheck these anchors before implementation.
Code availability is not a fresh end-to-end verification claim.

## Dependencies and planning gate

01, 02; file parsing follows 04.

Stable sorting, equality for deduplication, aggregation limits, time zones and numeric precision. Do not advertise unbounded batch streaming from in-memory transforms.

Recommendations are not accepted ADRs. Resolve consequential choices before code;
use the next free ADR number when required. Do not create ADRs for routine fixes.

## Ownership and structure

Core node definition/validation/executor families, existing model primitives, catalog release registration and editor schema controls.

Follow the [shared implementation rules](../product-roadmap.md#shared-implementation-rules).
These are responsibility owners, not a mandate to create empty folders/packages.
Reuse the post-cleanup canonical owners; do not restore old duplicated paths.

## Frontend work

Schema-driven operation forms, examples, type/error preview and readable mappings; favor discoverable recipes where a new node would only duplicate a trivial expression.

## Backend work

Versioned pure bounded node definitions/executors for justified transforms; reuse existing semantic primitives, explicit null/missing/locale/order rules. No I/O hidden in a transform.

## Delivery slices

1. Inventory actual requested transformations and map each to existing expression/Set/Validate support.
2. Deliver a small consistent batch such as filter/sort/unique/aggregate with resource bounds and golden examples.
3. Add date/text and bounded CSV/JSON file conversion only with explicit semantics and file consumer contracts.

Each slice ends in a usable, tested behavior; do not ship enabled placeholder
controls backed by invented responses.

## Acceptance evidence

Empty/missing/null, mixed types, deterministic ordering, locale/DST, maximum collection sizes, nested loops and version compatibility.

Apply the shared completion checklist: contract/authorization tests, real
persistence and restart/race tests when relevant, real browser/backend flow for
visible behavior, and exact reviewed source/CI evidence. Mocks alone cannot close
the live gate. Record unsupported environments explicitly.

## Non-goals

Dozens of cosmetic nodes, arbitrary code or replacing existing expressions.

## Rollout and rollback

Retain pinned executors for published versions; remove only new catalog admission if necessary.

No production rollout, paid provisioning or real external calls are authorized by
this plan. New persistent behavior requires additive reader/writer rollout and
retention/membership-deletion handling before enablement.

## Competitor context

n8n's catalog includes Filter, Sort, Remove Duplicates and Summarize. Choose the useful cases, not their entire catalog. Sources: [n8n current documentation index](https://docs.n8n.io/sitemap.md).

Research checked 2026-09-28; product editions and availability can change.
This context informs the outcome, not Pertexo's implementation or billing policy.

## Delivery tracker

- [ ] Baseline reconciled against current code and accepted decisions.
- [ ] Product choices resolved; necessary ADR accepted.
- [ ] Contracts and failure/security model reviewed.
- [ ] Backend behavior implemented and independently verified where needed.
- [ ] Frontend behavior implemented and independently verified where needed.
- [ ] Real integrated acceptance evidence recorded.
- [ ] Rollout/rollback and limitations documented.
- [ ] Scoped PR merged with required checks; natural postmerge result inspected.

Evidence log: none for this new plan. Existing foundations above are not completion
of the proposed increment. Mark genuinely inapplicable rows with a reason rather
than fabricating work.
