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
It was subsequently reviewed, pushed and squash-merged through PR115 at
`e292c857152ec61b2995f6608239c668a66e22c6`; the one natural main CI
36495495693 and CodeQL 36495495631 passed. This is foundation delivery, not F03
completion or runtime activation.
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
   PR115 subsequently merged that reviewed foundation with green natural main checks.
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

### Inactive capture persistence P1 — merged, bounded persistence verified (2026-09-29)

The capture checkpoint adds migration 0121 and a feature-owned
`createWorkspaceInboxCaptureStore().capture()` operation. It owns a separately
committed claim, single-snapshot audience insertion and atomic marker commit, fenced
failure accounting after acknowledged rollback, and uncertain-COMMIT
reconciliation without recapture. One process-local admission covers all store
instances, raw pending checkout/query settlement and disposal; ordinary callers
receive no lease or failure-accounting controls. Numeric defaults remain those
unmeasured in ADR054. An inactive workspace is not frozen as an empty audience.

This checkpoint has **no producer, queue registration, worker composition,
activation/control ledger, fan-out, retention execution, operator recovery,
HTTP or frontend**. Deployment-global activation/cut semantics remain a proposal,
not an accepted extension. Do not activate a fixture/production producer before
the remaining resume, retention, readiness, rollout and declared-load gates.

No-service database tests passed: 124 files / 902 tests (33 new unit/static
cases). Database build/typecheck, schema ownership (five tests; unchanged 93
tables), architecture (19 tests and graph/import checks) passed. Database-wide
ESLint, Knip, complexity (three tests and ratchet), documentation (21 tests;
343 links), scoped formatting and diff checks passed. Independent correction
re-review returned no standards/spec findings and independently passed the
42 focused unit/static cases.
Review corrections retain admission through observed driver end for uncertain
COMMIT/rollback and abort, quarantine unconfirmed disposal, and use a fresh
post-audience expiry check before the atomic marker. Missing source plus missing
outbox is unavailable without reconstruction; retained evidence still validates.
That no-op cannot authenticate deleted bytes and grants no delivery authority.
Six added assertions were observed failing before their respective fixes.
One separately approved run passed **18/18 real PostgreSQL cases**, with zero
failures, skips or retries (8.81-second suite). It covers tenant/runtime authority,
audience freezing, claim contention/fences, rollback/failure budgets, delayed
COMMIT acknowledgment, source-lock recovery, expiry during insertion, real SQL
statement timeout and retained/missing/corrupt evidence. Sanitized artifacts are
in `/tmp/pertexo-inbox-capture-pg.PhjxF6`. The fresh owned database
`pertexo_test_inbox_capture_85cb54612211495db66323042171c902` (OID 281930) was
normally removed, with zero remaining connections. Parent/child exited zero,
the child process group was absent and the unchanged seven-database inventory
matched SHA256 `8dea1fc6b8892e8d35c3ad819bf609bc769ec90956eef9dde6c275522bb6f954`.
Independent review accepted this bounded persistence evidence.

P1 subsequently merged through PR116 at main
`61a1e9135cb14ababbf8cb73f64431525b855b3d`. Natural main CI 36513163444 and
CodeQL 36513163353 passed without reruns. Full F03 is not delivered or activated.

No service was started/stopped; no Redis, API/browser or provider journey ran.
The delayed-ack case uses driver interposition and the paused-owner case shortens
only an arranged lease. Neither proves aggregate load, cancellation capability
at declared load or production capacity. Worker/transport/projection lifecycle,
resume/retention and activation gates remain open; this is not full F03.

### Inactive fan-out persistence P2 — locally qualified, uncommitted (2026-09-29)

Migration 0122 and `createWorkspaceInboxProjectionStore().projectNextPage()` add
owned pages of at most 100 saved audience IDs. Workspace/user/member locks
precede the source; one ownership/cursor/candidate revalidation cannot acquire
new participant locks or loop. Current eligibility, entry/revision, terminal
audience decisions and cursor commit atomically, with fresh final expiry. A
private delivery validator preserves capture checks; capture/projection share
feature-local admission and disposal, not a generic command framework. Exact
worker mutation-grant revocations and function/readiness pins accompany the
commands. No producer, queue/worker wiring, retention, HTTP/UI/SSE or activation.

Seven focused files / **88 unit/static tests**, database source/test typecheck,
isolated-output build and scoped lint passed. The first lint run failed with
11 test-only typing/callback/conditional errors; reviewed corrections preserved
assertions and the scoped recheck, 88 tests and typecheck passed. The initial
formatter's implicit local dependency/hook reconciliation produced no tracked
dependency/config changes; subsequent checks used direct installed binaries.
Build output was isolated from the running API's primary `dist`.

**19/19 real PostgreSQL cases passed** in one separately authorized controlled
run (4,332 ms suite, zero failures, skips or retries): raw/command authority, bounded
pages and frozen audience, eligibility/skip/replay behavior, contention/lock
order, rollback/uncertain commit, attempts/expiry/timeouts and shared-recipient
serialization. Manager review first corrected two recipient-state statements to
contiguous placeholders and explicit per-statement values, retaining every
`42501` assertion. Formatting/lint/typecheck passed. Independent standards/spec
reviews returned zero findings; the manager accepted the actual PostgreSQL
results and cleanup in `/tmp/pertexo-inbox-projection-pg.PpEFGy`.
The owned database `pertexo_test_inbox_projection_ad30f47fbbc14a159d91adde452d70cd`
(OID 285525) was normally removed with zero connections. Parent/child exited zero,
monitor closed and process group was absent; the protected seven-database
inventory retained SHA256 `8dea1fc6b8892e8d35c3ad819bf609bc769ec90956eef9dde6c275522bb6f954`.
No services were started/stopped or everyday stores/Redis/API/browser/providers
used. Shared-recipient concurrent promises do not establish deterministic
contention; arranged status/lease and driver-ack cases do not prove OS crash,
cancellation at load or capacity. No worker/producer/HTTP/UI/activation or full
F03 completion is claimed. Detailed
scope, exact results and remaining gates are in
[ADR054](../adr/054-durable-workspace-inbox.md#inactive-p2-fan-out-persistence--locally-qualified-uncommitted-2026-09-29).

Final no-service qualification: full database tests initially passed 126 files /
928 cases; schema (five tests, unchanged 93 tables), architecture (19 tests plus
graph/import), database lint, Knip, complexity (three tests plus ratchet), docs
(21 tests, 348 links), formatting and diff checks passed. The unchanged
duplication gate then exposed two shared lifetime blocks. Reviewed private
extraction into the existing `write-activity.ts` preserved command logic,
budgets, admission/quarantine and uncertain outcomes. Eight regressions through
both public stores bring focused checks to **96 passing tests**; typecheck,
isolated build and independent standards/spec follow-up reviews passed. Two
new test-only deferred-void lint errors were corrected without changing assertions.
The duplication recheck passed unchanged source/test baselines (21 / 10 clone
groups); both the failed and passing reports are retained. Post-extraction full
database tests passed **126 files / 936 tests**, followed by database lint, Knip,
graph/import, complexity, formatting and diff checks. The **19 PostgreSQL cases
predate this lifetime extraction** and were not rerun; SQL/transaction code is
unchanged, not new post-extraction database evidence. Root prepush/coverage and
all runtime, retention/resume, browser/live/load and activation gates remain open.
