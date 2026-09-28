# F25 — Business-event deduplication, debounce and throttling

Status: proposed plan; not implementation-authorized by this document.
Created: 2026-09-28. Parent: [product roadmap](../product-roadmap.md).
Scope: Optional durable coordination beyond queue reliability. Relative size: **XL**, not a calendar estimate.

## Outcome

A workflow can intentionally coalesce bursts or suppress repeated business events with an explicit, inspectable policy.

## Current implementation and evidence

Transport dedupe, idempotency, distributed rate limiting and fair admission exist. These do not automatically provide user-configured debounce windows or business-key event coalescing.

Inspected anchors (paths may move during the concurrent structural cleanup):

- [packages/queue/src/contracts.ts](../../packages/queue/src/contracts.ts)
- [packages/rate-limit/src/policy.ts](../../packages/rate-limit/src/policy.ts)
- [docs/workflow-platform-backend-plan.md](../../docs/workflow-platform-backend-plan.md)

“Not established” means no complete product was found in this targeted inventory,
not proof of absence from every file. Recheck these anchors before implementation.
Code availability is not a fresh end-to-end verification claim.

## Dependencies and planning gate

12 and 13 for bounded policy; one concrete automation demand before implementation.

Leading/trailing edge, late arrivals, key cardinality, ordering and fairness; do not confuse business dedupe with exactly-once external delivery.

Recommendations are not accepted ADRs. Resolve consequential choices before code;
use the next free ADR number when required. Do not create ADRs for routine fixes.

## Ownership and structure

Application coordination policy; database durable event/window authority; worker scheduling; model/node contracts; web editor/inspection.

Follow the [shared implementation rules](../product-roadmap.md#shared-implementation-rules).
These are responsibility owners, not a mandate to create empty folders/packages.
Reuse the post-cleanup canonical owners; do not restore old duplicated paths.

## Frontend work

Business-key/window configuration, dropped/coalesced status explanations, monitoring and operator recovery where justified.

## Backend work

Durable tenant-scoped coordination state with event-time/processing-time definition, bounded window expiry, atomic winner/wakeup and retention. Redis-only ephemeral locks cannot define durable accepted-event truth.

## Delivery slices

1. Select one operation (for example debounce latest event), not a universal coordination engine.
2. Define accepted/suppressed/coalesced semantics, quotas and cancellation, then ADR and crash-safe persistence.
3. Expose UI and real multiworker/time-window proofs before adding other operations.

Each slice ends in a usable, tested behavior; do not ship enabled placeholder
controls backed by invented responses.

## Acceptance evidence

Boundary races, same key across tenants, crash around window expiry, duplicate wakeup, clock skew, late input, hot-key limits and canceled workflow.

Apply the shared completion checklist: contract/authorization tests, real
persistence and restart/race tests when relevant, real browser/backend flow for
visible behavior, and exact reviewed source/CI evidence. Mocks alone cannot close
the live gate. Record unsupported environments explicitly.

## Non-goals

Changing global admission policy or pretending transport receipts already solve business-event identity.

## Rollout and rollback

Disable new policies while existing accepted windows drain with original semantics.

No production rollout, paid provisioning or real external calls are authorized by
this plan. New persistent behavior requires additive reader/writer rollout and
retention/membership-deletion handling before enablement.

## Competitor context

Demand-driven future capability, not claimed as a verified one-to-one competitor parity requirement in this research.

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
