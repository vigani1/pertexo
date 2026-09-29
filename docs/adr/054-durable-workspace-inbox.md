# ADR 054: Durable workspace inbox projection and recovery

- **Status:** accepted for implementation — operating/load and live gates pending
- **Date:** 2026-09-28

## Context

[F03](../feature-plans/03-workspace-notifications.md) and the
[detailed inbox plan](../workspace-notifications-plan.md) propose a personal
workspace inbox. Existing run events, external failure-alert destinations and
transport inbox receipts are not that product. Architectural/product decisions
are accepted for bounded implementation. This does not authorize production
activation or establish measured operating capacity.

ADRs 003, 005 and 013 retain PostgreSQL authority, runtime-role/RLS separation,
outbox recovery and explicit retention/purge obligations. ADRs 004 and 039 retain
the existing session authority, CSRF and bounded stream-authorization lifetime.
ADR 022's external failure-alert lifecycle remains independent and unchanged.

## Product and authorization rules

The initial audience is active owners, admins and operators with current
`run:read` authority and an active user. Builders and viewers retain their existing
run permissions; this proposal does not subscribe them to workspace-wide failures.
Use one shared policy owner for inbox eligibility, not a second permissions system.
Apply the same recipient and eligibility predicates to list, count, read commands
and live hints. Inbox reads, mutations, projection and hints require an `active`
workspace. Suspended, pending-deletion, purging and deleted workspaces are not
inbox-serving states, even where existing run-history reads permit inspection.
An authenticated person cannot choose another recipient in a body.

The sources are newly occurring terminal `failed`, `timed_out` and
`outcome_unknown` runs after an explicit activation watermark. No historical
backfill, successful/canceled runs, per-step progress, incoming-event toasts,
recursive delivery-failure notices, or external mail are included. Replay creates
a new run; queue redelivery does not create a new logical notice. Reading a notice
does not resolve or acknowledge the underlying operational incident.

Recipient identity is the existing composite `(workspace_id, user_id)`, not an
invented standalone membership ID. Freeze recipients and observed membership
revisions at the first successful audience-capture transaction. Revision is
concurrency evidence, not a subscription-generation rule: an eligible-to-eligible
role change must not by itself suppress a notice.

Before inserting an entry, transactionally recheck the current active user,
active eligible membership, run-read authority and allowed workspace lifecycle.
Respect interacting writers' lock order: workspace, users in deterministic order,
then memberships, before feature-specific locks. The final detailed lock protocol
must cover capture, projection, read commands, lifecycle and maintenance together.
It must not acquire these shared locks in reverse order through a retry path.

The restoration semantics are explicit:

- A person excluded when the audience is frozen is never added by a later retry.
- A captured recipient found ineligible when processed becomes durably skipped.
  Restoring eligibility does not reopen that completed projection decision.
- Retained entries are inaccessible while the person is ineligible. Restoring
  eligibility can expose those still-unexpired entries with their read state
  unchanged; it does not generate replacement notices.
- A captured but unprocessed recipient restored before the insertion check may
  receive that original pending notice, if otherwise eligible and not expired.
  Current-state checking cannot establish every intermediate eligibility change.
  Permanently canceling delivery after any interim revocation would require a
  separate eligibility-generation/history decision, not comparison with every
  old `role_revision`. This decision does not adopt that stricter rule.

These audience, restoration, retention and no-backfill choices are accepted.
Workspace restoration alone does not resume
inbox access: ADR 013 restores to suspended; activation and current eligibility
are still required.

## Durable source and independent delivery

Write an identifier-only inbox source and its outbox event in the same transaction
as the terminal checkpoint/run event. Use logical identity `(workspace, run,
terminal event sequence, notice kind)` and a canonical immutable checksum.
External destination, policy version or configuration changes do not change that
identity. Do not use the external-alert intent as the source: its current writer
requires an enabled pinned destination, which an inbox must not require.

Add a separately versioned projection job to the existing queue/dispatcher and
worker composition. It does not competitively consume the external-alert job.
Messages carry bounded source/workspace/outbox identifiers and permitted trace
context, not an audience list, run inputs/outputs or provider material. Consumers
validate the contract and reload authoritative source state. Exact redelivery
reconciles the existing checksum/progress; changed bytes under the same delivery
identity fail closed through existing safe corruption/audit conventions.

