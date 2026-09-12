# Database migrations 0040–0060

Date: 2026-09-12. All 21 files fully read by the primary reviewer. Current-head
symbol searches distinguish still-effective functions/constraints from historical
versions. SQL not executed. Existing deletion/retention concurrency findings
remain owned by WQ-193–WQ-199; these rows do not duplicate them.

## Individual file judgments

| File | Disposition | Specific judgment |
| --- | --- | --- |
| `packages/database/migrations/0040_schedule_triggers.sql` | KEEP bytes; WQ-206 | Immutable recurrence configuration, one occurrence per trigger/time and exact lease token are coherent. Interval NULL and missing lease expiry slip through CHECKs; final claim concurrency is reviewed at 0081, not judged from this superseded scanner. |
| `packages/database/migrations/0041_trigger_hardening.sql` | KEEP bytes; WQ-204/WQ-208 | Ingress bucket row lock, bounded retry-after, admission backoff and secret-excluding worker projections are justified. Delivery expiry backfill lacks owner-context/FORCE bracket at this head; populated upgrade needs proof. defer_trigger_schedule_claim accepts NULL backoff; initial claim replacement is superseded by 0081. |
| `packages/database/migrations/0042_worker_run_admission_lock.sql` | KEEP bytes; WQ-207 | Small definer read-and-lock seams avoid broad table privileges. Policy connection UUID regex independently excludes v7; fix it with the destination constraint and run-pin regex, not afterward. |
| `packages/database/migrations/0043_workflow_run_input_retention.sql` | KEEP | Explicit both-empty/both-present expiry rule is total and validates retained rows. Owner-global run policies already exist at this head, so do not repeat the earlier historical RLS allegation here. |
| `packages/database/migrations/0044_retention_control_foundation.sql` | KEEP bytes; WQ-206 | Exact hash/sequence/actor/time links, immutable facts, controlled legal-hold release and dry-run-only first phase hide substantial authority safely. Prelaunch nonconcurrent index choice is explicit. Lease CHECK omits explicit nonnull owner/expiry in the present arm; later claim APIs generally validate them. |
| `packages/database/migrations/0045_control_ledger_command_lock.sql` | KEEP | Lock, read exact command and validate domain transition are separate narrow maintenance capabilities. Exposing high-water metadata is intentional; it is not proof of external append exclusion (WQ-193). |
| `packages/database/migrations/0046_workspace_deletion_control_projection.sql` | KEEP | State alternatives and exact replay/chain checks are meaningful complexity. Restore goes to suspended, not automatically active. Purge start versus destructive completion have distinct hold requirements. Custom transition settings are trigger coordination, not independent authorization; table/role grants remain essential. |
| `packages/database/migrations/0047_workspace_lifecycle_command_intents.sql` | KEEP bytes; WQ-206 | Durable actor/idempotency intent, authoritative owner check before replay, leased processing and exact completed projection are appropriate. Completed-result CHECK and lease tuple allow NULL holes; 0048 adds live-lease authority rather than replacing this entire intent model. |
| `packages/database/migrations/0048_workspace_lifecycle_command_hardening.sql` | KEEP bytes; WQ-209 and historical WQ-204 | One captured claim time fixes the earlier maximum-lease timing inconsistency. Durable append authorization enables crash repair without reauthorizing an already-authorized append. Several new definer functions omit NULL lease argument guards; timestamp normalization also conflicts with the prior immutable occurred_at trigger for noncanonical retained intents. |
| `packages/database/migrations/0049_workspace_deletion_side_effects.sql` | KEEP; TEST current trigger interleaving | Side effects belong to authoritative projection and repair, not solely API path. Queued terminalization differs correctly from cooperative running cancellation. require_active_workspace_integration uses KEY SHARE, which does not itself serialize a non-key status update; verify callers' stronger workspace locks before claiming a reachable race. SQL scans all affected workspace runs/integrations in one transaction: measure configured-size behavior before moving to staged cancellation. |
| `packages/database/migrations/0050_workspace_lifecycle_api_authority.sql` | KEEP | Focused column-grant revocation preserves public command acceptance/read while removing direct lifecycle projection. No reason to merge it into unrelated schema cleanup. |
| `packages/database/migrations/0051_workflow_run_input_retention_dry_run.sql` | KEEP | Typed keyset/page-plus-one bounds, durable cursor, empty-page completion and audit totals are clear. OFFSET is only page-size lookahead inside bounded materialized data, not unbounded pagination. |
| `packages/database/migrations/0052_workflow_run_input_retention_enforcement.sql` | KEEP; shared retention gate WQ-193 | Separates dry-run from destructive claims, rejects future destructive cutoff, checks exact projected high water and pauses on holds. Revokes old generic checkpoint authority. External ledger safety still depends on application ownership; SQL cannot verify remote-ledger serialization. |
| `packages/database/migrations/0053_preview_retention_enforcement.sql` | KEEP; shared WQ-193 | Transaction-specific ungranted transition capability is stronger than trusting a custom setting alone. Explicit waiting/artifact/finish phases preserve object acknowledgement and quiescence. Removes obsolete queue jobs and revokes old worker cleanup authority; historical function text remaining present is not a live serving capability. |
| `packages/database/migrations/0054_workflow_run_input_retention_scheduling.sql` | KEEP superseded schedule | Database-time cutoff, once-per-UTC-day identity and workspace/state SKIP LOCKED claim form one coherent scheduler. Schedule-state RLS is added in 0074; no serving grants exist here. |
| `packages/database/migrations/0055_standard_retention_classes.sql` | KEEP bytes; FIX WQ-210 | Explicit dependency stages and one bounded mutation surface per call are justified. Repeated state CASE assignments preserve a single UPDATE. UUID1–5 filter silently excludes v7 artifact references from locking. Initial stage-deletion and artifact-retry definitions must be followed through forward repairs before current claims. |
| `packages/database/migrations/0056_workspace_purge_foundation.sql` | KEEP bytes; WQ-206/WQ-209 | Separates purge intent, lease, authoritative start and destructive steps; completion guard prevents early tombstone. Lease/projection nullable CHECKs and start-projection NULL arguments need boundary hardening. Later step ordering is deliberately absent from this foundation. |
| `packages/database/migrations/0057_workspace_tenant_rows_purge.sql` | KEEP bytes; FIX WQ-211 | Static allowlist plus quoted identifiers and parameterized workspace/page values avoids arbitrary dynamic SQL. One-surface bounded deletion and statement-local ctid are appropriate. Current-attempt pointer clearing and preview deletion order conflict with current constraints. This body is not replaced by 0067; inspect final grants and all FKs in the required regression. |
| `packages/database/migrations/0058_workspace_object_versions_purge.sql` | KEEP bytes; WQ-209 | Resets old tenant leases, requires object_versions before tenant_rows and only accepts zero-deletion completion after an empty inventory page. Physical deletion remains external. Replacement start-projection retains NULL-fence hole; checkpoint function explicitly rejects NULL and should retain that guard. |
| `packages/database/migrations/0059_workspace_purge_completion.sql` | KEEP bytes; WQ-206 | Repairable command identity and exact high-water/step/hold checks precede minimized tombstone. Completion projection explicitly uses IS DISTINCT FROM for lease identity, a good pattern for WQ-209. Lease CHECK still permits missing expiry/owner in some present tuples. |
| `packages/database/migrations/0060_standard_retention_dry_run.sql` | KEEP; scoped readability improvement | Closed kind/stage branches select trusted SQL fragments; values remain bound. Typed upper/cursor tuples prevent endless scans from new rows. Different eligibility from raw examined count is deliberate. A future replacement may use named multiline SQL templates for repeated timestamp/UUID key clauses, but must preserve per-stage eligibility, exact ordering, SQL casts and the non-granted helper boundary; no generic arbitrary-table query builder. |

