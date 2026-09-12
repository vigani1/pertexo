# Remaining-work audit: `packages/database`

Date: 2026-09-12  
Audited tree: `778a406256e5f70ed724f36a72018095ff828c51` with the current
working-tree coverage/test changes present. This began as a read-only audit;
the implementation closeout below records the later authorized local changes.
No migration, commit, or deployment was performed.

## Implementation closeout

D01 resolved the ownership ambiguity by retiring
`src/lifecycle/preview-cleanup.ts` and its testing exports. Repository search
confirmed that it had no production consumer; migration 0053 and the
preview-retention/preview-maintenance runtime remain the single supported
retention owner. A negative migration-contract test prevents the obsolete
consumer and helper names from returning. This was routine dead-code removal,
not a new architecture decision, so no ADR was added.

The disposable database qualification passed after the removal: 300 unit tests,
the integration database cohort, and partial local quality all succeeded. The
merged source-matched database report covers 179 current files at 5,583/6,731
statements and 3,334/4,507 branches. Its selected critical cohort retains one
reviewed unreachable branch and has no unreviewed debt. D03 found no additional
local correctness defect; the documented operation-plus-unlock composition and
cohesive destructive SQL ordering remain deliberate. DB-011, DB-017, DB-016
population checks, and the E01 restore/failover/deletion exercises remain
external.

## Conclusion

The repository-actionable database correctness and code-quality findings from
the earlier package audit are closed, explicitly retained, or covered by the
current qualification. There is one current database row in the source-bound
risk register, and it is a justified unreachable branch rather than an
unreviewed failure. The former local ownership blocker outside that register
was resolved by retiring the unconsumed preview-cleanup delivery module.

Two remaining database obligations are intentionally external to repository
work: representative production workload/planner evidence (DB-011) and
deployed backup, restore, pooler, vacuum, failover, and replica evidence
(DB-017). DB-016 is a continuous deployed-population inventory, not a missing
local implementation. DB-013 remains accepted cohesive complexity. None of
these should be “closed” by adding mock tests or by lowering coverage floors.

The current combined V8 result should be read as a measurement surface, not a
test-quality verdict: all 179 database source files are instrumented and the
integration cohort executes the supported database behavior, while barrels,
type-only modules, and a CLI adapter naturally receive little or no
source-counter credit.

## Scope and reproducible inventory

The generated inventory at
[source inventory](source-inventory.json) enumerates the
current source tree (658 repository source files in total). It is explicitly an
inventory, not proof of line-by-line review or proof that a file is untested.
The database portion is:

| Surface | Current inventory | Disposition |
| --- | ---: | --- |
| `packages/database/src` | 180 TypeScript files, 37,722 physical lines | 156 have runtime statements by conservative AST classification; 24 are declaration/import/re-export-only modules and are intentional seams/barrels/contracts |
| `packages/database/test` | 179 TypeScript, one SQL fixture, one JSON fixture (181 files) | Test cases, real PostgreSQL integration fixtures, and test-only support were reviewed as separate responsibilities; support/builders are not phantom tests |
| `packages/database/migrations` | 87 SQL migrations plus `migration-execution-plan.json` | Numbered SQL is append-only; the execution plan and runner own transactional/online/resumable behavior |
| Package/tooling | `package.json`, raw-SQL registry, two TypeScript configs, and four Vitest configs | Role entrypoints, schema ownership, unit coverage, integration coverage, and test routing remain explicit |

The planning source directory distribution was 13 root files, 13 authoring, six
compatibility, nine connections, 67 execution, 16 lifecycle, six operator, 13
platform, ten schema, 12 tenant-access, 14 triggers, and one validation file.
This was the complete 180-file planning inventory before the orphan module was
removed, not a selected hotspot list.

The 24 no-runtime-counter modules are the six public role barrels (`api.ts`,
`execution.ts`, `lifecycle.ts`, `maintenance.ts`, `operator.ts`,
`recovery.ts`), the test barrel, authoring/compatibility/connections/execution/
lifecycle/operator/tenant-access/triggers testing modules, neutral contract or
type modules, `execution/preview-execution.ts`, and the empty schedule-trigger
barrel. They must not be labeled “untested” merely because V8 has no executable
counter for them. The meaningful zero-execution cases are tracked separately:
the 47-line compatibility readiness adapter is called by application
integration fixtures, the 16-line `migrate.ts` is a process CLI wrapper, and
the now-retired 547-line preview-cleanup delivery implementation had no
production caller.