Entry uniqueness combines source identity and recipient. Recipient insertion,
projection progress/receipt and recipient revision updates commit together.
Redelivery, crash after commit and lease takeover cannot duplicate visible entries
or change terminal run truth. No transport exactly-once or provider guarantee is
claimed. Redis remains transport, not inbox authority.

## Audience capture: preferred alternative and limits

Prefer one atomic database `INSERT ... SELECT` capturing eligible recipients from
a single statement snapshot, with a captured marker committed in the same
transaction. Serialize capture ownership on the durable source. Do not materialize
all members in application memory, truncate with a row limit, or allow two workers
to freeze different audiences for the same source.

Capture cardinality and fan-out work are different bounds. Once capture commits,
projection uses resumable keyset pages with bounded recipient transactions and
current eligibility checks. That page limit does not bound initial capture.

This alternative bounds capture duration and concurrency through lock, statement
and whole-transaction budgets, cancellation/cleanup and admission limits. It does
**not** impose a hard row/cardinality, memory, I/O or WAL bound: capture is still
proportional to audience size. The following initial budgets are **proposed,
unmeasured defaults**, not demonstrated capacity or inherited guarantees:

- One capture admission per worker process; one lease-fenced owner per source
  across processes. Deployment worker count also bounds aggregate admission and
  must be declared in the load gate, not assumed to be one globally.
- Capture pool checkout at most two seconds, PostgreSQL `lock_timeout` one
  second, each statement at most five seconds, and a ten-second whole-attempt
  deadline starting before checkout. Statement budgets do not replace that
  whole-attempt deadline, which includes BEGIN, context setup and COMMIT.
- At deadline, abort and dispose uncertain connections; allow at most two
  additional seconds for settlement before reporting a safe cleanup failure.
  Unsettled work does not release admission for another local capture. A worker
  that cannot establish disposal drains/fails readiness rather than retrying
  with an outstanding writer. A 30-second durable lease exceeds the 12-second
  attempt-plus-settlement envelope; no background renewal extends stuck capture.
- Claim ownership/fence and increment the consecutive failure budget in a short
  committed transaction before capture. Successful marker/progress commits reset
  that budget. After known rollback, record failure in a separate fenced
  transaction, never the aborted one. Lost acknowledgments or unavailable failure
  accounting are reconciled from marker/progress after lease expiry; stale owners
  cannot update it. Lease expiry alone is not proof that an old write rolled back.
- At most ten consecutive failed acquisitions for capture or one projection
  checkpoint. Persist `next_attempt_at`: exponential delay starting at five
  seconds, doubling to a five-minute cap, with equal jitter between half and the
  full calculated delay. Reaching the limit durably blocks that source/checkpoint
  pending supported operator recovery or absolute expiry. Successful pages do
  not consume the budget for subsequent pages.
- Fan-out performs at most 100 recipient decisions per invocation with resumable
  keyset progress, one source admission per process, a 30-second fenced lease,
  a two-second statement budget, a one-second lock budget and an eight-second
  whole-attempt deadline plus two seconds for disposal. If a page cannot fit,
  retry from its last committed checkpoint rather than expanding the deadline or
  silently dropping recipients. New work is durably scheduled after a committed
  page; queue job retry counters are not the source recovery budget.

Configuration validation must preserve these deadline/lease inequalities. Prove
takeover against paused processes and delayed COMMIT, not just timers in a mock.
These numbers intentionally differ from external provider delivery budgets.

This interprets the plan's bounded-capture requirement as a time-budgeted atomic
snapshot under an explicitly measured declared load, followed by row-bounded
fan-out. Activation is gated on proving acceptable transaction latency, database
load, cancellation settlement and contention at that load. Do not claim arbitrary
large-team capacity. If measurements cannot meet the plan's resource requirement,
stop and revisit persisted-history paging before enabling the producer.

Capture failure and uncertainty have different outcomes:

- Timeout, cancellation or failure before commit rolls back the audience and
  marker together. The durable source remains recoverable. The next successful
  capture uses its own statement snapshot; no earlier audience committed.
- Lost acknowledgment after commit reloads the captured marker and stored
  audience. It never captures a fresh audience or adds newly joined people.
- Retry ownership is durable and lease-fenced. Use bounded backoff with jitter,
  attempt limits and an explicit exhausted/blocked state retaining the source.
  No immediate retry storm, false completion, silent deletion or recursive notice.
  A supported recovery operation reconciles committed state before resuming;
  ordinary row edits or fresh source identities are not recovery.
