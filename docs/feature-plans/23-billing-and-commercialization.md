# F23 — Billing and commercial entitlements

Status: proposed plan; not implementation-authorized by this document.
Created: 2026-09-28. Parent: [product roadmap](../product-roadmap.md).
Scope: Explicitly deferred optional business slice. Relative size: **XL**, not a calendar estimate.

## Outcome

Only if commercial plans are approved: explainable plans, usage and payment state without corrupting execution truth.

## Current implementation and evidence

Non-payment UX and operational entitlements must remain independent. Existing scope explicitly excludes payment implementation.

Inspected anchors (paths may move during the concurrent structural cleanup):

- [apps/web/ARCHITECTURE.md](../../apps/web/ARCHITECTURE.md)
- [docs/implementation-progress.md](../../docs/implementation-progress.md)

“Not established” means no complete product was found in this targeted inventory,
not proof of absence from every file. Recheck these anchors before implementation.
Code availability is not a fresh end-to-end verification claim.

## Dependencies and planning gate

12 measurement definitions and reconciliation; business approval.

Pricing, taxes and compliance require business/professional decisions; no vendor accounts or financial commitments authorized by this plan.

Recommendations are not accepted ADRs. Resolve consequential choices before code;
use the next free ADR number when required. Do not create ADRs for routine fixes.

## Ownership and structure

Separate billing application and payment adapter; database ledger/reconciliation; entitlement interface; web billing.

Follow the [shared implementation rules](../product-roadmap.md#shared-implementation-rules).
These are responsibility owners, not a mandate to create empty folders/packages.
Reuse the post-cleanup canonical owners; do not restore old duplicated paths.

## Frontend work

Plan/usage disclosure, checkout/portal/invoices and payment failure recovery only for approved pricing.

## Backend work

Payment adapter, idempotent webhook ledger, subscription→entitlement reconciliation and grace policy; keep billing events separate from run accounting and external effects.

## Delivery slices

1. Choose pricing/units and grace/cancellation policy after reliable usage reporting.
2. Record provider/ledger decision, implement sandbox webhook reconciliation and entitlement changes.
3. Deliver UI and controlled operational rollout with explicit paid-service authorization.

Each slice ends in a usable, tested behavior; do not ship enabled placeholder
controls backed by invented responses.

## Acceptance evidence

Duplicate/out-of-order webhooks, failed payment/recovery, refunds/cancellation, idempotent entitlement updates and no accidental execution-data deletion.

Apply the shared completion checklist: contract/authorization tests, real
persistence and restart/race tests when relevant, real browser/backend flow for
visible behavior, and exact reviewed source/CI evidence. Mocks alone cannot close
the live gate. Record unsupported environments explicitly.

## Non-goals

Implementation in the current cleanup or first feature wave; inventing prices or upgrading accounts.

## Rollout and rollback

Manual controlled billing reconciliation and clear read-only state; never reset usage ledger.

No production rollout, paid provisioning or real external calls are authorized by
this plan. New persistent behavior requires additive reader/writer rollout and
retention/membership-deletion handling before enablement.

## Competitor context

Commercial parity is a business choice, not a reason to delay core workflow usability.

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
