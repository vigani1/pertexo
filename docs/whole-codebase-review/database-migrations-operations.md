# Database migrations 0061–0081

Date: 2026-09-12. All 21 SQL files fully read by the primary reviewer. Current
function definitions checked across migration files; no service-backed SQL run.
0067 converges compatibility variants of 0037/0038 only: it is not a general
repair of earlier retention or purge code.

## Individual file judgments

| File | Disposition | Specific judgment |
| --- | --- | --- |
| `packages/database/migrations/0061_operator_outbox_redispatch.sql` | KEEP | Command-key advisory serialization, exact material fingerprint, audit on replay/conflict and terminal outbox reset form a coherent narrow authority. Dry run records evidence but does not redispatch. Later result schema supersedes initial status projection; do not merge unrelated operator behaviors into this public wrapper. |
| `packages/database/migrations/0062_operator_command_ledger.sql` | KEEP | Backfills bounded result object and keeps older redispatch insertion compatible through a trigger. Workspace status access derives from retained audit association, deliberately not payload storage in global command row. Test/document status visibility after audit expiration/minimization; missing audit cannot prove missing historical command. |
| `packages/database/migrations/0063_operator_execution_recovery.sql` | KEEP bytes; scoped readability TEST | Public wrappers fix command kind while owner-only dispatcher carries common replay/audit/transaction semantics. Four long command branches could become private command-specific routines in a future replacement, but preserve shared advisory lock and atomic audit. Reclaim state is corrected in 0086; no current ready-state defect claim before that read. Validate NULL action/evidence at public wrappers, not just TypeScript; absence of SQL guard need not imply commit if downstream constraints reject. |
| `packages/database/migrations/0064_operator_trigger_reconciliation.sql` | KEEP | Requeues ordinary workflow trigger reconciliation under pinned published version, rather than directly mutating trigger state. Exact replay, dry run and safe result projection are clear; worker still owns convergence. |
| `packages/database/migrations/0065_operator_run_replay.sql` | KEEP bytes; WQ-206 | Durable replay request, source/version locks and worker completion separate operator intent from admission. Composite lineage and exact result-run match are appropriate. operator_commands completed/failed CHECK accepts NULL completed_at; non-replay lineage pairing also needs explicit contract tests, because equivalence to both-present does not reject just one stray lineage field. |
| `packages/database/migrations/0066_operator_maintenance_rerun.sql` | KEEP; WQ-206 | Maintenance consumes request under row lock and reports accepted/held/lease-active without overriding fencing or hold policy. This is request acknowledgement, not completion of erasure. Completed-outcome CHECK permits NULL via regex; malformed target type should be rejected explicitly before durable side effects. |
| `packages/database/migrations/0067_reconcile_published_migration_repairs.sql` | KEEP bytes; WQ-208 | Explicit replacement of known published variants is warranted despite duplicated bodies. DROP IF EXISTS old signature, consistent role policies and same admission surface provide convergence. Recovery NULL limit survives. Capacity read subqueries inside a lock-acquisition statement require a real contention test before a lock-time snapshot safety claim; later trigger recount is a separate final admission backstop. |
| `packages/database/migrations/0068_restore_artifact_inventory.sql` | KEEP bytes; WQ-208 | Narrow committed-artifact projection and paired typed keyset cursor support restore verification without table grants. Missing p_limit IS NULL allows unbounded LIMIT NULL through maintenance function. |
| `packages/database/migrations/0069_regional_write_admission.sql` | KEEP; TEST freshness contract | Fail-closed enforced bootstrap, explicit expected replica identity and narrow lag-record/assert functions are appropriate. assert uses transaction now(), not clock_timestamp(): verify intended transaction-boundary observation and configured maximum transaction age before claiming a freshness bypass. 0072 supersedes lag recorder, not assertion. |
| `packages/database/migrations/0070_preview_execution_deadline.sql` | KEEP | Full-owner backfill precedes expanded immutable identity trigger, caps deadline by existing retention expiry and restores FORCE RLS. Execution time versus visibility retention is explicit and should stay separate. |
| `packages/database/migrations/0071_oidc_browser_binding.sql` | KEEP | Invalidates old unbound authorization transactions; cannot safely manufacture the absent raw browser secret. Fixed impossible-to-use digest plus consumed_at preserves bounded retained metadata. |
| `packages/database/migrations/0072_regional_replica_identity.sql` | KEEP | Clears old open observation at rollout, validates count/negative lag and distinguishes missing/duplicate/unique replica. Identity mismatch rejects before state update; local unenforced mode stays explicitly open. |
| `packages/database/migrations/0073_transient_data_retention.sql` | KEEP bytes; WQ-208 | Owner policies make intended backfills visible; sessions, idempotency and creation records have separate pages and terminal eligibility. The current reaper lacks a NULL bound: 0082 replaces legal-hold projection, not this function. Transient credential expiry is not automatically equivalent to destruction of held execution evidence; preserve the existing retention-class contract. |
| `packages/database/migrations/0074_retention_schedule_state_rls.sql` | KEEP | Owner-only schedule metadata now has ENABLE/FORCE and owner policy without widening maintenance table access. Small focused hardening is justified. |
| `packages/database/migrations/0075_workspace_purge_step_release.sql` | KEEP | Explicit nonnull positive lease credentials and live-token/fence update prevent old workers releasing current step. Returns exact one-row success; no arbitrary step-name input. |
| `packages/database/migrations/0076_replay_lineage_retention.sql` | KEEP; current standard-retention review | Keeps summary dry-run and deletion eligibility synchronized with leaf-first replay protection. Repeated complete function definitions are migration history, not duplication to remove. Stage fallback remains implicit and long trusted SQL fragments are hard to compare; future replacement should explicitly validate kind/stage pairs and use readable per-stage clauses while preserving limits and zero-row advancement. Does not alter workspace tenant purge. |
| `packages/database/migrations/0077_replay_read_locks.sql` | KEEP | Exact workspace context, explicit projection and owner SHARE locks solve the serving-role lock privilege seam without arbitrary UPDATE grants. Keep source lifecycle read and executable-version lock distinct. |
| `packages/database/migrations/0078_workflow_lifecycle_revision.sql` | KEEP | Aggregate-owned positive lifecycle revision and one-column update grant keep draft/publication/activation revisions separate; no additional abstraction needed. |
| `packages/database/migrations/0079_artifact_upload_capacity.sql` | KEEP | Authoritative capacity lock and underflow checks preserve insert/release accounting; deleted artifacts cannot revive. Immutable metadata tuple and last-charged-artifact purge cleanup are justified. No FK on capacity workspace is not automatically a defect: existing read/write/purge lifecycle is deliberate and must be tested before adding one. |
| `packages/database/migrations/0080_expired_artifact_upload_retention.sql` | KEEP; shared WQ-193/WQ-210 | Retains deleting status and capacity charge across external failure, adds expired public pending uploads, and bounds retry scheduling. Repeated reference checks describe distinct persisted surfaces. Existing SQL artifact-link RLS/read ownership and v7 reference-lock backstop need the shared regression matrix; do not infer physical removal from metadata status. |
| `packages/database/migrations/0081_schedule_claim_concurrency.sql` | KEEP bytes; WQ-208 | Repeats eligibility on locked tuple intentionally to avoid stale ranked-snapshot claims; removing duplicate predicates is unsafe. Still lacks NULL checks for p_limit and p_lease_seconds. NULL page removes bound; NULL duration combines with 0040 nullable lease CHECK and can create a token without expiry. |