- Actual deadline enforcement, cancellation settlement and durable accounting
  must pass integration gates before producer activation. A timed-out transaction
  cannot persist its failure accounting by continuing on that failed transaction.

### Supported exhausted-source recovery

Implement one focused `inbox.source.resume` extension to the existing
`apps/operator-command` interface and database operator authority, not a workspace
operator-role browser action or direct SQL repair. Inputs are the existing bounded
actor reference, reason, command UUID, workspace UUID and dry-run flag, plus source
UUID and expected source fence/progress revision. The narrow database command
rechecks workspace state, immutable checksum, absolute expiry, live lease and
current progress under the agreed lock order. It first reconciles a committed
capture/page; it cannot reset the audience, delete receipts or make a new source.

Dry-run reports `would_resume` or a safe blocked reason. Apply resumes only an
unexpired blocked source with no live owner, grants one fresh ten-failure budget,
and durably schedules its existing checkpoint. Already complete, expired,
unavailable, live-lease and revision-conflict outcomes do not resume work. Persist
the canonical command fingerprint, safe outcome and audit using existing command
receipts: same UUID/body replays its outcome; changed body conflicts. Status lookup
reconciles a lost command response before any fresh command. This receipt reports
rescheduling, not successful inbox delivery; source status separately reports
capture/projection progress. No automatic repeated operator resets or extension
of source expiry is permitted. Add the narrow execute grant/readiness check;
operator credentials retain no direct feature-table write privilege.

Considered alternatives:

- **Persisted membership-history snapshot paging:** bounds rows per capture page
  and survives restart at one fixed audience cut. Current mutable memberships do
  not support that query. All membership writers and relevant user-eligibility
  changes would need history/cut semantics plus retention of unfinished snapshots.
  A long-lived MVCC transaction across jobs is not a restart-safe substitute.
  This is the fallback if atomic capture cannot pass measured resource gates,
  not a speculative history framework in the first slice.
- **Explicit supported-size limit:** bounds capture cardinality, but knowingly
  blocks inbox production for larger teams. It requires a separate product
  approval and truthful operational/UI behavior. No arbitrary recipient cap is
  approved or introduced by this decision.

## Read state, HTTP and read-all obligations

PostgreSQL owns private read state and a monotonically increasing recipient
revision. Query owns frontend snapshots; Router owns filters/navigation. No global
notification store, mirrored authoritative unread counter or optimistic count
subtraction is needed.

The HTTP interface comprises list (`all`/`unread`), summary, single read, read-all
and events under the workspace notifications resource. Strict browser-safe shared
schemas, ordinary session CSRF, endpoint error/disclosure contracts and rate classes
precede the UI. List cursors preserve PostgreSQL timestamp precision, deterministic
ordering and recipient/workspace/filter scope. Counts and lists use identical
authorization and expiry predicates; transient failures are not a zero count.

Single read is monotonic and repeat-safe, preserving the first read timestamp.
Read-all uses a server-issued recipient/workspace-bound committed revision cut
and entry creation revisions, not a timestamp-only cutoff or browser-selected
recipient. Serialize insertion/cut issuance and read-all with the same recipient
state lock. Entries after that cut remain unread; already read entries keep their
first read timestamp, including after repeated or uncertain command recovery.

Choose an explicit resumable read-all operation rather than claiming an unproved
atomic population bound. The operation contracts are:

- Summary issues an opaque authenticated cut valid for 15 minutes, bound to the
  original user, workspace and committed recipient revision. Expiry is checked
  when accepting a new command; it does not invalidate an already accepted
  operation. Never accept a browser-supplied arbitrary revision as that cut.
- Read-all accepts that exact cut and an idempotency key under ordinary CSRF,
  persists their canonical fingerprint and returns an operation identifier and
  `pending` status. Exact retries reconcile the same operation without taking a
  newer cut; changed input under that key conflicts. A newer read-all is a distinct
  confirmed command. Expose an authorized operation-status resource; no receipt
  or cut authenticates its caller.
- Operation state owns a durable cutoff/cursor and fenced page lease. Process
  at most 100 entries per invocation using the projection page deadlines above;
  serialize each page with the recipient-state lock and current authorization.
  Only unexpired entries created at or before the cut qualify. Mark each unread
  entry with its first committed read time for that page, not retroactively with
  command acceptance time. Existing timestamps never change, including when a
  single-read command wins before that page. Lost commit acknowledgments reload
  progress and cannot restamp entries.