## Planning evidence

The planning source-bound risk report was
`coverage/risk-uncovered-branches.json` (schema version 7, generated
2026-09-11T21:09:43.867Z): 344 reviewed uncovered-branch entries across the
repository and zero unreviewed entries. Exactly one entry belongs to the
database cohort. The focused unit report for the two intentionally selected
tenant files is 121/122 statements (99.18%), 64/65 branches (98.46%), 21/21
functions (100%), and 110/110 lines (100%). The merged database integration
report covered all 180 source files with 5,580/6,839 statements (81.59%),
3,327/4,580 branches (72.64%), 1,096/1,254 functions (87.40%), and
5,437/6,506 lines (83.56%). The combined dirty-tree artifact adds the unit
hits and records 5,595/6,839 statements, 3,340/4,580 branches, and 1,098/1,254
functions.

The source-stable full qualification
`coverage/local-quality/2026-09-11t20-56-01-049z-49130-c3760a4b/manifest.json`
passed every required cohort with unchanged dirty-tree fingerprint
`c8a90227e19b37e699e03a1bd3f2a84cd02a706807cda13709198458ebec2352`.
The database integration cohort was 419/419, worker integration was 43/43,
database compatibility was 1/1, and the report was validated. The manifest
preserves three authorized AWS exclusions; those exclusions are not database
unit-test failures.

The final remaining-work qualification supersedes that planning evidence:
`coverage/local-quality/2026-09-12t00-42-27-027z-24758-cb521801/manifest.json`
passed all 21 required cohorts with stable start/end source fingerprint
`f52f0af6a8bac8a9b176fe9d09f4df211570c2e5fe4a951d7b47d53a03377400`.
Its database integration cohort remained 419/419 and its database compatibility
cohort remained 1/1. The only later changes are report-only closeout prose.

Useful focused recipes for a future change are:

```sh
pnpm --filter @pertexo/database test
pnpm --filter @pertexo/database typecheck
pnpm --filter @pertexo/database test:integration
pnpm --filter @pertexo/database test:integration:coverage
pnpm quality:local -- --partial integration-database
```

The integration commands require the existing disposable PostgreSQL fixture
and role setup. A green unit run alone does not validate SQL, grants, forced
RLS, transaction ordering, migration upgrades, or cross-process ownership.

## Current risk-register disposition

| Register entry | Status | Evidence and required handling |
| --- | --- | --- |
| `packages/database/src/tenant-access/workspace.ts`, branch 13, `if` at line 118, location 0 | **Reviewed and justified unreachable** | `releaseForAbort` is registered with `{ once: true }`, marks `clientReleased` before calling `client.release(abortError)`, and the listener is removed in `finally`; there is no asynchronous boundary between the mark and removal that can re-enter the guard. Do not add a synthetic test that manufactures an impossible re-entry. If cancellation ownership is changed later, re-run the workspace cohort and reassess this exact source-fingerprinted row. |

The earlier workspace locations around lines 131 and 215 are not current risk
entries: the dirty `workspace-transaction-engine.test.ts` adds the authentic
“abort after acquisition/before setup” and synchronous acquisition race cases.
Likewise, durable unknown-outcome reconciliation is not an uncovered gap: the
current real PostgreSQL node-attempt integration adds processed/duplicate
replay, command/checksum mismatch rejection with no inbox receipt, and stale
status rejection.

## Prior package-audit findings: complete disposition

The historical package audit's DB-001–DB-017 identifiers remain useful
navigation, but their old “required change” prose is not current status. The
current dispositions are:

