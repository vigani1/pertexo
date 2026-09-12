# Database schedules and recurrence

Date: 2026-09-12. Primary reviewer fully read these 14 files; all inventory
hashes match. Four selected unit files passed, 26 tests (5.26 seconds). The
recurrence fault tests run bounded local child processes; no database service or
integration suite ran. Injected scanner probes intercepted every query and used
shared runtimes with lock-wait monitoring disabled.

## Individual file judgments

| File | Disposition | Specific judgment |
| --- | --- | --- |
| `packages/database/src/triggers/schedule-recurrence.ts` | KEEP semantics; CONDITIONAL WQ-161 | Strict recurrence, raw-cursor progress/bounds, immutable interval anchor and DST identity are cohesive. Preserve the distinction between raw parser cursor and adjusted occurrence. Repeated formatter construction warrants bounded measurement, not replacing cron semantics. |
| `packages/database/src/triggers/schedule-trigger-database.ts` | KEEP; REFACTOR/TEST WQ-160 | Actor/parent authorization, workflow-first locking, immutable replay result and atomic audit belong together. Repeated row-to-recurrence translation and command phases can be clearer; health/error reset policy needs explicit evidence. |
| `packages/database/src/triggers/schedule-trigger-scanner.ts` | FIX/TEST WQ-159; WQ-157 extension | Separate claim and acceptance authorities are intentional. Abort is only an ignored query property; claim processing before try, secondary error replacement and partial construction need correction. |
| `packages/database/src/triggers/schedule-trigger-errors.ts` | KEEP | Small two-code error preserves stable not-found/conflict behavior and useful messages. No generic error conversion is needed. |
| `packages/database/src/triggers/schedule-triggers.ts` | KEEP | Compatibility barrel preserves existing imports while database commands and worker scanning have separate responsibilities. Removing it offers no meaningful depth improvement. |
| `packages/database/test/schedule-recurrence.test.ts` | KEEP | Exact fixed-instant cases prove strict syntax/timezone, equality-as-due, interval bounds, anchor stability and one-hour gap/overlap rules. |
| `packages/database/test/schedule-recurrence-dst.test.ts` | KEEP; TEST WQ-161 | Child SIGKILL deadlines correctly bound synchronous regressions; repeated-hour, half-hour shift, long backlog and hostile cursor rows add real evidence. Keep direct expected instants rather than recomputing expectations with the subject parser. |
| `packages/database/test/schedule-trigger-migration.test.ts` | KEEP; TEST WQ-162 | Historical DDL syntax checks document intended immutable config, leases and deferral. They are not live fairness/authority proof. |
| `packages/database/test/schedule-claim-migration.test.ts` | KEEP | Scoped due-CTE checks protect the actual locked eligibility recheck, including search path/RLS/grants. Exact formatting coupling is acceptable for a published migration tripwire. |
| `packages/database/test/schedule-claim-migration.integration.test.ts` | KEEP; TEST WQ-162 | Exact 0080 upgrade, before/after helper metadata and explicit claim privilege checks are valuable. Artifact backfill assertion belongs to a distinct named scenario; retained schedule state needs its own upgrade evidence. |
| `packages/database/test/schedule-claim-concurrency.integration.test.ts` | KEEP; TEST WQ-162 | 1,000 real concurrent worker attempts assert returned token equals the one live lease. Useful stress coverage, not proof a particular interleaving occurred; add deterministic coordination and failure cleanup. |
| `packages/database/test/schedule-triggers.integration.test.ts` | KEEP; TEST/REFACTOR WQ-162 | Real admission, outbox, notification pins, operator replay/reconciliation, fairness and degradation are inspected. Broad operator setup hides the schedule scenario's prerequisites and adds coupled mutable state. |
| `packages/database/test/schedule-triggers-part-2.integration.test.ts` | KEEP; TEST/REFACTOR WQ-162 | Retains occurrence dedupe, admission deferral, skip, republish history and immutable command replay. Later list test depends on earlier republish; beforeAll runs a substantial acceptance story. |
| `packages/database/test/support/schedule-triggers.integration.support.ts` | KEEP isolated DB; fixture FIX/REFACTOR WQ-162 | Random database ownership is correct. Eager repository construction before initialize starts monitors; sequential cleanup stops at first failure. Factory should acquire only the scenario's required owners. |

## WQ-159 — own cancellation and all claimed schedule work

P2 FIX/TEST; integrates WQ-140 and worker WQ-102. In
schedule-trigger-scanner.ts:116–120 the signal is placed on pg QueryConfig, which
installed pg 8.23.0 does not consume. It is not passed to withWorkspaceTransaction
at 159–226, nor checked before starting each claimed item. A pre-aborted source
probe returned a fulfilled empty scan after one claim query. This is not evidence
of infinite SQL: the existing role query/statement timeouts still apply.

Use the established abort-aware transaction/acquisition owner for claiming where
compatible with its security-definer/global authority, pass the signal to tenant
acceptance, and check between claims. Do not relabel caller cancellation as a
permanent schedule failure. Specify what happens to the remaining claimed batch:
bounded best-effort release with preserved token fences, or explicitly documented
lease-expiry recovery if the database is unavailable. Do not return actively
querying clients to a pool or rely on Promise.race as cancellation.

Claim parsing, recurrence resolution and the null-occurrence release precede the
try block at 126–158. An injected valid-identity row with invalid cron produced
TypeError and only the initial claim query: neither fail nor release was attempted.
The failure path at 230–246 also awaits fail/defer SQL before preserving the
original error; secondary query rejection replaces that cause. An early failure
abandons later claimed rows until their bounded leases expire. These are recovery
and diagnostic gaps, not proof that accepted occurrences are lost.