- Pending operations can expose partially committed read progress in ordinary
  list/count snapshots. UI says processing, not “all read,” until `completed`;
  entries after the cut remain unread. Status distinguishes terminal
  `access_lost`/`expired` from retryable or exhausted `blocked` work. Changed
  identity/eligibility stops processing; no automatic replay on later restoration
  and no rollback of already committed read marks. Explicit same-user recovery
  may resume a blocked operation only with current authority and its original cut.
- Preserve nonterminal operation/receipt evidence until it safely settles. An
  operation has a fixed 24-hour acceptance-to-processing deadline; then expire
  remaining work without undoing prior pages. Terminal replay evidence remains
  at least 24 hours after settlement (longer under a hold), matching ADR 013's
  operation-specific rule rather than reaping an in-progress claim. The response
  supplies this retry horizon; after it, a new command needs a fresh cut/key.

The 15-minute cut and 24-hour operation horizons are initial defaults, not
measured guarantees. A global last-read watermark alone cannot preserve these
per-entry timestamps. No placeholder read-all control ships first.

## Retention, deletion and privacy

Use 30 days from entry creation for read and unread notices, subject to ADR
013 legal holds and deletion policy. Expired entries are no longer visible or
counted even when a hold retains physical evidence. Holds never restore access,
eligibility, sessions or active execution.

Use a fixed source delivery horizon of 30 days from the authoritative terminal
event time, recorded as absolute `expires_at` in the terminal transaction. Capture,
projection, queue redelivery and operator recovery never extend it. Both capture
and each entry insertion reject an expired source. Entry visibility remains 30
days from its own creation; a delayed valid projection can therefore outlive its
source, without permitting more entries after source expiry. Default-off activation
records a durable terminal-event watermark; only new terminal transitions past it
write sources, not scans of retained run history.

Keep source identity/checksum, audience decisions, progress and dedupe receipts
through at least 90 days from terminal time and until no valid worker/operation
lease remains, subject to holds. This inbox fence is aligned with the
existing run-summary period, **not an existing generic outbox TTL**. The shorter
30-day absolute source lifetime is the retry/recovery window; the extra evidence
does not permit late projection. Entry deletion cannot reset a recipient decision.
Expired or missing sources consume late valid transport deliveries as a safe
expired/unavailable no-op; they never reconstruct a source from a message or run.
Checksum-corrupt deliveries still fail closed under safe audit conventions.

Bounded retention may remove source evidence after that 90-day horizon only when
expiry, completed/expired ownership and legal-hold checks are satisfied. Linked
feature outbox/transport receipts need an explicit dependency-aware cleanup path;
do not presume a generic outbox reaper exists or delete unrelated jobs. Missing
source handling remains fail-closed after those records are gone. A hold retains
evidence physically but never extends source delivery, entry visibility or replay
authority. These fixed horizons must be tested with delayed jobs after receipt
and entry deletion, not just with the normal queue retention setting.

Integrate all new tables into bounded maintenance, legal-hold checks and explicit
workspace purge order, including dependencies on sources, audience and recipient
state. Do not rely on workspace foreign-key cascades alone. Define identity
deletion participation with the actual existing lifecycle; this decision does not
invent an account-deletion feature. Audit evidence follows its existing policy,
not the inbox's shorter entry lifetime.

Entries and hints contain safe typed targets and approved display metadata, never
provider errors, stack traces, run data, credentials, arbitrary HTML or redirect
URLs. Targets always use ordinary authorization. A missing/deleted run has a safe
unavailable fallback; a receipt never authenticates its reader.

## Live updates and full F03 completion

SSE is a recipient-revision hint channel; reconnect/focus refetches PostgreSQL
list/summary snapshots. It is not resumable run-event history. Existing run SSE
has per-run subscriptions and authorization watchdogs, not a ready-made batched
inbox revision scheduler. A later live increment must implement and measure one
bounded feature-owned scheduler per API process, coalescing duplicate recipient
subscriptions, without a new general event bus or polling loop per row/tab.

Reuse existing session/error and transport mechanics without weakening ADR 004:
fresh authorization before every visible hint, idle recheck within five seconds,
exact session-expiry deadline, and an independent watchdog that backpressure or
blocked producer I/O cannot suspend. Define bounded buffers, connection/admission
limits, heartbeat/proxy behavior, slow-client disposal, process drain and truthful
401/unavailable/rate-limit recovery. Numerical capacity/buffering budgets remain
open for the later live implementation/load gate; they do not prevent review of
the foundational source/HTTP decision or imply live readiness. No bearer
credentials in query strings or live content payloads.