| Finding | Current status | What remains, if anything |
| --- | --- | --- |
| DB-001 persisted observation capacity | Fixed | Keep the shared observation-window contract and cross-package exact/over-limit/recovery tests. |
| DB-002 repository pool multiplication | Fixed | Deployment must still prove the aggregate connection budget under real replica/pooler topology. |
| DB-003 network I/O under database locks | Fixed in the repository | Preserve the durable prepare/perform/complete and fenced recovery protocol; deployed latency evidence belongs to DB-011/DB-017. |
| DB-004 migration execution strategy | Fixed in repository tooling | Large deployed-dataset lock/WAL/duration proof remains external under DB-011. |
| DB-005 fact loading round trips/joins | Fixed locally | Local 1/1,500/10,000 plans pass; production-cardinality evidence remains DB-011. |
| DB-006 whole-package coverage | Fixed as a continuous control | Keep the merged all-source integration report and source-bound risk register; do not equate its aggregate percentage with missing behavior tests. |
| DB-007 infrastructure/coordinator diagnostics | Fixed | Preserve bounded sanitized diagnostics and primary/cleanup error ownership. |
| DB-008 publication scaling | Fixed and localized | Retain the full retained-version integrity scan because it is a fail-closed corruption check; optimize only with a new measured defect. |
| DB-009 transition-plan batching | Fixed where invariants permit | Per-row CAS/fenced transitions remain intentionally explicit. |
| DB-010 transaction deadlines | Fixed | Keep role-specific statement, query, lock, and idle-transaction budgets and cancellation tests. |
| DB-011 hot-query/index workload proof | **Open, external** | Run representative/burst staging or production workload plans and operational measurements; see exact plan below. |
| DB-012 schema ownership/shape drift | Fixed as a continuous migrated-catalog control | Keep typed/raw catalog checks and mutation protection. |
| DB-013 contract ownership/factory locality | **Accepted retained complexity** | Revisit only for a concrete smaller seam that preserves transaction policy and acyclic runtime imports. |
| DB-014 repeated validation/configuration vocabulary | Fixed | Keep shared connection/deadline and persisted-digest owners; retain domain-specific schemas locally. |
| DB-015 pool telemetry role/monitor identity | Fixed | Operational aggregate capacity/headroom proof remains part of DB-011/DB-017. |
| DB-016 migration compatibility exceptions | Repository ledger fixed; deployed retirement ongoing | Re-run the M1 checksum and C1 constraint inventory for every supported database before retirement. |
| DB-017 backup/restore/pooler/vacuum/failover proof | **Open, external** | Execute staged restore/failover and deployed pooler/replica/operations drills; see exact plan below. |

This matrix prevents reopening completed fixes as generic refactoring. In
particular, DB-003's former “I/O while locked” concern, DB-004's former
single-transaction runner concern, and DB-008/DB-009's former batching concerns
have implementation evidence and regression suites. Their remaining production
scale questions are evidence obligations, not permission to rewrite tested SQL
or state-machine stages speculatively.

## Family-by-family review

### Package boundary, runtime, configuration, and telemetry

Reviewed the seven role-oriented entrypoints, `database.ts`, `config.ts`,
`platform/database-runtime.ts`, `postgres-pool-policy.ts`,
`postgres-telemetry.ts`, checkout telemetry, readiness probes, and the package
and Vitest configurations. The public API/execution/lifecycle/maintenance/
operator/recovery/testing split is deliberate. `DatabaseRuntime` now gives a
process/role composition root one pool owner; repository leases do not close an
injected pool, and standalone role processes retain explicit ownership. Role
names and monitor identities are bounded and secret-free, and statement, query,
lock, and idle-in-transaction budgets fail closed.

No new local DB-002, DB-007, DB-010, or DB-015 defect was found. Do not reopen
the shared-runtime work merely because a cancellation helper has a short-lived
auxiliary pool or a standalone lifecycle/operator process constructs its own
role pool; those are explicit ownership seams. The remaining acceptance is
operational: prove aggregate connection headroom under the actual deployment
topology as part of DB-011/DB-017.

### Tenant access, identity, and RLS

Reviewed `tenant-access/workspace.ts` and policy, identity/workspace stores and
contracts, OIDC transactions, the foundation schema, role configuration, and
the tenant-context, RLS, identity/workspace, and workspace-creation fixtures.
The workspace transaction engine acquires, scopes, verifies, rolls back,
scrubs, and releases a client fail-closed; the current selected unit gate is
strong and the one residual branch is the documented synchronous invariant.
Real integration fixtures exercise tenant-scoped reads/writes, role grants,
foreign-workspace invisibility, forced RLS, cancellation, and client reuse.