Proposed phases:

```ts
const claims = await claimDueSchedules(input); // existing authoritative SQL
for (const claim of claims) {
  // Validate safe claim identity before using it for any cleanup command.
  // Within claim ownership: resolve -> accept/skip -> complete.
  // On failure: preserve cause, classify quota/cancel/failure, retire or expire.
}
```

Keep token-based fencing, one database observation, scheduled UTC identity,
quota deferral without advancing next_fire_at, and acceptance+completion in the
same tenant transaction. Do not parallelize the batch just to shorten the loop.
Malformed identity must never be used blindly in cleanup. Add deterministic
pre-abort, queued checkout, mid-claim/mid-acceptance, between-row abort, invalid
recurrence, failed release/defer/fail, stale token, and later-row retirement tests.
Then qualify backend cancellation and lease recovery in a disposable database.

WQ-157 extension at constructor lines 91–103: both pool leases are acquired
before compatibility parsing, and second acquisition can throw after the first.
Validate pure release input first, protect partial two-pool acquisition, and
test wrong borrowed-runtime authority without closing caller-owned runtimes.

## WQ-160 — expose schedule command phases and coherent health policy

P2/P3 REFACTOR/TEST. schedule-trigger-database.ts:239–397 is one legitimate
transaction, but claim/replay, current-config read, enable-time recurrence,
paired state update, audit and snapshot completion can be private named phases.
Keep the transaction visible in the orchestrator. Do not create a file per query
or a universal idempotency abstraction: this command stores an immutable response
snapshot, unlike webhook command replay's current-health response.

The cron/interval row conversion repeats in this file, the scanner and workflow
materialization. A package-private parsePersistedScheduleRecurrence accepting the
actual row shape can remove that duplication if it keeps desired-config parsing
distinct. Use clear local guards/switches; the simple enabled ? active : disabled
pairs are readable and do not independently justify abstraction.

At 335–363 enable/disable writes health_status while retaining last_error_code;
enable can return healthy with a prior schedule.admission_throttled or scan_failed
code. admission_deferred_until is retained too. Specify whether those fields are
current health or historical evidence. If current, clear resolved error fields
atomically with the paired status transition; if historical, document the field
and test its presentation. Don't clear quota backoff merely to make the UI look
healthy or rewrite accepted occurrence history. Acceptance covers degraded ->
disable -> enable, active no-op commands, disabled next_fire retention, skip
re-enable advancement, catch-up retention, exact replay after later state changes,
single audit record, parent mismatch and revoked actor. Apply WQ-144 authority
linearization only after its explicit contract decision.

## WQ-161 — optimize recurrence only within a proven semantic envelope

P3 CONDITIONAL. localParts at schedule-recurrence.ts:80–105 constructs a new
Intl.DateTimeFormat per call. resolveCronOccurrence performs up to 180 local
identity checks for a normal matching occurrence and a minute-by-minute gap
search; greatest/next traversal can repeat that work. A small current-source
local sample measured ordinary */5 Berlin observations at 33/22/19 ms and a
minute-frequency repeated-hour observation at 236/321/221 ms. These three-sample
figures are diagnostics, not production percentiles or a claimed SLO failure.

Benchmark representative supported zones, ordinary/overlap/gap dates and a
bounded scan batch. First consider one formatter per resolution/timezone reused
through private helpers, with no unbounded process cache. An offset-transition
optimization is a separate larger change and needs stronger equivalence evidence.
Keep raw progress and MAX_CRON_CURSOR_STEPS even after optimizing; a fast infinite
loop is still incorrect. Preserve the pinned parser, strict IANA list, first-valid
gap and earlier overlap rules, equality-as-due, and no years-long enumeration.
Pass only if all fixed instant/property cases remain equal and measured allocation/
event-loop cost improves; otherwise KEEP. Don't alter ADR 014 skip semantics as
part of performance work: the existing contract explicitly creates no run for a
skipped observed occurrence.

## WQ-162 — make schedule integration evidence focused and deterministic

P2 TEST/fixture REFACTOR. Move resource construction in the shared fixture under
owned initialization, protect every acquisition and run all closers even if one
fails. Keep random disposable databases and ownership-checked cleanup. Reuse the
existing disposal hygiene for ownerQuery when rollback fails (WQ-150). Split
optional operator/replay setup from the minimal schedule fixture; don't remove
its valid end-to-end lineage proof.

Each independent test should create the state it needs. In part 2, the list case
assumes the earlier republish produced exactly one current schedule, while suite
setup creates/claims/skips/expires/accepts rows for all cases. Replace this hidden
ordering with a scenario factory or keep a coherent story inside one named test.
Use persisted database observations rather than assuming a minute never turns
while multiple SQL calls/assertions run. Preserve notification pin and outbox
assertions; an empty executable storage fixture is not an engine execution test.

The 1,000-race suite is useful optional stress evidence. Add a bounded coordinated
two-client regression that proves the intended eligibility/lock interleaving,
and release every returned claim in finally if an assertion fails. Do not lower
the iteration count and call the race fixed merely to improve test speed.

Upgrade tests already prove security metadata preservation, which should remain.
Add retained schedule/claim/occurrence row evidence across the migration. Name the
unrelated artifact-expiry backfill test separately so a failure points to the
right owner. Static SQL tests remain historical tripwires; don't rewrite published
migrations or treat substring checks as runtime RLS/fairness proof.

Order: WQ-159 plus constructor ownership; independent fixture/regressions;
WQ-160 private readability/policy work; WQ-161 only through its measurement gate.
No production or test source was changed by this review.
