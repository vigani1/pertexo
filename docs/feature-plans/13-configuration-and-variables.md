# F13 — Workspace variables and reusable non-secret configuration

Status: proposed plan; not implementation-authorized by this document.
Created: 2026-09-28. Parent: [product roadmap](../product-roadmap.md).
Scope: New version-aware configuration. Relative size: **L**, not a calendar estimate.

## Outcome

Users reuse ordinary configuration across workflows without misusing secrets or introducing nondeterministic replay.

## Current implementation and evidence

Node configuration, workflow inputs and encrypted connections exist. A first-class user-managed variable product is not established.

Inspected anchors (paths may move during the concurrent structural cleanup):

- [packages/workflow-model/src/graph-contract.ts](../../packages/workflow-model/src/graph-contract.ts)
- [apps/api/src/connections](../../apps/api/src/connections)
- [apps/web/src/features/connections](../../apps/web/src/features/connections)

“Not established” means no complete product was found in this targeted inventory,
not proof of absence from every file. Recheck these anchors before implementation.
Code availability is not a fresh end-to-end verification claim.

## Dependencies and planning gate

01; design snapshot semantics with 08/17 before runtime use.

Recommend snapshot at run acceptance for replay traceability; decide template/import placeholders and environment overrides before 17.

Recommendations are not accepted ADRs. Resolve consequential choices before code;
use the next free ADR number when required. Do not create ADRs for routine fixes.

## Ownership and structure

Application workspace configuration; database revisions; model value-source policy; runtime snapshot resolver; contracts; web settings/editor.

Follow the [shared implementation rules](../product-roadmap.md#shared-implementation-rules).
These are responsibility owners, not a mandate to create empty folders/packages.
Reuse the post-cleanup canonical owners; do not restore old duplicated paths.

## Frontend work

Workspace variable settings, typed values, references and resolved-source labels; credential values never appear in this editor.

## Backend work

Revisioned workspace variable records and authorization; run/version binding rule and captured snapshot metadata. Keep secret references in connections/secret authority; no interpolation from process environment.

## Delivery slices

1. Define types, limits, name scope and whether publish or run acceptance pins values.
2. Implement variable CRUD/audit and bounded resolution with explicit missing-value errors.
3. Add mapping reference picker and inspectable non-secret provenance.

Each slice ends in a usable, tested behavior; do not ship enabled placeholder
controls backed by invented responses.

## Acceptance evidence

Changed variable during a run does not mutate its snapshot, missing/removed value, role loss, cross-tenant denial, replay retention and secret-like data handling.

Apply the shared completion checklist: contract/authorization tests, real
persistence and restart/race tests when relevant, real browser/backend flow for
visible behavior, and exact reviewed source/CI evidence. Mocks alone cannot close
the live gate. Record unsupported environments explicitly.

## Non-goals

Global mutable implicit state, secret storage inside normal variables, hot-changing in-flight execution semantics.

## Rollout and rollback

Stop new references while old versions/snapshots remain interpretable.

No production rollout, paid provisioning or real external calls are authorized by
this plan. New persistent behavior requires additive reader/writer rollout and
retention/membership-deletion handling before enablement.

## Competitor context

n8n documents reusable custom variables; Pertexo still needs its own pinning and replay contract. Sources: [n8n custom variables](https://docs.n8n.io/build/code-in-n8n/define-custom-variables).

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