Disposition: retain. There is no safe additional test to add for branch 13.
Any future transaction-engine change must preserve `SET LOCAL`/readback,
rollback and release ordering, and must rerun the focused unit gate plus the
real `rls.integration.test.ts` and `tenant-context-hygiene.integration.test.ts`
cohorts.

### Authoring, publication, compatibility, and readiness

Reviewed authoring contracts/drafts/records/reads/lifecycle/version restore,
publication, trigger reconciliation, compatibility releases, persisted
checkpoints, release maintenance/readiness, and the related schema and
prior-head fixtures. The publication retained-version scan is intentionally
kept: the real-service corruption regression proves that a direct checksum
lookup could ignore a corrupt sibling and weaken fail-closed behavior. Trigger
projection is set based and compatibility identity/fingerprint checks are
bounded.

Disposition: retain. DB-001, DB-008, DB-009, DB-012, and DB-014 are implemented
or continuously checked. `compatibility-release-readiness.ts` has no package
local executable counter because its public adapter is exercised by API/worker
application fixtures; adding a duplicate package suite solely to move V8
counters is not justified. `migrate.ts` is a thin process wrapper; extracting
an artificial `main` export for coverage would create no reliability evidence.

For a future compatibility or migration change, use the real application
readiness fixtures and `database-compatibility` cohort; do not replace them
with private helper calls or malformed branded state.

### Execution, transport, coordinator, node attempts, and previews

Reviewed execution acceptance/state, dispatcher and wakeup scanners, outbox and
inbox, artifacts/upload, run events and run APIs/cancellation/replay, published
workflow reader, coordinator contract/transactions/observations/physical state/
plan/status/commit/settlement/terminal modules, node-attempt claim/dispatch/
heartbeat/completion/outcomes/inputs, preview acceptance/claim/completion/
delivery/reconciliation, and unknown-outcome reconciliation. The SQL and
physical-state paths are covered by disposable real PostgreSQL fixtures, with
row-count/CAS/fence checks, tenant scope, idempotency, and no-receipt proofs.

The dirty integration test at
`packages/database/test/coordinator-run-store-node-attempts.integration.test.ts`
now proves the durable unknown-outcome path end to end: an authentic claimed →
dispatched → `outcome_unknown` attempt is reconciled once, replay is a
duplicate, request evidence-command and checksum mismatches fail with
`UnknownOutcomeReconciliationMismatchError` before a completed receipt, and a
stale terminal attempt fails with `UnknownOutcomeReconciliationStateError`
without completing its receipt. The prior fence-only completion test remains
separate and proves durable fence rejection.

Disposition: retain. Do not re-add the earlier unknown-outcome gap or replace
this fixture with a mocked transaction. For query-scale assurance, DB-005 is
already locally characterized at 1/1,500/10,000 facts by
`coordinator-run-store-observations.integration.test.ts` (16/16); only
production-cardinality evidence remains under DB-011.

### Triggers and schedules

Reviewed webhook/schedule/workflow trigger stores, activation/materialization/
health, schedule database/scanner/recurrence, trigger migrations, and webhook,
schedule, recurrence/DST, prior-head, and projection fixtures. The SQL guards
for signatures, replay, tenant scope, leasing, misfire/DST behavior, and
publication reconciliation are exercised through real migrated databases and
runtime roles. `schedule-recurrence.ts` has many defensive/parser branches but
its public recurrence and DST suite is the correct seam; its aggregate V8
counter is not a reason to fabricate parser internals.

Disposition: retain. If a production query plan later regresses, add a
representative workload artifact under DB-011 rather than reshaping trigger
SQL from small-fixture intuition.

### Lifecycle, retention, purge, and control ledger

Reviewed control-ledger coordinator/read-side/PostgreSQL adapter, workspace
lifecycle commands, retention database capabilities/transaction/support,
retention scheduling/dry-run/enforcement, preview retention, run-artifact
retention, transient retention, workspace purge, and the legal-hold/artifact/
operator/recovery integration cohorts. The supported path is
`createPreviewRetentionCoordinator` in `lifecycle/preview-retention.ts`, which
is consumed by the retention app and worker preview-maintenance runtime. The
current dirty scheduling assertion correctly checks
`capacityLimited === (scannedCount === 25)` under `SKIP LOCKED`; concurrent
callers are not promised a fair split of rows.

