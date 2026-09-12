# Database migration runner and history fixtures

Date: 2026-09-12. Primary reviewer fully read all 12 files below. Three selected
unit files passed (9 tests, 142 ms). Execution-plan unit fixtures and both live
integration suites were inspected, not run. A source-level injected pg checkout
probe reproduced loss of the acquisition error; no database connection occurred.
Numbered SQL bodies are reviewed separately and are not counted here.

## Individual file judgments

| File | Disposition | Specific judgment |
| --- | --- | --- |
| `packages/database/src/migrate.ts` | FIX/TEST WQ-135 | Minimal CLI is appropriate, but raw error logging exposes arbitrary nested driver diagnostics and importing it executes migrations. Add a guarded, injectable CLI seam only for failure/output/process evidence; retain concise entrypoint. |
| `packages/database/src/migrations.ts` | KEEP; FIX/TEST WQ-135; CONDITIONAL WQ-136; REFACTOR WQ-137 | Clear one-session advisory-lock owner, quoted identifiers, per-migration transactions and ordered cleanup. Checkout failure plus pool-end failure loses the first error; lock-wait budget is installed after migration lock acquisition. Future mode declarations need stronger failure/restart evidence. |
| `packages/database/src/migration-execution-plan.ts` | KEEP; TEST/REFACTOR WQ-136/WQ-137 | Discriminated modes, unknown-file rejection and published-mode fence are useful. Rollback window currently checks only lexicographic ordering, not a real retained predecessor; returned mode lookup can be a direct named branch instead of nullish-IIFE throw. |
| `packages/database/migrations/migration-execution-plan.json` | DATA; KEEP | Five-line checked-in plan declares all current SQL through 0086 transactional and no exceptions. Verified exact current head; do not retroactively change published migrations to online. |
| `packages/database/test/migration-runner.test.ts` | KEEP; TEST WQ-135/WQ-137 | Proves validation before checkout, pool cleanup and ordered multi-error preservation, including undefined primary error. Extend acquisition+cleanup and timeout/lock progression matrix rather than replace existing regressions. |
| `packages/database/test/migration-execution-plan.test.ts` | KEEP; TEST WQ-136; FIX fixture WQ-137 | Useful undeclared future mode and rollback-order cases. Title promises restart/size requirements but only invalid rollback window is exercised; temporary directories aren't removed. |
| `packages/database/test/migration-checksum-compatibility.test.ts` | KEEP; TEST WQ-137 | Explicit accepted historical checksums and wrong-name rejection preserve narrowly authorized migration history. Keep exceptions fixed and documented, not a generic checksum-ignore option. |
| `packages/database/test/migration-execution-modes.integration.test.ts` | KEEP; TEST WQ-136; FIX fixture WQ-137 | Real per-file commit, online index and bounded resume tests are valuable. Online test is first-run success, not interrupted/restart-safe index proof; temporary files remain and failed database drop skips later databases. |
| `packages/database/test/published-migration-repair.test.ts` | KEEP; TEST WQ-137 | Text presence guards important repair statements but cannot establish every published variant converges. Rename evidence claim and retain alongside real upgrade cases. |
| `packages/database/test/published-migration-repair.integration.test.ts` | KEEP; TEST WQ-137 | Real forward upgrade from deliberately damaged corrected prior schema proves one selected reconciliation shape and idempotent second run. Does not replay all retained original SQL variants or their data. Cleanup directories/database independently. |
| `packages/database/test/support/migration-history-fixture.ts` | KEEP; TEST WQ-137 | Central suffix lookup reduces repeated expectation lists. Strengthen declared fixture validation for sorted unique migration names/head rather than introduce a dynamic runtime-derived expected list. |
| `packages/database/test/fixtures/migration-history-v1.json` | DATA; KEEP | All 66 entries exactly match current SQL suffix 0021–0086, including append-only repair sequence. Retained expectation is test data, not proof that SQL executed. |

