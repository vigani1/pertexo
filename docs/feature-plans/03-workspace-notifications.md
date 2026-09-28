# F03 — Durable in-app notifications and live inbox

Status: in progress — ADR054 accepted for implementation; shared contracts and
database foundation locally verified. Runtime, frontend and full live gates open.
Created: 2026-09-28. Parent: [product roadmap](../product-roadmap.md).
Scope: New frontend + backend product. Relative size: **L**, not a calendar estimate.

## Outcome

A user receives one durable authorized notice for an actionable failed/timed-out/outcome-unknown run, with correct unread state and reconnect recovery.

## Current implementation and evidence

Run SSE and external workflow failure alerts/destinations already exist. They are
not a personal inbox. The detailed notifications plan is qualified by accepted
[ADR054](../adr/054-durable-workspace-inbox.md), which governs accepted audience,
recovery, retention, read-all and operating-budget decisions.

At the 2026-09-29 verification checkpoint, the foundation remained uncommitted.
It contains browser-safe list/summary/single-read
contracts and generated artifacts, migration 0120, four typed tables, recipient
RLS/grants, dedupe/first-read protection and explicit child-first workspace purge
participation. These are not HTTP handlers or a delivered inbox.

Inspected anchors (paths may move during the concurrent structural cleanup):

- [docs/workspace-notifications-plan.md](../../docs/workspace-notifications-plan.md)
- [apps/web/src/features/failure-notifications/failure-notification-destinations-page.tsx](../../apps/web/src/features/failure-notifications/failure-notification-destinations-page.tsx)
- [apps/web/src/features/workflow-settings/components/settings/failure-alerts-section.tsx](../../apps/web/src/features/workflow-settings/components/settings/failure-alerts-section.tsx)

“Not established” means no complete product was found in this targeted inventory,
not proof of absence from every file. Recheck these anchors before implementation.
Code availability is not a fresh end-to-end verification claim.

## Dependencies and planning gate

00; terminal run source and membership semantics confirmed. Can precede 02.

ADR054 accepts active owner/admin/operator recipients with current run-read
authority, atomic first-successful audience capture, current insertion/read
eligibility, fixed 30-day entry/source horizons and 90-day source evidence, no
backfill, and resumable read-all. Numerical budgets remain unmeasured until the
declared-load gate; no new notification package or production activation.

ADR054 is accepted for implementation, not measured capacity or full delivery.
Resolve any newly consequential choice before later increments; do not create
ADRs for routine fixes.

## Ownership and structure

Web notifications; application notifications use cases/stream; database recipient projection; existing worker/outbox; contracts. Follow the existing detailed plan.

Follow the [shared implementation rules](../product-roadmap.md#shared-implementation-rules).
These are responsibility owners, not a mandate to create empty folders/packages.
Reuse the post-cleanup canonical owners; do not restore old duplicated paths.

## Frontend work

Workspace bell/inbox, unread count, mark-read/read-all, deep links, empty/error/stale states. Build HTTP behavior first, then one workspace SSE stream and scoped Query invalidation; no toast for every queue event.

## Backend work

Terminal fact→transactional outbox source→deduplicated recipient projection in existing worker; recipient-scoped RLS/read state and bounded list/count/read commands. SSE carries safe hints; PostgreSQL remains authority, Redis is not the inbox.

## Delivery slices

1. ADR054 and additive list/summary/single-read contracts/database foundation
   are locally verified; at the 2026-09-29 verification checkpoint they remained
   uncommitted pending selective checkpoint review.
2. Deliver durable projection plus HTTP and plain inbox; verify one notice across redelivery/crashes.
3. Add SSE snapshot recovery and multi-tab tests. Later separately scope preferences, grouping and authoritative connection-health notices.

Each slice ends in a usable, tested behavior; do not ship enabled placeholder
controls backed by invented responses.

## Acceptance evidence

Cross-recipient/tenant denial, membership revocation, insert/read-all race, restart/redelivery dedupe, offline/missed-hint recovery, deleted source fallback, two server instances.

Apply the shared completion checklist: contract/authorization tests, real
persistence and restart/race tests when relevant, real browser/backend flow for
visible behavior, and exact reviewed source/CI evidence. Mocks alone cannot close
the live gate. Record unsupported environments explicitly.

## Non-goals

Push/mobile/email expansion, successes/every-step progress, incident acknowledgement, generic event bus or queue-progress alerts.

## Rollout and rollback

Producer flag off stops new notices; keep additive data and compatible consumers/readers; no destructive rollback.

No production rollout, paid provisioning or real external calls are authorized by
this plan. New persistent behavior requires additive reader/writer rollout and
retention/membership-deletion handling before enablement.

## Competitor context

This is Pertexo operational UX, not a claim that all competitors offer an identical inbox. External alerts, execution events and personal notices remain distinct.

Research checked 2026-09-28; product editions and availability can change.
This context informs the outcome, not Pertexo's implementation or billing policy.

## Delivery tracker

- [x] Baseline reconciled against current code and accepted ADR054 decisions.
- [x] Initial product/architectural choices resolved; ADR054 accepted for implementation, not capacity/activation.
- [x] Foundation contracts, failure/security model and RLS reviewed; later runtime/read-all/SSE interfaces still required.
- [ ] Backend behavior implemented and independently verified where needed.
- [ ] Frontend behavior implemented and independently verified where needed.
- [ ] Real integrated acceptance evidence recorded.
- [ ] Rollout/rollback and limitations documented.
- [ ] Scoped PR merged with required checks; natural postmerge result inspected.

### Foundation evidence (2026-09-28/29)

Contracts: 20 files / 118 tests, including 22 new inbox cases; database unit/static:
122 files / 869 tests; focused migration/readiness: four files / 73 tests. Builds,
typechecks, generated-contract checks, schema inventory (93 tables), architecture
(19 tests and graph/import checks), scoped lint/format/diff checks passed.
Independent review passed 22 contract and nine static cases, with no outstanding
foundation findings.

One real PostgreSQL qualification failed at unscoped run-fixture admission:
zero passed, eight failed, no inbox assertions reached. The reviewed test-only
scoped API-role correction preserved guards/RLS. One approved corrected run then
passed all eight cases in 2.02 seconds, including tenant/recipient isolation,
current eligibility, expiry, grants, first-read preservation, dedupe/composite
references, rollback and actual bounded tenant purge with legal-hold blocking,
release and unrelated-workspace preservation. Normal owned-database cleanup and
unchanged seven-database baseline were independently accepted. Detailed safe
artifacts and limitations are in ADR054's foundation evidence.

No terminal producer, projection consumer, retention execution, operator command,
HTTP handler, frontend, read-all or SSE has been implemented. No inbox browser,
multi-instance, load or provider gates ran. The purge case arranges the lifecycle
ledger; it is not external object-provider evidence. Full F03 remains in progress,
not complete, merged or production-qualified. At the 2026-09-29 verification
checkpoint, its foundation also remained uncommitted.