## WQ-211 — make workspace tenant purge obey its own pointer/FK contracts

P1 FIX, source-evidenced blocked purge cases; full PostgreSQL execution pending.
Current `execute_workspace_tenant_rows_page` remains the 0057 definition.
No later migration replaces it (0076 replaces standard retention only).

1. Its first mutation clears `current_attempt_id` but leaves
   `current_attempt_number`. 0007 `node_runs_attempt_pointer_complete` requires
   both absent or both present with positive number. A normal node with a
   current attempt therefore fails its CHECK before deletion can progress.
   Clear the pair in the same bounded UPDATE; the standard-retention page
   already expresses the intended paired update.
2. The leaf-preview deletion phase runs before the table list that removes
   preview_attempts and artifact_links. 0022/0023 give those child rows
   nondeferrable RESTRICT FKs to previews. `SET CONSTRAINTS ALL DEFERRED` does
   not defer these constraints. Every ordinary retained preview has an attempt,
   so leaf-first handling of only the preview self-reference is insufficient.
   Remove dependent rows first while preserving object-erasure acknowledgement;
   then delete preview leaves across bounded calls.
3. Parent/current-version CTE units claim deferred-FK safety, but workflow
   published-version and version→workflow FKs in 0012 use RESTRICT without
   DEFERRABLE. Verify each unit against its actual FK graph, including
   connection/current secret and destination/current config. Do not assume the
   connection's deferred pointer makes every similar-looking relation deferred.
