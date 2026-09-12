# Database retention integration evidence

Date: 2026-09-12. Primary reviewer fully read these five integration files.
They were not executed: no local database or object-provider mutation was made.

| File | Disposition | Specific judgment |
| --- | --- | --- |
| `packages/database/test/retention-artifacts.integration.test.ts` | KEEP; TEST WQ-193/WQ-202 | Strong capacity accounting, store failure/restart, reference locking, verification/expiry race, advisory cancellation and projected-hold serialization scenarios. Shared workspace/capacity and paused promises require better per-test cleanup. Hold projection test does not exercise external ledger append. |
| `packages/database/test/retention-execution-purge.integration.test.ts` | KEEP; REFACTOR/TEST WQ-202 | Deliberate end-to-end deletion order across execution, trigger, summary and audit data. One test also embeds distinct dry-run cursor reclaim/empty-stage scenarios; several manual transactions lack local failure cleanup. Final residue query omits some seeded webhook rows. |
| `packages/database/test/retention-replay-lineage.integration.test.ts` | KEEP; TEST WQ-202 | Specific dry-run versus enforcement counts, active descendant retention, leaf-first chain removal across pages, held workspace and tenant isolation are meaningful. Shared default workspace plus claim-next scheduling makes test order matter; ledger echo fixture proves no new ledger facts. |
| `packages/database/test/workflow-run-input-retention-migration.integration.test.ts` | KEEP exact historical upgrade; TEST WQ-200/WQ-202 | Precisely asserts 0042→0043, unchanged input and 30-day backfill, missing-pair and over-bound rejection. Fixture setup transaction lacks catch rollback and cleanup can skip database drop after another failure. |
| `packages/database/test/retention-control-foundation-migration.integration.test.ts` | KEEP historical authority matrix; TEST WQ-202 | Exact 0043→0044 cohort, restricted callable inventory, hash/sequence/replay conflicts, immutable facts, cursor/fence and tenant snapshot are valuable. Later tests consume rows created by earlier tests; 100 ms delay infers projection lock state. |

## WQ-202 — preserve retention assertions while isolating state and race evidence

P2 REFACTOR/TEST. Do not mechanically split tests by line count. Keep one cohesive
scenario where each stage's result is the next stage's prerequisite, such as
object delete → absence verification → capacity release or descendant deletion →
ancestor eligibility. Extract setup with typed returned IDs and small read-back
helpers, not a framework of opaque callbacks. Give independent cases their own
workspace/batches so global claim-next discovery cannot consume another test's
unfinished work. Artifact capacity assertions should be against that fixture,
not an assumed empty shared workspace or prior test cleanup.

retention-artifacts: move resource ownership before beginUpload, membership
insertion, verification-start and expiry mutation; failures before the current
try can strand uploadDatabase or a paused finalization. Track and drain
retentionResult, finalization and holdResult in finally after releasing barriers.
Avoid awaiting pool.end while an unobserved operation still owns a checkout.
The advisory-lock test's failure cleanup must abort/drain its waiting operation
even if the PostgreSQL lock observer fails. Acquire multiple blockers under
partial-acquisition cleanup so one failed connect cannot leak the other client.
Always attempt pool.end even when an assertion in finally fails.

The projected-hold test :825 onward proves projection cannot acknowledge while
delete holds the advisory lock. It does not advance the external ledger between
freshness check and lock acquisition. Keep the current assertion and add the
WQ-193 append/read/delete interleaving using the actual command coordinator.
That new test must fail before the protocol correction and prove no destructive
effect for an earlier durable hold, without assuming projection equals append.
Keep no-open-transaction and delayed-store tests: an implementation that moves
unbounded external I/O into a transaction fails acceptance.

retention-execution-purge: separate dry-run paging/lease reclaim/empty-stage
tests from the cross-class destructive pipeline, retaining the pipeline's
required order and different eligible/examined counts. The newly inserted
deferred audit row remains data because dry-run is non-destructive; document
whether the cursor includes it and assert exact selected IDs when claiming
snapshot semantics. Add final residue assertions for webhook deliveries/replay
records and all seeded trigger rows that should disappear; also assert live
trigger configuration that must remain. Existing count checks do not prove
those unqueried rows were deleted. Wrap every fixture transaction in rollback
cleanup on its reserved client, including those currently outside try blocks.

retention-replay-lineage: preserve the difference between dry-run inventory
(examines protected sources) and enforcement (filters protected sources). Do not
change those counters merely to make them uniform. Add a concurrent child-insert
versus source-delete test with a real observed lock and final FK/lineage outcome;
sequential descendant expiry is not that race. Keep the ledger echo fake clearly
scoped to already-projected state, not a legal-hold freshness model.

Historical foundation tests: give immutable-fact checks their own populated
fixture or combine the chronological command scenario explicitly. Require the
expected privilege-matrix row count as well as every allowed=false; every([])
is not a positive authority proof. Replace the 100 ms projection delay with
observed backend lock state and drain the second query before release. The
1.1-second lease wait intentionally uses database time; use bounded polling of
lease eligibility, or retain one explicitly named real-time boundary test and
use deterministic owner-fixture expiry elsewhere. Do not bypass the SQL claim
predicate. Preserve exact historical migration contents/cohort and immutable
tenant snapshot; new SQL repairs belong in forward migrations.

Acceptance: each independent case passes alone and in varied order; failed
barrier/observer/setup/teardown paths leave no checked-out client or unhandled
promise; exact deletions/preservations are asserted; real database race witnesses
precede abort/release; historical tests are not presented as current-head or
real-provider qualification. Dependencies: WQ-193–WQ-199, shared fixture WQ-200.