Frontend scope changes cancel subscriptions/requests and fence late results.
Register live observation before initial snapshots and coalesce startup/burst
invalidations with a trailing refresh. Prove missed hints, reconnects, two API
instances, multi-tab read changes and permission/session loss through real flows.

## Delivery and acceptance gates

1. Architectural/product rules and the initial operating contracts are accepted
   for implementation. All numerical defaults remain unmeasured and subject to
   the specified declared-load gate before producer activation.
2. Deliver additive schemas/migration and compatible readers/consumer before a
   default-off producer, with readiness and an explicit activation watermark.
3. First usable increment: real terminal source, durable projection, HTTP
   list/summary/single-read, plain inbox/compact count and authorized deep links.
   It is a partial F03 increment, not a completed live inbox.
4. Deliver read-all cutoff/recovery and then live SSE in coherent increments.
   Both remain required for full F03; deferral does not remove their tests.
5. Real PostgreSQL gates cover tenant/recipient RLS, concurrent capture/redelivery,
   checksum mismatch, audience changes, insert eligibility races, read-all versus
   insert, retention/redelivery resurrection, hold/purge and rollback.
6. Worker/transport gates cover crash windows, mid-fan-out restart, lease takeover,
   exhaustion/recovery, disabled external-alert policy, queue loss and capacity.
7. Cookie-aware API/browser gates cover real guards/CSRF, scoped read recovery,
   session/role loss, real controlled failed-run delivery, desktop/390px keyboard
   and reduced-motion behavior, and later two-server/offline/live recovery.
8. Run existing execution, external-alert, run SSE and lifecycle regressions plus
   repository quality/boundary checks. Record actual commands/load/environment;
   mocks and React Doctor cannot replace real integration or load evidence.

Rollback disables new producers and UI/live exposure while compatible consumers
drain accepted work and additive records remain recoverable. Do not drop populated
tables or rewrite terminal history. No production/provider provisioning, external
mail, deployment or billing activation is authorized by this decision.

## Existing source anchors and evidence boundary

These are inspected implementation patterns, not inbox implementation or load
evidence:

- [Worker configuration](../../apps/worker/src/config/worker-config.ts),
  `OUTBOX_DISPATCH_*`: existing dispatcher defaults are 25 jobs, 30-second lease,
  five-second publish-operation timeout and ten attempts. They concern transport
  publication, not audience capture. `maintenanceBounds` in
  [maintenance runtime](../../apps/worker/src/maintenance/runtime.ts) separately
  defaults provider delivery to 30 seconds and shutdown cleanup to five seconds.
  Neither proves the proposed capture budget or aggregate worker admission.
- [Tenant transactions](../../packages/database/src/tenant-access/workspace.ts),
  `WorkspaceTransactionOptions`/`verifyTenantContext`, enforce scoped context and
  optional statement limits. [Operator transactions](../../packages/database/src/operator/operator-transaction.ts),
  `runOperatorTransaction`, own abortable checkout, cancellation disposal and
  uncertain COMMIT handling. These establish seams to reuse, not an existing
  capture-wide deadline/admission implementation.
- [Operator command inputs](../../apps/operator-command/src/config.ts) and
  [execution](../../apps/operator-command/src/run.ts),
  `executeConfiguredCommand`, already support bounded actor/reason, command IDs,
  dry-run and status lookup. [Redispatch migration 0061](../../packages/database/migrations/0061_operator_outbox_redispatch.sql),
  `app.redispatch_failed_outbox_event`, demonstrates fingerprinted receipts,
  safe audited outcomes and narrow SQL authority. The proposed inbox command
  requires additive code/migration; it is not supported today.
- [ADR 013](013-retention-workspace-deletion-legal-hold.md) specifies 30-day detail,
  90-day summary, operation-specific receipts and no in-progress reaping.
  [Retention schedule 0055](../../packages/database/migrations/0055_standard_retention_classes.sql),
  `app.schedule_due_retention_batches`, and
  [retention bounds](../../packages/database/src/lifecycle/retention-support.ts),
  `retentionOptionsSchema`, demonstrate explicit classes and durable bounded pages
  (default 100). They do not already include inbox sources or a generic outbox
  expiry. New feature cleanup must integrate the current purge implementation,
  not copy an obsolete historical function over later migrations.

