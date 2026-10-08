# F11 — Hosted forms and structured human input

Status: proposed plan; not implementation-authorized by this document.
Created: 2026-09-28. Parent: [product roadmap](../product-roadmap.md).
Scope: New trigger/frontend product. Relative size: **L–XL**, not a calendar estimate.

## Outcome

A nontechnical user submits validated input that starts a workflow, or supplies requested data to a specific waiting interaction.

## Current implementation and evidence

Webhook/manual/schedule triggers exist; hosted forms and external resume input are deferred.

Inspected anchors (paths may move during the concurrent structural cleanup):

- docs/workflow-platform-backend-plan.md
- [apps/api/src/webhooks](../../apps/api/src/webhooks)
- [apps/web/src/features/workflow-settings](../../apps/web/src/features/workflow-settings)

“Not established” means no complete product was found in this targeted inventory,
not proof of absence from every file. Recheck these anchors before implementation.
Code availability is not a fresh end-to-end verification claim.

## Dependencies and planning gate

01; 04 only for file fields; 10 for resuming an existing waiting run.

Anonymous versus authenticated first launch, allowed fields, spam controls, personal-data retention and per-workspace limits.

Recommendations are not accepted ADRs. Resolve consequential choices before code;
use the next free ADR number when required. Do not create ADRs for routine fixes.

## Ownership and structure

Application forms/trigger acceptance; database submissions; existing run admission; contracts; web form authoring and isolated hosted route.

Follow the [shared implementation rules](../product-roadmap.md#shared-implementation-rules).
These are responsibility owners, not a mandate to create empty folders/packages.
Reuse the post-cleanup canonical owners; do not restore old duplicated paths.

## Frontend work

Schema-backed form builder, preview, accessible hosted form, validation and safe completion; start forms and resume forms have distinct UX.

## Backend work

Versioned form publication, submission validation/rate limits/abuse protection, accepted submission→run idempotency and retention. Resume submissions use the decision capability of 10, not generic run creation.

## Delivery slices

1. Deliver bounded authenticated start form with a small field set and explicit publication.
2. Add public access mode only after anti-abuse/data policy review; optional file fields follow 04.
3. Deliver requested-data resume forms through 10 with one-time scoped capabilities.

Each slice ends in a usable, tested behavior; do not ship enabled placeholder
controls backed by invented responses.

## Acceptance evidence

Duplicate submission, edited form version, revoked/unpublished form, cross-workspace resume, accessibility, malicious content, oversize input and unavailable backend.

Apply the shared completion checklist: contract/authorization tests, real
persistence and restart/race tests when relevant, real browser/backend flow for
visible behavior, and exact reviewed source/CI evidence. Mocks alone cannot close
the live gate. Record unsupported environments explicitly.

## Non-goals

Full website builder, arbitrary user HTML/JavaScript, collecting secrets without a designated credential flow.

## Rollout and rollback

Unpublish new acceptance endpoints while retaining accepted submissions and run lineage.

No production rollout, paid provisioning or real external calls are authorized by
this plan. New persistent behavior requires additive reader/writer rollout and
retention/membership-deletion handling before enablement.

## Competitor context

n8n Form Trigger illustrates form-driven runs; it is separate from a general-purpose app builder. Sources: [n8n Form Trigger](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.formtrigger).

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