## WQ-209 — reject NULL lease credentials before privileged lifecycle mutation

P1 FIX in the privileged SQL boundary; no HTTP exploit or service reproduction
claimed. In 0048 the functions `lock_workspace_lifecycle_operation`,
`authorize_workspace_lifecycle_append`, `read_workspace_lifecycle_control_command`
and `project_and_complete_workspace_lifecycle_operation` load by operation ID,
then test `stored.lease_token <> p_lease_token` and
`stored.lease_fence <> p_lease_fence` without first rejecting NULL arguments.
With a running unexpired operation and otherwise valid state, NULL token/fence
make that disjunction unknown and PL/pgSQL does not enter the rejection arm.
The lock/read/authorization routines can therefore accept absent lease identity.
The final projection routine later calls a completion function with stricter
argument checks, so do not claim its whole transaction successfully commits
with NULL credentials; the earlier routines are independently granted.

0056 `project_workspace_purge_started` and its effective 0058 replacement have
the same absent-credential path and no equivalent final credential guard. They
are maintenance-only, still required to enforce the lease the interface claims.
Existing TypeScript validation lowers normal-call reachability but is not a
substitute for a correctly fenced SECURITY DEFINER capability.

Use explicit input rejection before locks plus total comparison after lookup:

```sql
IF p_operation_id IS NULL OR p_lease_token IS NULL
   OR p_lease_fence IS NULL OR p_lease_fence < 1 THEN
  RAISE EXCEPTION 'invalid lifecycle lease' USING ERRCODE = '22023';
END IF;
-- After locking and checking FOUND/status:
IF v_operation.lease_token IS DISTINCT FROM p_lease_token
   OR v_operation.lease_fence IS DISTINCT FROM p_lease_fence
   OR v_operation.lease_expires_at IS NULL
   OR v_operation.lease_expires_at <= clock_timestamp() THEN
  RAISE EXCEPTION 'workspace lifecycle lease is stale' USING ERRCODE = '55000';
END IF;
```