## WQ-135 — preserve migration failures and make runner time bounds explicit

P2 FIX/TEST. `migrations.ts:migrateDatabase:312–324` currently has:

```ts
const client = await pool.connect().catch(async (error: unknown) => {
  await pool.end();
  throw error;
});
```

If both reject, only pool.end's error reaches the caller. Probe replacing actual
pg Pool checkout/end with synthetic rejections returned **cleanup only=true,
acquisition=false, AggregateError=false**. The later ordered finally cannot
help because this occurs before it. Preserve primary plus cleanup using the
existing local aggregation policy, including undefined and non-Error causes.
Do not call a hostile instanceof/name operation while formatting cleanup errors;
`preserveMigrationFailureDuringCleanup:18–43` should also be nonthrowing when
classifying an unknown cleanup value. Retain ordered reset/unlock/release/end
attempts and don't replace them with unguarded Promise.all.

Time-bound checks:

- Pool at `:319` has no explicit connection timeout. SQL statement_timeout is
  configured only after checkout/discovery. Select an explicit bounded acquisition
  timeout for the migration CLI/runner and test unavailable/stalled connection;
  don't assume SQL timeout bounds establishing a TCP/database session.
- At `:355–365`, statement_timeout is set, then pg_advisory_lock is acquired.
  lockTimeoutMs is installed later in transaction setup. Thus the configured
  lock timeout does not govern this initial migration serialization wait; the
  longer statement timeout does. Either apply the intended lock budget before
  advisory acquisition or document a separate bounded advisory-wait policy.
  Prove it with two controlled sessions before calling it a ten-second lock
  budget. No live timeout behavior was measured during this audit.
- Validate options against safe integers and PostgreSQL millisecond maximum,
  not Number.isInteger/minimum alone. Maintain lock versus statement units and
  explicit finite limits; do not add an arbitrary total migration duration that
  invalidates supported long reviewed migrations.

`migrate.ts:14–16` console.error receives the entire unknown error, including
possible driver detail/query values or nested config failures. Extend PF-02's
bounded diagnostic vocabulary to the CLI with fixed operation and safe fields;
never log URL/password, SQL text, detail, arbitrary name/message or cause chain.
Keep successful applied migration filenames (validated from package files) and
nonzero exit status. Add an import-safe main guard and injectable runner/output
only as needed for direct/compiled CLI tests; no new generic process framework.

Acceptance: invalid options do not construct/connect; acquisition fails and end
also fails with both causes retained; all later cleanups attempted; progress
observer throws without changing committed outcome; failed/successful CLI
output is bounded and exit status correct. Use source-local fake pg tests first,
then authorized disposable lock/connection tests. No production migration edit.

## WQ-136 — qualify future nontransactional modes before relying on declarations

P2 TEST/CONDITIONAL. Current checked-in plan has **zero** online/resumable
migrations; this is a tooling qualification gap, not a current failed schema
upgrade.

