# F06 — Curated workflow templates and guided setup

Status: proposed plan; not implementation-authorized by this document.
Created: 2026-09-28. Parent: [product roadmap](../product-roadmap.md).
Scope: Frontend-led over portable authoring. Relative size: **M**, not a calendar estimate.

## Outcome

New users can start useful automations without assembling every node from scratch.

## Current implementation and evidence

Workflow creation/onboarding exists. The old N5 plan describes a proposed chooser, not a shipped template library.

Inspected anchors (paths may move during the concurrent structural cleanup):

- [apps/web/ARCHITECTURE.md](../../apps/web/ARCHITECTURE.md)
- [apps/web/src/features/workflows](../../apps/web/src/features/workflows)

“Not established” means no complete product was found in this targeted inventory,
not proof of absence from every file. Recheck these anchors before implementation.
Code availability is not a fresh end-to-end verification claim.

## Dependencies and planning gate

05; supported catalog and approved first examples.

Examples and audience approved before implementation; no separate template backend if immutable reviewed assets suffice.

Recommendations are not accepted ADRs. Resolve consequential choices before code;
use the next free ADR number when required. Do not create ADRs for routine fixes.

## Ownership and structure

Reviewed template manifests and normal workflow-authoring instantiation; web workflow creation; no second graph importer.

Follow the [shared implementation rules](../product-roadmap.md#shared-implementation-rules).
These are responsibility owners, not a mandate to create empty folders/packages.
Reuse the post-cleanup canonical owners; do not restore old duplicated paths.

## Frontend work

Chooser with purpose, required inputs/connections, effects and setup checklist; instantiate into a draft and guide remaining configuration.

## Backend work

Repository-owned reviewed manifests compatible with catalog versions; reuse 05 instantiation, never a parallel importer. Track template version for provenance without coupling future edits.

## Delivery slices

1. Choose three useful templates: webhook validation/routing, scheduled bounded batch, controlled HTTP→conditional notification.
2. Validate each manifest and its required connection/input slots automatically.
3. Deliver chooser and setup journey; publish/run remain explicit; update examples through compatibility tests.

Each slice ends in a usable, tested behavior; do not ship enabled placeholder
controls backed by invented responses.

## Acceptance evidence

Every template creates a valid remapped draft, required credentials remain unconfigured, obsolete versions fail clearly, setup reaches a controlled real run.

Apply the shared completion checklist: contract/authorization tests, real
persistence and restart/race tests when relevant, real browser/backend flow for
visible behavior, and exact reviewed source/CI evidence. Mocks alone cannot close
the live gate. Record unsupported environments explicitly.

## Non-goals

Marketplace, public submissions, ratings, template monetization and automatically executing examples.

## Rollout and rollback

Remove a template from new selection without changing existing user drafts; retain provenance.

No production rollout, paid provisioning or real external calls are authorized by
this plan. New persistent behavior requires additive reader/writer rollout and
retention/membership-deletion handling before enablement.

## Competitor context

Make's blueprints show why reuse accelerates setup; curated examples are the smaller initial product than a marketplace. Sources: [Make blueprints](https://help.make.com/blueprints).

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
