# Database coordinator state, plan commitment and wakeups

Date: 2026-09-12. Primary reviewer fully read these 33 files. Integration suites
were inspected, not executed. Two static migration suites passed (3 tests, 79 ms).
Injected-client actual-source probes reached both read-only artifact-lock queries
and demonstrated an acknowledged commit waiting on an uncancelable metric query.
The probes performed no network access. PostgreSQL's official executor source
confirms the read-only incompatibility; no live database reproduction is claimed.
The large node-attempt integration is assigned to the subsequent attempt review.

## Individual file judgments

| File | Disposition | Specific judgment |
| --- | --- | --- |
| `packages/database/src/execution/coordinator-run-store.ts` | KEEP | Small public module owns the pool lease and hides substantial load/commit/acknowledge behavior. Default-disabled run-timeout context preserves rollout compatibility. |
| `packages/database/src/execution/coordinator-run-store-contract.ts` | KEEP | Distinct ready/capacity/unsupported, committed/replayed/stale/deferred and delivery errors communicate real outcomes. Unknown plans/checkpoints are deliberately decoded at the persistence seam. |
| `packages/database/src/execution/coordinator-run-store-transactions.ts` | KEEP snapshot and cancellation ownership; FIX caller WQ-181 | Read-only repeatable-read is intentional. Caller queries must fit it; do not silently turn this helper into a write transaction. |
| `packages/database/src/execution/coordinator-run-store-commit.ts` | KEEP atomic phases; FIX/TEST WQ-182 | Validates before checkout, locks durable authority, commits physical/checkpoint/events/receipt together and audits mismatch after rollback. Post-commit schedule metric can keep the successful operation pending. |
| `packages/database/src/execution/coordinator-run-store-commit-state.ts` | KEEP; TEST WQ-185 | Exact fingerprint plus checkpoint permits replay; revision/cursor/high-water/failure/control checks reject stale or forged plans. Admission deferral records a new durable wakeup and completes the old receipt. Order is semantically significant. |
| `packages/database/src/execution/coordinator-run-store-delivery.ts` | KEEP; TEST WQ-185 | Outbox checksum/identity, completed receipt and reservation release compose atomically. Mismatch audit occurs in its own committed transaction before the public error; moving that throw inside would lose evidence. |
| `packages/database/src/execution/coordinator-run-store-plan.ts` | KEEP ownership/delta guards; CONDITIONAL/REFACTOR WQ-183 | Existing loops, budgets, admissions, output locators and current physical state are independently checked. Active-root lookup repeatedly materializes/scans all invocations; use a local index only with exact scope equivalence. |
| `packages/database/src/execution/coordinator-run-store-plan-validation.ts` | KEEP; REFACTOR WQ-183 | Envelope, attempt, admission and event validators are already cohesive private phases. The sticky-state ternary can be an explicit guard; no arbitrary condition cap or new validation DSL. |
| `packages/database/src/execution/coordinator-run-store-status-validation.ts` | KEEP; REFACTOR/TEST WQ-183/185 | Ordered transition acceptance and expected-event equality defend persisted truth. Helper names hide mutation of expectedNodeEvents. Preserve the rejection of invented running-body terminal outcomes (WQ-045). |
| `packages/database/src/execution/coordinator-run-store-validation-values.ts` | KEEP | Two shared validation primitives prevent equality/assertion drift across the plan validators. Canonical equality is intentional, not interchangeable with referential equality. |
| `packages/database/src/execution/coordinator-run-store-observations.ts` | FIX WQ-181; CONDITIONAL WQ-184; TEST WQ-185 | One consistent snapshot validates cursor, physical ownership, pending failures and due/control facts. Artifact locking conflicts with read-only mode. Bounded canonical facts do not imply bounded wire-page bytes. |
| `packages/database/src/execution/coordinator-run-store-fact-physical-state.ts` | KEEP | Separates batched physical lookup from attachment, deduplicates queried attempt IDs, and leaves missing identity explicit for the subsequent fail-closed validator. No per-event SQL loop. |
| `packages/database/src/execution/coordinator-run-store-physical-state.ts` | FIX WQ-181; KEEP status-specific proof | Running physical-ahead, ready recovery, Wait and loop barrier differ legitimately. Exact node/attempt/output/scope checks belong here; duplicate undefined row guard can become one narrowing assertion locally. |
| `packages/database/src/execution/coordinator-pending-failure-observations.ts` | KEEP; TEST WQ-185 | Explicit finite failure/error vocabulary prevents arbitrary persisted tags from entering the engine. Pending failures have no invented durable event sequence. Add malformed timestamp/tuple tests without changing that distinction. |
| `packages/database/src/execution/coordinator-run-store-execution.ts` | KEEP batched writes; CONDITIONAL WQ-183 | Node/attempt/outbox/event inserts are batched and row-count checked. Existing-attempt and terminal-decision per-row work is bounded and lock-sensitive, not grounds for a blanket bulk rewrite. |
| `packages/database/src/execution/coordinator-run-store-settlement.ts` | KEEP | Batched barrier and due-ready transitions validate status, attempt number and database due time before write. Ready recovery is distinct from new attempt admission, including batches above 64. |
| `packages/database/src/execution/coordinator-run-store-run-transition.ts` | KEEP; TEST WQ-182/185 | Intent, checkpoint revision/cursor/fingerprint and run timestamps are persisted together. Schedule input decoding occurs before transaction completion; optional post-commit observation is a separate concern. |
| `packages/database/src/execution/coordinator-run-store-terminal.ts` | KEEP; TEST WQ-185 | Cancellation/policy/rollout gates, deterministic intent identity, severity ordering, physical primary failure and context-size bound are justified. Delivery failure must not revise terminal run truth. |
| `packages/database/src/execution/deadline-wakeup-scanner.ts` | KEEP; TEST WQ-185 | Bounded integer input, transaction-owned signal and narrow global SQL function; no need to merge domain scanner interfaces merely because wrappers resemble one another. |
| `packages/database/src/execution/due-node-wakeup-scanner.ts` | KEEP; TEST WQ-185 | Same ownership discipline with distinct node-due authority. Test malformed function results if fail-closed return decoding is added; empty-result zero is not evidence of a successful scan. |
| `packages/database/test/coordinator-run-store.test.ts` | KEEP static contracts; FIX/TEST WQ-185 | Two tests claiming no PostgreSQL activity create default monitored pools, and the missing-cursor case actually omits signal too. Port-1 abort test relies on a real connection attempt and 50 ms sleep. |
| `packages/database/test/coordinator-retry-migration.test.ts` | KEEP static guard | Exact finite observation tuple and narrow worker grant source checks are useful; actual constraint behavior remains in integration. |
| `packages/database/test/due-node-wakeup-migration.test.ts` | KEEP static guard | Protects bounded claim, durable outbox/checksum and narrow authority syntax. Regex matching is not itself an atomicity/concurrency test. |
| `packages/database/test/coordinator-run-store.fixtures.ts` | KEEP disposable DB/replay helper; FIX/REFACTOR WQ-185 | Prior-head upgrade plus retained rows is valuable. Eager stores/root hooks, hidden delivery creation, pool-as-client transactions, runner database-name trust and close-before-drop failure handling need clearer ownership. |
| `packages/database/test/coordinator-run-store-cas.integration.test.ts` | KEEP; TEST WQ-185 | Exact concurrent replay/fingerprint/deltas, rollback and branch physical corruption checks are substantive. Promise.all proves one winner but not forced overlap; deadline fixture can expire before its supposed pre-expiry load. |
| `packages/database/test/coordinator-run-store-commit-output.integration.test.ts` | KEEP; TEST WQ-181/185 | Exact locators, commit-time artifact invalidation, physical membership rollback, durable retry/Wait and 65 ready recoveries are distinct useful contracts. One broad first case and sleep-based lock inference obscure proof. |
| `packages/database/test/coordinator-run-store-observations.integration.test.ts` | KEEP; FIX/TEST WQ-181/184/185 | Cursor/physical/gap/RLS/large numeric-expansion checks are meaningful. Positive artifact load is absent; aggregate-limit example fails per-fact first. Global query instrumentation/real-clock deadline and cleanup need tightening. |
| `packages/database/test/coordinator-run-store-foreach.integration.test.ts` | KEEP; TEST WQ-183/185 | Real scoped barrier/replay/reload and exact ordinal input/checksum proof. First benchmark reports population 128 but admits one body iteration; keep that population definition explicit. Scanner/fresh-store closes lack finally. |
| `packages/database/test/coordinator-run-store-pending-failures.integration.test.ts` | KEEP; TEST WQ-185 | Proves pending executor evidence becomes an atomic retry decision/due state without inventing a new attempt. Add terminal/rejected-decision counterparts through the same interface. |
| `packages/database/test/coordinator-run-store-parallel-output.integration.test.ts` | KEEP | Intentionally forwards malformed as well as valid branch output unchanged for engine validation and repeats through a fresh store. Database must not silently sanitize this control evidence. |
| `packages/database/test/coordinator-run-store-wakeups.integration.test.ts` | KEEP; TEST WQ-185 | Canonical outbox payload/mark equality, replay zero and changed due fact are strong. Global count assertions depend on fixture isolation; 100 ms future deadline is fragile. |
| `packages/database/test/coordinator-run-store-scheduling.integration.test.ts` | KEEP; TEST WQ-178/182/185 | Pinned admission, schedule metric, predecessor rejection/rollback reader, destination fence and unresolved history are valuable. Giant mixed notification scenario mutates shared credentials; cancellation tail never invokes coordinator commitment. |
| `packages/database/test/coordinator-run-store-migrations.integration.test.ts` | KEEP; TEST/fixture FIX WQ-185 | Zero/prior-head upgrades, retained identity, permission/policy drift and SQL constraints are valuable. Titles stop at historical 0016/0031 while execution reaches 0086; teardown can skip pool close if drop fails. |

