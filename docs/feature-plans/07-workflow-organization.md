# F07 — Folders, tags, favorites and workspace discovery

Status: proposed plan; not implementation-authorized by this document.
Created: 2026-09-28. Parent: [product roadmap](../product-roadmap.md).
Scope: Metadata backend + frontend. Relative size: **M**, not a calendar estimate.

## Outcome

Teams can find and organize many workflows without mistaking folder placement for authorization.

## Current implementation and evidence

Workspace workflow lists and search, archive/restore and activation exist. No complete tags/folders/favorites product was established by this inventory.

Inspected anchors (paths may move during the concurrent structural cleanup):

- [apps/web/src/features/workflows](../../apps/web/src/features/workflows)
- [apps/api/src/workflow-authoring](../../apps/api/src/workflow-authoring)
- [docs/adr/034-workflow-archive-restore-and-activation.md](../../docs/adr/034-workflow-archive-restore-and-activation.md)

“Not established” means no complete product was found in this targeted inventory,
not proof of absence from every file. Recheck these anchors before implementation.
Code availability is not a fresh end-to-end verification claim.

## Dependencies and planning gate

01; implement only organization actions not already present.

Folders are organization only in V1, not permission inheritance. Decide tag normalization and deletion behavior.

Recommendations are not accepted ADRs. Resolve consequential choices before code;
use the next free ADR number when required. Do not create ADRs for routine fixes.

## Ownership and structure

Workflow-authoring metadata/persistence/contracts and web workflows; favorites have user ownership.

Follow the [shared implementation rules](../product-roadmap.md#shared-implementation-rules).
These are responsibility owners, not a mandate to create empty folders/packages.
Reuse the post-cleanup canonical owners; do not restore old duplicated paths.

## Frontend work

Bounded search/filter URL state, tags and favorites first; folder navigation later if needed, keyboard actions and explicit bulk outcomes.

## Backend work

Workspace-owned metadata and indexes, user-specific favorites, bounded folder depth and move-cycle checks. Reuse existing list/search owner; no external search cluster without measured need.

## Delivery slices

1. Select tags/favorites semantics and add metadata commands/read projections.
2. Deliver filters and consistent list/card navigation.
3. Add folder moves and bounded bulk actions; test concurrent rename/move/archive.

Each slice ends in a usable, tested behavior; do not ship enabled placeholder
controls backed by invented responses.

## Acceptance evidence

No cross-workspace moves, no folder cycles, query bounds, favorite privacy, stale move conflicts, accessible navigation and preserved filters.

Apply the shared completion checklist: contract/authorization tests, real
persistence and restart/race tests when relevant, real browser/backend flow for
visible behavior, and exact reviewed source/CI evidence. Mocks alone cannot close
the live gate. Record unsupported environments explicitly.

## Non-goals

A second workspace permission model, unbounded recursive folders or replacing existing search.

## Rollout and rollback

Hide new organization controls without losing workflow identities or archive states; additive metadata stays readable.

No production rollout, paid provisioning or real external calls are authorized by
this plan. New persistent behavior requires additive reader/writer rollout and
retention/membership-deletion handling before enablement.

## Competitor context

n8n documents workflow tags/favorites; Make documents scenario organization. Exact UX need not match either. Sources: [n8n current documentation index](https://docs.n8n.io/sitemap.md); [Make scenario capabilities](https://help.make.com/scenarios).

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