4. The static table order also predates operator_unknown_outcome_evidence,
   operator_run_replay_requests and operator_maintenance_rerun_requests. Some
   cascade, others have no target FK. Seed all three before claiming final
   residual checks prove complete tenant purge. Run replay-source chains through
   leaf-first deletion or an explicitly authorized pointer-release strategy.

Required implementation starts with current-head fixtures created through normal
API/worker persistence: current node attempt pair, terminal preview with attempt
and artifact link, published workflow with historical versions, rotated connection,
versioned destination, replay lineage and pending/completed operator requests.
Finish object stage using the controlled fixture, then execute tenant pages as
the real maintenance role with exact token/fence/high water. Assert bounded
progress, no FK/check violation, exact final residue and retained minimized
facts; put unrelated workspace rows in every table. Existing foundation test
uses sparse data and cannot establish all these dependency paths.

Forward-replace the purge function with explicit ordered phases; keep the
allowlist and fail-closed residual inventory. Prefer clearing mutable pointers
and deleting children before parents over weakening all FKs or disabling
triggers/RLS. A genuinely required deferred relationship must be narrowly
designed and tested in the same coherent migration, with serving behavior
unchanged. Preserve live lease, legal hold, external ledger high water,
object-before-tenant ordering, per-page bounds and exact tombstone completion.
Coordinate with WQ-193 and WQ-209, not a standalone cosmetic SQL rewrite.

## Shared finding additions and specific acceptance

WQ-206 adds 0065 operator_commands completion time and 0066 completed rerun
outcome to the owner-only malformed-row matrix. Do not mistake
`(trigger_type='replay') = (source IS NOT NULL AND command IS NOT NULL)` for a
both-or-neither lineage constraint; add a separate pair rule only after verifying
the intended legacy/non-replay contract and existing rows.

WQ-208 adds current 0073 reap_transient_data NULL limit, 0068 artifact inventory NULL limit and final 0081 schedule claim
NULL limit/duration. Direct-role tests must check NULL, minimum, maximum and
one-past bounds independently. Schedule NULL duration must produce 22023 and
leave token/acquired/expiry unchanged, not merely fail later during adapter
row parsing. Keep 0081's duplicated lock-time eligibility predicates exactly.

For admission in 0067, distinguish observational eligibility from reservation
mutation and final run-state admission. A two-client test should hold the
workspace counter lock, commit a competing reservation, then observe the waiting
reservation's count and final run-state outcome. Only a reproduced excess
reservation justifies splitting count acquisition into a subsequent statement;
do not allege execution over-admission when the final trigger prevents it.

For SQL readability, future behavior-bearing replacements of 0063/0076 should
make invalid action/stage fallthrough explicit and keep each command/stage's
selection and mutation together. Before/after acceptance must compare durable
rows, event/checksum bytes, result discriminators and all role grants. Never
reformat published migrations just to align spacing or reduce condition counts.