Most previously identified transaction/I/O, error-preservation, batching, and
deadline issues are implemented. The retained operation-plus-unlock
`AggregateError` composition case is documented as justified; cancellation,
unlock, client, and permit lifecycle tests cover the meaningful public
contract. The old 547-line lower-level delivery implementation is the only
unowned local capability and is detailed below.

### Operator, recovery, and external side effects

Reviewed operator command contracts/runtime/ledger/replay, recovery exports,
control-ledger reconciliation and inventory/repair, artifact side effects, and
the local MinIO/disposable-service evidence. The command ledger, replay,
fencing, bounded pages, and recovery handoff are repository-tested. The three
AWS exclusions in the full qualification remain valid: dual-service control
ledger append/replay/conflict/repair and immutable conditional creation in the
primary and recovery buckets cannot be proven by MinIO.

Disposition: retain local behavior and keep the AWS exclusions explicit. Do not
claim AWS Object Lock, bucket-policy enforcement, or deployed recovery from
local integration results.

### Schema, migrations, and SQL ownership

Reviewed all 87 numbered migration files, the migration execution plan,
`migrations.ts`, `migrate.ts`, schema modules, `raw-sql-table-registry.json`,
readiness SQL, migration runner/mode tests, prior-head fixtures, RLS tests, and
the real catalog-shape integration. The migrated-catalog check covers all 48
typed tables and 19 registered raw-SQL tables for column/nullability, RLS,
ACL, primary key, and index expectations. The runner now supports declared
transactional, online, and bounded resumable modes with checksums, advisory
locking, progress events, size preflight, and cleanup-failure preservation.

Disposition: DB-004 and DB-012 are locally implemented. DB-016 remains a live
compatibility control: `docs/operations/compatibility-retirement-inventory.md`
records five accepted historical checksums and seven intentionally unvalidated
constraints, with an exact M1/C1 inventory and a next review of 2026-11-30.
Published migration bytes must remain immutable. DB-011 still needs timing on a
representative dataset; the local mode tests do not prove production WAL/lock
impact.

### Tests, fixtures, and quality routing

Reviewed all 179 TypeScript tests, SQL/JSON fixtures, 12 support modules, three
database test configurations, package scripts, and the merged coverage/risk
artifacts. The unit configuration intentionally selects the shared workspace
transaction and policy files; the integration coverage configuration includes
all `src/**/*.ts` and runs the real PostgreSQL integration cohort. Test support
and `src/**/testing.ts` modules are deliberate internal seams, not production
imports.

Disposition: retain the current split. Add tests at public behavior or real
service boundaries only when a decision below authorizes work. Never lower the
unit/integration floors, widen exclusions, duplicate application tests just to
credit a package counter, or manufacture invalid persisted state to hit a V8
branch.

## Resolved local action and remaining external acceptance

### P2 — Preview-cleanup delivery retired (resolved local ownership decision)

Decision: choose option 2 below. The source/testing export was unconsumed and
was removed; persisted migration 0053, preview-retention semantics, and the
supported maintenance consumer were preserved. The negative migration contract
and fresh disposable-database checks satisfy the local acceptance criteria.
No public ownership or stored payload semantics changed, so an ADR was not
required.

Evidence:

- `packages/database/src/lifecycle/preview-cleanup.ts` is 547 lines and has
  only three top-level statement hits in the current combined report: 111/114
  statements, 15 functions, and 87 branch locations remain zero-hit.
- `packages/database/src/lifecycle/testing.ts:65-75` is the only current source
  import/export reference to its public functions and error.
- `packages/database/src/lifecycle/preview-retention.ts` is the supported,
  separately consumed coordinator; it is not an equivalent test-only alias.
- `docs/coverage-audit-implementation.md:161-169` records the same result:
  preview cleanup is blocked because no production consumer owns its delivery
  path.

The implementation compared these two options before changing code:

1. **Wire it.** Assign the production worker/maintenance consumer and document
   the ownership/ADR impact. Preserve the strict outbox payload/checksum and
   workspace checks, inbox receipt idempotency, artifact ownership/fence,
   bounded page/quiescence behavior, retry/reschedule, cancellation, and
   cleanup error precedence. Add a real PostgreSQL plus worker integration
   slice covering valid delivery, malformed/missing/wrong-workspace delivery,
   duplicate and open receipts, artifact completion mismatch, retry successor,
   and no receipt completion on rejected delivery. Prove the consumer is
   reachable from the worker process, not merely exported from testing.
2. **Retire/deprecate it.** First inventory deployed outbox rows/functions and
   compatibility needs; do not delete numbered SQL migrations or persisted
   payload readers based only on the current source graph. Record the decision
   and protected identities, remove only the unowned source/testing export when
   safe, and add a negative contract/search check that no production path
   imports it. Keep the supported preview-retention coordinator and its tests.

Acceptance for either option is an explicit owner, decision record if public
ownership or stored payload semantics change, no ambiguous production export,
package build/typecheck/Knip/format checks, the database integration cohort,
and a fresh source-stable `pnpm quality:local` (or a documented authorized
partial qualification before the full run). Coverage may improve or remain
unchanged; a threshold reduction is not acceptance.

### P2 — Supply DB-011 representative workload evidence (external)

Local proof is sufficient for correctness but not scale: the observations suite
already exercises 1/1,500/10,000 facts and index-available plans, while small
fixtures do not establish deployment behavior. The next authorized workload
run should seed representative and burst populations for outbox claims,
schedule/due wakeups, coordinator facts and event pagination, retention/purge,
and connection impact. Capture `EXPLAIN (ANALYZE, BUFFERS)`, query count,
latency, lock waits, WAL volume, cache behavior, table/index size and usage,
dead tuples, and autovacuum progress, with `pg_stat_statements` where
available. Agree SLO/query-count and lock/WAL budgets before comparing plans;
do not remove an index or partition solely because its count is high.

Acceptance is a source-linked workload artifact for expected and burst
cardinality, with repeatable seed identity, planner/index evidence, threshold
comparison, and owner sign-off. A local disposable database can validate the
generator and query text but cannot close the deployed obligation.

### P2 — Supply DB-017 deployed operations evidence (external)

Run the staged backup/PITR and restore drill, record restore/failover RPO/RTO,
verify encrypted snapshots and WAL retention, validate the pooler mode with
`SET LOCAL`/RLS smoke tests, and capture connection headroom, transaction age,
lock, disk/WAL, autovacuum, and replica-lag/admission dashboards during a
failover exercise. Keep the exact deployment/image/database identity and link
the artifacts from the implementation-progress external-platform checkpoint.

Acceptance is operational evidence, not a repository test count: successful
restore and serve-gate checks, tenant/RLS through the deployed pooler, stated
RPO/RTO against the plan, and alarms for connection exhaustion, old
transactions, vacuum/WAL/disk pressure, and replica admission. Keep DB-017
unchecked until those artifacts exist.

### P3 — Maintain DB-016 and retained/measurement dispositions

Re-run the compatibility-retirement inventory M1 checksum query and C1
constraint-state/violation query against every supported database at the next
review or before any retirement. Validate a `NOT VALID` constraint only after
the documented zero-population and restore/upgrade rehearsal criteria hold.
Never edit a published migration file or remove an accepted checksum merely
because current CI creates a fresh database.

The following are intentionally not follow-up work without a new behavioral
finding:

- the single workspace branch 13 unreachable case;
- the retention operation-plus-unlock aggregate-error case;
- 24 declaration/barrel/type-only source modules with no executable counter;
- compatibility readiness and the CLI wrapper receiving no package-local V8
  credit while application/operational seams cover their behavior; and
- DB-013 cohesive composition roots and contract ownership, which must be
  revisited only when a concrete change demonstrates a smaller, clearer seam
  without state-machine or type-boundary regression.

## Original audit handoff

No repository files were changed by the original audit. The later authorized
implementation retired preview cleanup and regenerated evidence as recorded at
the top of this appendix. DB-011 and DB-017 remain external evidence
obligations, DB-016 remains continuous inventory, and the workspace branch
remains justified—not a new implementation task. No commit or push was created.