1. `runOnlineMigration:149–176` accepts restartSafe metadata but performs no
   postcondition verification. The test uses CREATE INDEX CONCURRENTLY IF NOT
   EXISTS and runs only once. Interrupted concurrent index creation can leave
   an existing invalid index; IF NOT EXISTS is not verification of valid/indexed
   semantics. [PostgreSQL CREATE INDEX](https://www.postgresql.org/docs/18/sql-createindex.html)
   documents both limitations. Before using this mode for a real migration, add failure-after-DDL/
   before-ledger and failed-concurrent-index restart cases. Verify index validity,
   identity and definition before recording migration success. Any repair must
   target the exact reviewed index, not auto-drop unrelated indexes.
2. The runner sends the rendered online file as one query. Do not infer support
   for arbitrary multi-statement scripts needing independent transactions.
   Define and test the supported online-file shape; preserve single-statement
   concurrent index behavior. Regex rejection of BEGIN/COMMIT/ROLLBACK also hits
   comments/literals/function bodies; don't call it a SQL parser. Prefer a narrow
   explicitly validated format or reviewed operation structure over inventing
   a fragile statement splitter. Future broad SQL grammar support needs its own
   scope decision, not a routine readability change.
3. Execution-plan rollbackCompatibleThrough is only compared lexicographically.
   Validate it references the intended retained predecessor/window and verify
   transactionalThrough is a legitimate known boundary where that is the
   package contract. Preserve fixture support for intentionally partial
   directories; don't globally require all historical SQL in every fixture.
   restartSafe and maximumDatabaseBytes are declarations/preflight, not measured
   locking/WAL/rollback evidence. Retain the separate external qualification gate.
4. Resumable tests prove two bounded incomplete invocations followed by success.
   Add crash/rollback midway through a batch, changed job checksum, malformed
   progress and completed job/history consistency. Validate accumulated counters
   before converting bigint strings to JavaScript numbers for telemetry. A total
   batch cap does not bound rows per batch; the migration's reviewed query must
   do so. Preserve atomic batch work/progress/terminal history writes.
5. Current runResumableMigration emits a completed progress event inside its
   final batch, then migrateDatabase emits another completed event for the same
   migration. Define whether batch completion and migration completion are
   separate events; distinguish them or emit terminal completion once. Keep
   observer failures isolated from the migration result.

Acceptance: execute selected new mode only after its interrupted/repeated-run
tests establish restart postconditions, bounded batch semantics and supported
rollback overlap. If no new online/resumable migration is needed, retain current
transactional plan and record future-mode qualification as pending—not a reason
to rewrite the published 0000–0086 files.

## WQ-137 — keep migration history evidence precise and fixtures owned

P2 TEST/REFACTOR; no arbitrary module split.

- Rename migrationRunnerOptionsSchema to migrationRunnerDefaults; it is a frozen
  values object, not a validator. Keep one session owner around discovery,
  authority setup, migration dispatch and cleanup. Replace executionFor's
  nullish-IIFE with a clear lookup guard if editing that function. Avoid helper
  extraction that makes connection/role state harder to follow.
- Plan unit tests should separately reject missing restartSafe/false, nonpositive
  size, invalid batch bounds, unknown files, changing a published mode, missing
  mandatory plan, invalid JSON/schema and invalid rollback anchor. Validate
  missing optional fixture plan is the only fallback. Each mkdtemp must be
  registered before write/read and removed in finally/afterEach even when the
  tested promise rejects. Modes fixtures need the same directory ownership.
- Migration mode database cleanup should attempt all created database drops even
  if one fails, report residual owners, and always close admin. Track successful
  creation versus planned names. Published repair afterAll must not skip database
  cleanup if directory removal fails. Use existing disconnected-database helper
  and exact generated paths, not shared/broad deletion.
- `published-migration-repair.test.ts` title says every published 0037/0038 variant
  converges, but assertions are string contains. The integration test starts
  current corrected files through 0066 and deletes selected objects while
  rewriting two checksum rows. Label that synthesized prior-state case honestly.
  To claim all variants, retain and apply actual published SQL/checksum fixture
  pairs or separately justified complete schema/data equivalents, with each
  variant's expected final functions/grants/counters and populated-data behavior.
  The other accepted 0038 checksums and 0070 variant need their own evidence;
  don't erase the allowlist to make current tests simpler.
- Keep migration-history-v1.json checked in as an independent expected sequence.
  Add format/order/uniqueness/exact current suffix consistency validation and
  focused suffix/missing-name helper tests. The audit verified 87 current SQL
  files, head 0086, and exact 66-entry suffix starting at 0021. Reuse this helper
  for long new upgrade lists only when the test means all later migrations;
  retain explicit prior-to-target expectations for isolated target upgrades.

Order: WQ-135 error/boundary safety, precise fixture cleanup and test claims,
then WQ-136 only to the extent required by the next reviewed migration mode.
No SQL, runner implementation, service, commit or push was changed.
