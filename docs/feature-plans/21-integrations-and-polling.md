# F21 — Provider expansion and durable polling/subscriptions

Status: proposed plan; not implementation-authorized by this document.
Created: 2026-09-28. Parent: [product roadmap](../product-roadmap.md).
Scope: Later integration program. Relative size: **XL per provider family**, not a calendar estimate.

## Outcome

Complete a small set of real user automations with dependable provider actions and triggers instead of accumulating shallow connectors.

## Current implementation and evidence

HTTP Request, Slack message, email notification, webhook and schedule exist. Broad vendors, polling cursors and connected subscription entities remain deferred.

Inspected anchors (paths may move during the concurrent structural cleanup):

- [packages/integrations/src](../../packages/integrations/src)
- [docs/workflow-platform-backend-plan.md](../../docs/workflow-platform-backend-plan.md)
- [docs/implementation-progress.md](../../docs/implementation-progress.md)

“Not established” means no complete product was found in this targeted inventory,
not proof of absence from every file. Recheck these anchors before implementation.
Code availability is not a fresh end-to-end verification claim.

## Dependencies and planning gate

Core usability/reuse waves first; 12 operational limits; explicit provider sandbox access.

Provider scopes, quotas, initial backfill, cursor expiration, deactivation on auth loss, credential ownership; OAuth registration and real calls need configured access.

Recommendations are not accepted ADRs. Resolve consequential choices before code;
use the next free ADR number when required. Do not create ADRs for routine fixes.

## Ownership and structure

Provider-specific integrations; catalog composition; connections/trigger application; database cursors/receipts; worker; web provider forms.

Follow the [shared implementation rules](../product-roadmap.md#shared-implementation-rules).
These are responsibility owners, not a mandate to create empty folders/packages.
Reuse the post-cleanup canonical owners; do not restore old duplicated paths.

## Frontend work

Provider catalog, connection scopes/reauthorization, operation-specific forms, sample events and sync/trigger health.

## Backend work

Existing SDK/catalog/integrations pattern; provider-specific idempotency/retry/error and credential lifecycle. Polling requires durable cursor, pagination/backfill policy, lease and atomic event-dedupe→run acceptance; subscriptions need verification, renewal and revocation.

## Delivery slices

1. Rank requested end-to-end journeys and choose one provider, not a large arbitrary list.
2. Ship one action with real sandbox compatibility and safe connection UX.
3. Ship its highest-value trigger with crash/cursor/dedupe proof; repeat only when previous slice is usable.

Each slice ends in a usable, tested behavior; do not ship enabled placeholder
controls backed by invented responses.

## Acceptance evidence

Expired token, provider rate limit, duplicate pages/events, cursor advance crash, schema drift, subscription loss, secret redaction, retry safety and actual sandbox contract.

Apply the shared completion checklist: contract/authorization tests, real
persistence and restart/race tests when relevant, real browser/backend flow for
visible behavior, and exact reviewed source/CI evidence. Mocks alone cannot close
the live gate. Record unsupported environments explicitly.

## Non-goals

Broad integrations before core usability, generic one-policy provider executor, paid/provider provisioning without approval.

## Rollout and rollback

Stop scheduling affected provider, preserve accepted work and cursors, explicit user reconnect; do not erase failure history.

No production rollout, paid provisioning or real external calls are authorized by
this plan. New persistent behavior requires additive reader/writer rollout and
retention/membership-deletion handling before enablement.

## Competitor context

Breadth matters eventually, but cannot be responsibly matched by a connector count. User preference is core features first.

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