## WQ-181 — remove row locks from the read-only observation snapshot

P1 FIX/TEST. The composed path is:

```text
loadAdvanceState
  → withCoordinatorReadClient
  → BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY
  → retained checkpoint artifact check (:physical-state 252–257)
     or fresh observation artifact check (:observations 647–652)
  → SELECT ... FROM app.artifacts ... FOR SHARE
```

Both actual-source fake-client probes recorded readOnly=true and forShare=true,
using otherwise coherent fresh and retained artifact states. The fake returned
ready because it does not implement PostgreSQL transaction rules. PostgreSQL 18's
[executor read-only check](https://github.com/postgres/postgres/blob/REL_18_STABLE/src/backend/executor/execMain.c#L745-L776)
rejects non-SELECT permissions on non-temporary relations, including row-locking
SELECTs. This is a source-confirmed incompatibility, not a live reproduction.

Use non-locking artifact reads in these two snapshot-only paths. Keep the same
snapshot, tenant/status/deleted checks and exact distinct-ID comparison. The
commit path's validateCheckpointOutputOwnership separately locks available
artifacts in a write transaction; preserve that revalidation and its concurrent
invalidation rejection. Do not globally remove FOR SHARE, change the transaction
to READ COMMITTED, or drop physical output ownership checks. A snapshot read is
not a promise that artifact state cannot change after it returns.

Acceptance: isolated real PostgreSQL tests for available artifact in a fresh
completion fact and an already persisted checkpoint both load ready with read-only
mode observed; unavailable/deleted/foreign locators fail closed; inline paths are
unchanged. Invalidate after load and before/during commit, and prove no invalid
checkpoint commits. The existing foreign-artifact test fails at fixture insertion
with 23503; retain it as FK proof but do not count it as load-path coverage.

## WQ-182 — an optional metric must not hold an acknowledged commit indefinitely

P2 FIX/TEST. commit.ts:163–182 queries clock_timestamp through pool.query after the
transaction completes. Rejection is swallowed appropriately, but the query has
neither an operation signal nor a query/statement deadline. A fake-client probe
completed COMMIT, held this metric promise, aborted the caller, and observed the
public commit promise still pending. Releasing the metric allowed committed to
return. This is a successful durable operation delayed by best-effort telemetry,
not a rolled-back transition or a proven duplicate execution.

Bound and own the post-commit observation, or move it into the existing metric
owner while returning the durable result promptly. A bare Promise.race is not
enough if it leaves a checked-out query/socket behind. Preserve database-time
measurement after commit and winner-only emission; do not substitute engine event
time and continue calling it database-observed durable start. If observation
fails/times out, return committed without the optional metric. Avoid an unmanaged
fire-and-forget task whose errors or close outlive its owner.

Tests: failed checkout, rejected/held query, abort after successful commit,
late metric settlement, missing/invalid timestamp and shutdown during metric work.
Assert one durable transition/receipt, bounded return and resource disposal, and
no metric on exact replay. The existing <6-second wall-time assertion can become
a database-timestamp bracket plus a separate benchmark gate.

## WQ-183 — reduce local lookup and control-flow burden without weakening policy

P2/P3 CONDITIONAL/REFACTOR. plan.ts:222–239 spreads nextInvocations.values into an
array and searches it for every active ordinal × body root, serializing scope
paths repeatedly. Build a private per-plan index keyed by node identity and
canonical branch/iteration scope, retaining exact absent/empty equivalence and
first-match/duplicate semantics. Compare small and near-limit loops, branch/nested
scopes and reordered invocations. Proceed only if measured allocation/work improves
without weakening missing-root/status/budget rejection; otherwise KEEP. The
128-item integration admits one body root, so it is not a worst-case lookup test.

The status validator is already decomposed into meaningful transitions. Its
accept... helpers mutate context.expectedNodeEvents as well as validate, then are
short-circuited together at :313–319. Make this effect explicit in names/comments
or use a small ordered dispatcher that keeps the same precedence. Do not replace
it with an opaque rule engine. Keep exact event set/count checks and public error
types. WQ-045 must fix the engine's unsupported active-loop-body cancellation;
the database must continue rejecting that plan until durable attempt evidence
supports the outcome.

In plan-validation.ts:54–57, prefer an explicit sticky-control guard:

```ts
if (plan.checkpoint.cancelRequested || plan.checkpoint.deadlineExpired) {
  assertPlan(plan.attempts.length === 0);
  assertPlan(plan.nodeRunAdmissions.length === 0);
}
```

This improves readability locally without hiding domain conditions. Similarly,
physical-state.ts:193–194 needs one narrowing guard rather than corruptIf followed
by the identical throw. Keep physical running-ahead/Wait/retry/barrier cases distinct.
Do not split the cohesive observation loader solely on length or merge read and
commit validation: they protect different concurrency moments.

Execution persistence already batches new rows and events. Conditional batching
of existing attempts/failure decisions requires preserved lock order, row-count
checks, current-attempt fencing, per-node error semantics and rollback tests.
There are at most 64 attempt admissions per plan; report measurements instead of
calling that bounded loop an unbounded N+1 defect.

## WQ-184 — distinguish canonical protocol limits from wire/materialization limits

P2 TEST/CONDITIONAL. observations.ts:97–122 computes storageBytes but callers only
use count. readPersistedFacts fetches up to 1,000 full payloads before validating
each canonical payload. Current SQL permits up to 524,288 text bytes per event,
so the row count alone allows a large wire page. Canonical 4,096-byte facts and
40,960,000-byte windows do not mean the pg client only materializes those bytes.
The numeric-exponent test intentionally demonstrates valid canonical facts whose
PostgreSQL text expands beyond 64 MiB; a blanket storage-size rejection would
break that accepted contract.

Measure peak memory/latency for normal, expansion-heavy and application-oversized
pages. If materialization is excessive, adapt page size using measured storage
information or another bounded streaming/chunk strategy while preserving one
snapshot and all application-valid rows. Do not change versioned observation
limits or impose a new arbitrary wire cap without compatibility justification.
Repeated normalization in mapEvent/record and downstream passes may be reduced
by retaining a validated private observation type, but do not let raw pg payloads
bypass canonicalization/identity checks. Tie this to measurement, not line count.

The aggregate-limit test currently seeds 130 × 520,000-byte string payloads; each
already violates the 4,096-byte canonical per-fact bound, so it proves the earlier
guard. With 10,000 × 4,096 = 40,960,000, valid individual rows at the accepted count
cannot independently exceed the current aggregate ceiling. Name the actual guard
tested and characterize this invariant instead of manufacturing a misleading
independent aggregate-overflow scenario. Keep count, per-fact, contiguous cursor
and numeric-expansion cases separate.

## WQ-185 — make coordinator tests independent, owned and faithful to their titles

P2 TEST/fixture FIX. Preserve existing semantic assertions; these are substantial
tests, not disposable duplication. Target the following concrete gaps:

- coordinator-run-store.test.ts: missing-cursor input also omits signal and plan,
  so the first instanceof guard wins. Start with a valid complete input and remove
  only the cursor. Disable lock monitoring and install a no-network sentinel for
  tests claiming no PostgreSQL activity. Close stores in finally. Replace the
  real port-1 connection and 50 ms late-failure sleep with a controlled deferred
  checkout; assert late settlement disposal and no unhandled rejection.
- fixtures.ts: construct stores after owned DB creation or explicitly disable
  early monitoring. Root-hook imports and automatic migration chains obscure
  startup. Retain a small owned fixture factory; use a checked-out PoolClient for
  transactions rather than relying on max=1 pool.query affinity. Validate/quote
  runner-provided database names even though the runner owns lifecycle. Attempt
  every store close and owned DB cleanup independently; a rejection must not
  skip drop or admin.end. Keep failed setup cleanup and runtime ownership explicit.
- The implicit testDelivery cache keys only workspace/run/revision and creates an
  outbox before raw commit. Useful default setup must not masquerade as a source
  side effect. Use explicit rawStore/delivery for identity, mismatch, replay and
  no-write tests; keep exact retry sharing deliberate and clean the map per fixture.
- CAS/commit-output: force lock overlap using observed backend locks/barriers;
  50 ms unsettled is not proof the intended lock is held. Keep both winner/replay
  and post-invalidation failure outcomes. The ghost-node case does check rollback
  after writes; additionally assert outbox/event/receipt/checkpoint restoration
  at other late failure points and commit-ack loss without unsafe replay.
- Observations: instrument only an owned client and restore prototype hooks on
  construction failure as well as close. Global Pool.connect replacement can
  observe monitoring queries or leave instrumentation installed after failed
  startup. Keep query-order characterization only where snapshot/client count is
  the contract. enable_seqscan=off establishes available index access, not that
  the production optimizer selects it or meets an SLO.
- Deadline fixtures compute Date.now()+100 before multiple SQL operations, then
  sleep 150 ms. Use controlled database timestamps/due-state changes or bounded
  database-time observation; retain a separate real scheduler timing test if needed.
  Scanner count assertions must use an isolated population, not unrelated due rows.
- For Each: scanner and freshStore closes need finally; preserve exact ordinal
  leakage rejection and checksum/terminal-ordinal/wrong-attempt corruptions.
  Public plan/commit tests should independently vary retained loop identity,
  immutable scope/collection, budgets, event/admission order and missing roots.
- Scheduling: split the roughly 540-line mixed delivery scenario into named
  contexts for pinned config, disable/fence, rotation and historical uncertainty.
  Shared destination version/secret updates need per-case owned fixtures or
  failure-safe restoration. The cancellation tail inserts an already canceled
  run without a policy and never calls commitAdvancePlan; it cannot prove the
  cancellation gate. Exercise a policy-pinned canceled transition and simultaneous
  failure/cancel evidence through the actual store, asserting no intent/outbox.
- Predecessor primary-failure rejection is deliberately narrower than candidate
  context; keep rolling-read compatibility evidence, but call it a schema fixture,
  not a full old deployment. Keep default-disabled run-timeout production coverage.
- Migration suites: update misleading historical-head titles while preserving
  prior cutoffs and retained rows. Consolidate current-head suffix expectations
  only through a verified head mechanism. Restore each changed grant/policy and
  always close admin pools even if drop fails. Never run these mutations against
  shared/production databases as a review shortcut.

Acceptance across refactors: public load/commit/acknowledge behavior, all existing
integration invariants, same transaction/cursor/fence and error classifications,
safe cleanup on injected failure, and exact per-case assertions. Source-only probes
and static suites are not substitutes for the isolated real PostgreSQL regression
required by WQ-181 or the scheduler/queue integration required by WQ-045.

Order: WQ-181 first, WQ-182 with cancellation/resource proof, WQ-185 fixture and
regression work alongside each fix, then WQ-183 local clarity and measured WQ-184
changes. Preserve PF-05/WQ-045 cross-package stop precedence and durable truth.
