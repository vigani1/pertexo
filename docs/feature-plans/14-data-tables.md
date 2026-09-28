# F14 — Workflow-owned lookup tables and durable records

Status: proposed plan; not implementation-authorized by this document.
Created: 2026-09-28. Parent: [product roadmap](../product-roadmap.md).
Scope: New optional storage product. Relative size: **XL**, not a calendar estimate.

## Outcome

Users store small bounded lookup/state datasets without connecting an external database.

## Current implementation and evidence

Internal platform database tables are not customer data tables. No user-configurable table CRUD/node product was established.

Inspected anchors (paths may move during the concurrent structural cleanup):

- [docs/workflow-platform-backend-plan.md](../../docs/workflow-platform-backend-plan.md)
- [packages/nodes-core/src/definitions.ts](../../packages/nodes-core/src/definitions.ts)

“Not established” means no complete product was found in this targeted inventory,
not proof of absence from every file. Recheck these anchors before implementation.
Code availability is not a fresh end-to-end verification claim.

## Dependencies and planning gate

12 for quotas; 01; validate demand before coding.

Consistency/isolation, unique key semantics, allowed indexes, size/row limits, data deletion and internal versus external storage economics.

Recommendations are not accepted ADRs. Resolve consequential choices before code;
use the next free ADR number when required. Do not create ADRs for routine fixes.

## Ownership and structure

Application data-tables; database customer-record domain; versioned node adapters; contracts; web data-tables. Internal app tables remain private.

Follow the [shared implementation rules](../product-roadmap.md#shared-implementation-rules).
These are responsibility owners, not a mandate to create empty folders/packages.
Reuse the post-cleanup canonical owners; do not restore old duplicated paths.

## Frontend work

Table/schema editor, bounded row browser/search/import, history or concurrency feedback and node field mapping.

## Backend work

Separate workspace-owned table/row domain, types and indexes with quotas; RLS, optimistic updates, idempotent node writes and retention/deletion. Never expose internal platform SQL/tables.

## Delivery slices

1. Select key/value or small typed tables as V1, not a database builder.
2. Deliver CRUD reads and one lookup/upsert node with side-effect/retry semantics.
3. Add controlled CSV import after 04 and bounded bulk operations.

Each slice ends in a usable, tested behavior; do not ship enabled placeholder
controls backed by invented responses.

## Acceptance evidence

Concurrent upsert, duplicate attempt, tenant isolation, schema migration, bounded scans, quota race, workflow/table deletion and retention.

Apply the shared completion checklist: contract/authorization tests, real
persistence and restart/race tests when relevant, real browser/backend flow for
visible behavior, and exact reviewed source/CI evidence. Mocks alone cannot close
the live gate. Record unsupported environments explicitly.

## Non-goals

Arbitrary SQL, analytics warehouse, spreadsheet formulas and unbounded storage.

## Rollout and rollback

Disable new table creation/writes while preserving authorized reads/export and existing execution contracts.

No production rollout, paid provisioning or real external calls are authorized by
this plan. New persistent behavior requires additive reader/writer rollout and
retention/membership-deletion handling before enablement.

## Competitor context

n8n data tables provide built-in workflow data storage; this is optional breadth rather than a prerequisite for subworkflows. Sources: [n8n data tables](https://docs.n8n.io/build/work-with-data/data-tables).

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