The architectural review used read-only source inspection, not inbox runtime
measurements. Numerical defaults require actual declared-load measurements
before enablement; live numeric capacity is a separate later delivery gate.

### Foundation delivery evidence — 2026-09-28

At the 2026-09-29 verification checkpoint, the foundation on
`feat/workspace-inbox-foundation-main` remained uncommitted. It contains strict
browser-safe list/summary/single-read schemas and generated artifacts, additive
migration 0120, and matching typed source/audience/recipient-state/entry tables.
It includes composite tenant references, recipient API policies distinct from
worker projection authority, fixed horizons, dedupe indexes, first-read protection
and explicit child-first participation in the existing guarded purge function.
No deferred read-all table, producer, queue consumer registration, operator
recovery command, HTTP handler, UI or SSE has been implemented or activated.

Executed no-service checks:

- `pnpm --filter @pertexo/contracts test`: 20 files, 118 tests passed (22 new
  inbox cases).
- `pnpm --filter @pertexo/database test`: 122 files, 869 tests passed; includes
  the new static migration/schema tests. These are not PostgreSQL assertions.
- Focused migration-history/readiness/foundation run: four files, 73 tests passed.
- Independent review reran 22 contract cases (278 ms) and nine static
  migration/schema cases (319 ms): all 31 passed. This does not establish
  PostgreSQL behavior or capacity.
- Contracts and database `build` and `typecheck`: passed.
- `contracts:generate` and `contracts:check`: generated artifacts current;
  OpenAPI passed with one existing identity-workspace 2xx-response warning,
  none in the inbox document.
- `database:schema:check`: five tests passed; 93 migration-owned tables,
  64 typed and 29 raw SQL. `architecture:check`: 19 tests and both graph/import
  checks passed. Scoped ESLint, Prettier and `git diff --check`: passed.

Eight real-runtime-role PostgreSQL foundation regressions are written. The one
isolated qualification run failed during fixture setup: **zero passed, eight
failed**, and no inbox behavior assertions were reached. They cover
recipient/tenant isolation, current eligibility,
expired retained rows, read-time preservation, grant restrictions, duplicate and
cross-tenant constraints, fixed horizons/rollback and the migrated purge order.
The eighth case exercises actual bounded tenant purge, legal-hold blocking and
release, child-first deletion and preservation of an unrelated workspace.
The failed run used only the approved disposable PostgreSQL fixture on port
55436. Normal teardown removed its owned database; the before/after database
inventory was unchanged. Evidence is in
`/tmp/pertexo-inbox-foundation-pg.X2SjPL`.

Source diagnosis identified the run fixture's missing tenant context: its bare
admin INSERT invoked the admission trigger under forced tenant RLS, hiding the
workspace's provisioned entitlements and causing `workspace.run_admission_denied`.
The test-only correction uses the existing scoped API-role transaction for that
INSERT, preserving the admission guard and RLS.

The reviewed correction then passed **eight of eight real PostgreSQL tests** in
one approved run (2.02 seconds total; test execution 1.06 seconds), with zero
failures, skips or retries. The manager independently inspected the outcome and
accepted this foundation qualification. Evidence is in
`/tmp/pertexo-inbox-foundation-pg-corrected.AfQAD8`. The owned database
`pertexo_test_workspace_inbox_df0915cef51a4d00bb14e3846dd3c73d` (OID 278358) was
normally removed, with zero remaining connections. Before/after inventories
matched SHA256 `8dea1fc6b8892e8d35c3ad819bf609bc769ec90956eef9dde6c275522bb6f954`;
the seven baseline databases, including the three older diagnostic databases,
were unchanged. No service was started/stopped or timeout increased. The purge
case uses an arranged lifecycle ledger, not an external object-provider proof.

The tests require explicitly configured disposable-environment database URLs.
They do not yet cover the
future capture/projection commands, retention execution or concurrency/load.
No HTTP/browser/live-stream/provider gates ran, and no F03 completion is claimed.
Readiness currently advances the migration-head inventory; feature-specific
command/body/grant readiness must accompany the later runtime implementation.

### Inactive P1 implementation evidence — 2026-09-29