Regression matrix: live operation with both NULL, each individually NULL,
wrong token, old fence, zero fence, expired lease, completed status and valid
current pair, executed as actual lifecycle/maintenance roles. Invalid inputs
must not return protected command metadata, set append_authorized_at, advance
control sequence, change status or create purge steps. Valid crash repair of
already-authorized append must remain possible. Use forward replacements,
preserve grants/row locks and bounded input validation; coordinate table-shape
tests with WQ-206. Do not rename states or create new ADRs for this routine fix.

## WQ-210 — include UUIDv7 in execution-artifact reference locking

P1 FIX of a concurrency backstop; destructive interleaving still needs a real
database test. 0055 `lock_execution_artifact_references` selects recursive
artifact refs only if artifactId matches UUID versions `[1-5]`. Worker runtime
`apps/worker/src/execution/node-runtime-capabilities.ts:461` defaults artifact
ID generation to `generatePersistedId` (UUIDv7). Thus normal v7 references are
silently absent from the loop: no availability check and no SHARE lock. This
differs from WQ-207's rejection: here the guard is skipped. No later migration
replaces this function. Existing application reference locks must be retained;
this finding does not assume every path lacks them.

Add real-role insert/update tests for each attached surface (workflow input/
output, event payload, checkpoint, node input/output, attempt output/
reconciliation) with nested available, missing, deleting and wrong-workspace
v7 references plus retained v4 cases. Add observed two-client contention proving
insertion obtains the artifact lock and cannot race past destructive retention.
Use the current reference kind/schema policy, including non-reference payload
objects, to avoid treating arbitrary user artifactId strings as authority.
Forward-replace the filter with the public UUID contract including v7; preserve
distinct ID deduplication and tenant/availability checks. Consider deterministic
UUID lock ordering for multi-reference rows only with a deadlock regression
showing overlapping reversed reference lists. Acceptance requires no orphaned
accepted reference and no false guard on ordinary JSON. Coordinate with WQ-193
external deletion ownership and existing coordinator artifact-lock findings.

## Additions to shared migration findings

WQ-204 historical upgrade matrix also needs:

- 0041 applied over a 0040 database with webhook deliveries in two workspaces.
  The owner has only context-scoped delivery policy then; UPDATE can miss rows,
  and subsequent SET NOT NULL cannot be repaired by a later appended migration.
- 0048 over pending/running operations with microsecond occurred_at values.
  Its UPDATE truncates identity time while the 0047 immutability trigger rejects
  any occurred_at change even when the transition setting is on. Confirm exact
  populated-head behavior before deciding support/remediation. Millisecond-only
  fixtures or empty bootstrap cannot prove the upgrade path.

WQ-206's explicit-null table matrix additionally covers 0040 interval recurrence
and lease expiry; 0044 retention_batches owner/expiry tuple; 0047 lifecycle
lease and completed sequence/hash; 0056 purge job/step lease and projected hash;
0059 purge completion lease. Classify owner-only malformed-row tests separately
from runtime-granted write paths; do not imply arbitrary users can mutate them.

WQ-207 also replaces the connection-ID regex in 0042
`lock_workflow_failure_notification_policy`; otherwise a valid v7 destination
can still produce a NULL connection ID during admission after the other repair.
The original 0037 constraint regex locations are :50 and :55; its trigger
regex is :225. Treat source symbols as primary anchors if later edits shift lines.

WQ-208 also tests 0041 `defer_trigger_schedule_claim(..., NULL)`:
NULL bypasses its range check and clears the lease without an effective bounded
backoff. Reject NULL before any UPDATE and preserve valid 1–300 second backoffs.
Do not carry the superseded schedule-claim guard forward without reading 0081.