The reviewed foundation was subsequently merged through PR115 at main
`e292c857152ec61b2995f6608239c668a66e22c6`. Natural main CI 36495495693 and
CodeQL 36495495631 passed without reruns. Historical failed/corrected PostgreSQL
qualification above remains unchanged.

Uncommitted P1 adds forward migration 0121 and
[capture persistence](../../packages/database/src/execution/workspace-inbox/capture-store.ts),
not an enabled producer or projection runtime. One owned `capture` operation
contains claim, capture and acknowledged-rollback failure accounting. Narrow
context-validating owner-executed commands preserve forced tenant RLS, avoid
granting worker access to user/member tables, and acquire the shared workspace
lifecycle lock before the source lock. One unlimited INSERT statement freezes
the audience; its completed count and marker commit in the same transaction.
Lease/fence, ten-acquisition failure budgets, stored jittered delays and
successful-marker reset remain durable. Lost COMMIT acknowledgments never trigger failure accounting or
automatic recapture. Process admission includes raw checkout/query settlement
and observed pinned-driver connection end, not just synchronous pool removal.
Unconfirmed disposal fails readiness and refuses further local writes, including
after a late closure. Client end is disposal evidence, not proof of backend
rollback or a measured cancellation bound. A fresh wall-clock check after the
entire audience INSERT prevents an earlier statement timestamp from accepting
capture past absolute source expiry; failure rolls back audience and marker.

After strict input/context/workspace checks, missing source and outbox together
return unavailable without writes, reconstruction or a successful receipt.
Missing outbox with retained source is rejected; retained outbox payload,
trace/checksum and aggregate evidence are validated even if the source is gone.
The identifier-only interface cannot authenticate already-deleted bytes. This
safe unavailable disposition grants no authority and does not verify delivery.

Executed no-service checks: 124 database files / 902 tests (33 new unit/static),
database build/typecheck, five schema tests (93 tables) and 19 architecture tests
plus graph/import checks passed. Independent correction re-review returned no
standards/spec findings and passed all 42 focused unit/static cases.

One separately authorized run of the
[PostgreSQL cases](../../packages/database/test/workspace-inbox-capture.integration.test.ts)
passed **18/18**, with zero failures, pending/skipped tests or retries (8.81-second
suite). It used the approved isolated PostgreSQL 18 fixture on 127.0.0.1:55436,
with actual migration/API/worker roles and forced tenant RLS. Cases cover command
authority, frozen unlimited audience, claim contention/stale fencing, atomic
rollback and failure budgets, delayed COMMIT acknowledgment, source-lock
reconciliation, absolute/in-flight expiry, actual statement timeout, and the
absent/retained/corrupt evidence matrix. Sanitized results and cleanup evidence
are in `/tmp/pertexo-inbox-capture-pg.PhjxF6`; independent review accepted them.

The fresh owned database
`pertexo_test_inbox_capture_85cb54612211495db66323042171c902` (OID 281930,
owner `pertexo_owner`) was removed by normal fixture cleanup after disconnection.
Parent and child exited zero, zero connections remained, and the owned child
process group was absent. All seven preexisting database names/OIDs/owners were
unchanged: SHA256 `8dea1fc6b8892e8d35c3ad819bf609bc769ec90956eef9dde6c275522bb6f954`.
No force drop/backend termination, service start/stop, Redis, API/browser or
provider journey occurred. P1 is locally verified and uncommitted, not full
projection or F03 completion.

Review-correction feedback: the first five added assertions failed before the
disposal/expiry fixes (three locally settled COMMIT/rollback/abort admission
cases, unconfirmed-end quarantine, static post-INSERT clock ordering). The
missing-evidence branch assertion also failed before its correction. Additional
unit cases cover already-ended clients and closure before rollback accounting.
The PostgreSQL additions assert complete expiry rollback and the absent/retained
source/outbox matrix; those assertions passed in the single approved run.

The delayed-ack case interposes the driver response after a real COMMIT; the
paused-owner case shortens only an arranged fixture lease. These are bounded
persistence regressions, not aggregate-load, cancellation-capability-at-load,
OS-process-crash, worker/transport or production-capacity qualification. Client
end still must not be treated as proof of backend rollback. No repeat run or
producer/activation authority is implied by this evidence.

No accepted activation decision is changed here. The proposed deployment-global
control epoch and authoritative terminal-transaction cut remain unapproved.
Fan-out, durable runtime scheduling, source resume, dependency-aware retention,
HTTP/frontend, read-all/SSE, declared-load and activation gates remain required.
