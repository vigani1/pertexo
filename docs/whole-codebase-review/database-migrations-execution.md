# Database migrations 0017–0039

Date: 2026-09-12. Primary reviewer read all 23 SQL files in full. This is a
historical-to-current review, not permission to rewrite published bytes. Runtime
and integration-test source was already reviewed in the associated ledgers.
No database service was started or migration executed in this pass.

## Individual file judgments

| File | Disposition | Specific judgment |
| --- | --- | --- |
| `packages/database/migrations/0017_node_compatibility_releases.sql` | KEEP; schema TEST WQ-206 | Global immutable release authority, serving read-only grants and locked exact catalog comparison are coherent. Embedded catalog is frozen release data, not duplicated application logic. Object CHECK permits missing domain/schemaVersion through SQL NULL; owner-only admission limits exposure, but its claimed backstop deserves an explicit test. |
| `packages/database/migrations/0018_phase3_core_executor_non_removal.sql` | KEEP | Three-row required-identity loop checks exactly one serving instance of each retained core executor. The two filtered counts distinguish duplicates from retirement; replacing them with existence alone weakens the contract. |
| `packages/database/migrations/0019_node_compatibility_preactivation.sql` | KEEP; contract tests | Preparation, cohort evidence, approval and activation are separate durable phases with exact replay comparison and predecessor fencing. Full-row SELECT into typed row variables is deliberate. Owner-only management functions differ from serving lock function. Concurrent identical first commands may conflict before replay; qualify controller retry expectations before changing locking. Scalar JSON may raise rather than return false in artifact-set validation; both deny invalid input, so do not call this an admission bypass. |
| `packages/database/migrations/0020_connections.sql` | KEEP | Deferred same-connection secret FK safely supports atomic initial creation. Rotation keeps immutable secret history; partial live-name uniqueness allows revoked-name reuse. Narrow health/secret-pointer update grants express distinct authority. Do not remove the intentional cycle or replace it with unchecked polymorphism. |
| `packages/database/migrations/0021_workflow_integration_usage.sql` | KEEP | Explicit disposable projection ownership, workspace-composite references and two usage lookup indexes match impact queries. Cascade from immutable workflow version differs correctly from restricted connection deletion. |
| `packages/database/migrations/0022_preview_execution.sql` | KEEP; shared preview findings | One attempt per preview, pinned identity trigger, bounded refs, complete lease and terminal alternatives support isolated preview semantics. Long OLD/NEW row tuples are justified identity protection; later additions must update both. Deadline and terminal facts arrive in later migrations. |
| `packages/database/migrations/0023_preview_artifact_ownership.sql` | KEEP historical guard | Named owner link and owner-expiry check are better than polymorphic cascades. Insert-time retention is not proof against later expiry changes; assess current finalization/retention migrations and store locks before changing this historical trigger. |
| `packages/database/migrations/0024_preview_retention_cleanup.sql` | KEEP superseded | Definer cleanup checks workspace, expiry, dependent previews and external deletion status. Explicit lexical queue-checksum backfill is justified for constrained UUID/trace fields, with NO FORCE/FORCE bracket. Current deletion authority is later replaced/revoked. |
| `packages/database/migrations/0025_preview_cleanup_idempotency.sql` | KEEP superseded | Adds expiry-qualified active-key retirement in the same cleanup transaction. Full function repetition is required migration history, not a refactor candidate. |
| `packages/database/migrations/0026_preview_cleanup_terminal_guard.sql` | KEEP superseded | Correctly moves terminal-state enforcement into privileged deletion boundary instead of trusting adapter checks. Ordered early returns express distinct non-deletable states. |
| `packages/database/migrations/0027_preview_terminal_facts.sql` | KEEP | Two factual backfills preserve tenant correlation and terminal time, with explicit temporary owner RLS handling. Immutable-history grants remain distinct from later retention authority. Anti-join and usage idempotency protect repeated historical facts. |
| `packages/database/migrations/0028_preview_terminal_fact_corrections.sql` | KEEP bytes; FIX WQ-206 | Correlation backfill precedes expanded pin trigger, and NOT VALID UUIDv7 checks retain historical v4 facts. provider/operation pair CHECK can accept a one-sided NULL pair; the comment's consistency promise is stronger than the actual predicate. |
| `packages/database/migrations/0029_provider_idempotency_key_invariants.sql` | KEEP | Boolean equivalence on nonnull class and IS NOT NULL key is concise and total; preserve exactly-one-class ownership rather than rewriting it as nullable comparisons. |
| `packages/database/migrations/0030_coordinator_retry_decisions.sql` | KEEP | Explicit all-empty/all-present failure tuple, enum checks and failed-attempt-only guard separate raw executor outcome from coordinator decision. Four related columns do not justify a new table or JSON blob. |
| `packages/database/migrations/0031_due_node_wakeups.sql` | KEEP bytes; FIX WQ-206 | Bounded locked marking plus outbox insertion is atomic and SKIP LOCKED enables scanner cooperation. due_wakeup_at consistency admits NULL equality when both due timestamps are absent. Owner global policies are deliberate scanner authority, not tenant serving grants. |
| `packages/database/migrations/0032_for_each_barriers.sql` | KEEP superseded | Adds a legitimate timer-free barrier state, rather than inventing a fake resume timestamp. Nullable control-kind comparison requires final-state checking in 0033; preserve barrier semantics. |
| `packages/database/migrations/0033_durable_wait.sql` | KEEP bytes; FIX WQ-206 | Wait backfill is visible through owner policies introduced in 0031, unlike WQ-204's older heads. Wait-state and deadline marker CHECKs have nullable-comparison holes. Deadline scanner emits bounded durable wakeups; do not collapse node retry, timer wait and loop barrier into one flag. |
| `packages/database/migrations/0034_run_failure_notifications.sql` | KEEP historical definition | Explicit delivery states, bounded attempts/context, per-run terminal identity and safe/unsafe recovery are coherent. Policy tuple NULL behavior is followed through 0037; one-argument recovery is intentionally replaced there. |
| `packages/database/migrations/0035_slack_bot_token_connections.sql` | KEEP | Four-line additive auth-type constraint preserves old type; no abstraction needed. |
| `packages/database/migrations/0036_resend_api_key_connections.sql` | KEEP | Adds auth type and bounded immutable dispatch identity. Workspace SHARE then connection SHARE expresses lock ownership; repeated workspace filtering does not justify removing the first lock. |
| `packages/database/migrations/0037_failure_notification_destinations.sql` | KEEP bytes; FIX WQ-206/WQ-207 | Immutable configuration versions, exact run pin, claimed-versus-dispatched distinction and monotonic uncertainty recovery are meaningful domain complexity. Config NULLs and policy partial tuples need total predicates. Three UUID regexes reject application-generated v7 connection IDs. |
| `packages/database/migrations/0038_execution_admission.sql` | KEEP bytes; TEST/FIX WQ-208 | Separate entitlement pin, capacity reservation, observational eligibility, recovery and counters are appropriate. Recovery NULL limit bypass remains in 0067. Counts and lock-time snapshots must be evaluated against forward replacements before performance/concurrency claims; do not replace recounts with counters without proof. |
| `packages/database/migrations/0039_webhook_triggers.sql` | KEEP | Tenant-composite secret references, complete rotation tuple, digest-only endpoint and replay keys, restricted secret projection and immutable secret history are coherent. Resolver captures/restores workspace context; its STABLE declaration does not make clock_timestamp a frozen application timestamp. Version/node identity and schedule constraints are followed through 0040–0041. |

## WQ-206 — make SQL shape predicates total, not merely visually exhaustive

P2 FIX for the database backstops; not a claim that typed HTTP paths currently
emit every malformed row. PostgreSQL accepts a CHECK whose result is NULL.
[PostgreSQL constraint semantics](https://www.postgresql.org/docs/18/ddl-constraints.html#DDL-CONSTRAINTS-CHECK-CONSTRAINTS).

Concrete current definitions found by full historical reads and cross-migration
symbol searches:

- 0028 `preview_runs_integration_identity_consistent`: provider NULL with a
  valid operation, or vice versa, produces NULL rather than false.
- 0031 `node_runs_due_wakeup_consistent`: waiting row, nonnull wake marker,
  both actual due timestamps NULL makes the equality NULL.
- 0033 `node_runs_wait_state_valid`: waiting, NULL control/wait kinds and both
  timestamps NULL can produce NULL. It is not a valid timer wait or a barrier.
  `workflow_runs_deadline_wakeup_consistent` similarly accepts a marker with
  a NULL deadline.
- 0037 `failure_notification_destination_versions_config_strict`: present
  JSON keys with JSON null values satisfy key-existence checks but extracted
  text comparisons produce NULL. Require JSON strings as well as valid values.
  `workflow_runs_failure_notification_policy_complete` allows some partial
  tuples, and `validate_workflow_run_failure_notification_pin` returns early
  when policy version is NULL. A nonnull dangling destination with other pin
  fields NULL is not ruled out by a default MATCH SIMPLE composite FK.
- 0017 `node_compatibility_releases_catalog_object`: missing domain/schema
  members produce NULL. This is owner-only release admission and therefore a
  lower-risk schema test, not a serving-role exploit.

The desired form preserves valid alternatives but closes unknown truth:

```sql
CHECK ((
  (provider_key IS NULL AND operation_key IS NULL)
  OR (
    provider_key IS NOT NULL AND operation_key IS NOT NULL
    AND provider_key ~ '^[a-z][a-z0-9._:-]{0,63}$'
    AND operation_key ~ '^[a-z][a-z0-9._:-]{0,127}$'
  )
) IS TRUE)
```

Implementation order: add real current-head table/role tests for every missing
member, SQL NULL, JSON null, wrong type and valid alternative; query effective
constraints/triggers; inspect existing invalid rows using `predicate IS NOT
TRUE`; then add a forward migration with explicit nonnull arms or outer IS TRUE.
Retain historical bytes and valid legacy terminal facts. Do not fabricate
missing IDs, provider identities, wait kinds or timestamps to repair stored
rows. Choose a documented fail-closed remediation if invalid retained data
exists. Validate new constraints after remediation; preserve serving grants,
RLS and terminal/replay semantics. Re-run node wait/barrier/deadline, preview
acceptance and notification scheduling integration suites. Acceptance includes
checking the exact named constraint rejects the row, not any unrelated FK.

## WQ-207 — align notification connection UUIDs with the persisted-ID contract

P1 FIX, source-evidenced normal creation failure; database execution pending.
0037:50, :55 and the regex in `validate_workflow_run_failure_notification_pin`
use `[1-5]` in the UUID version position. API
`apps/api/src/connections/use-cases.ts:66` generates connection IDs through
`packages/database/src/platform/persisted-id.ts`, which explicitly uses uuid v7.
Destination creation persists the chosen connection ID in config, so a normal
new connection is incompatible with this CHECK; run-pin validation independently
has the same mismatch. 0065 only changes the trigger function to SECURITY
DEFINER; it does not replace its regex.

A read-only Node probe extracted all three actual regex strings from 0037.
Synthetic valid v7 `0199372e-1000-7000-8000-000000000001` was rejected by all
three (`[false,false,false]`). This proves the regex mismatch, not a PostgreSQL
integration run. Historical UUIDv4 fixtures can hide the real application path.

Add an API-create-connection → destination-create → policy-attach → run-admit
integration for Slack and email using production-generated IDs. Include append
version and run replay, a retained valid v4 connection, bad variant/length/text,
wrong workspace/provider/auth type and JSON null. Use real current migration head
and role grants. Add a forward constraint/function replacement accepting the
UUID versions allowed by the public identifier contract, including v7; avoid
weakening UUID validation to arbitrary castable text or changing generated IDs
back to v4. Coordinate the same replacement with WQ-206's JSON type checks.
Assert precise persisted pin and successful intended admission, plus rejection
of every invalid case without partial destination/config writes.

## WQ-208 — make privileged recovery page bounds reject NULL explicitly

P2 FIX at the SQL boundary, with reachable caller consequences to qualify.
0038 `recover_due_workflow_run_active_admissions` uses
`IF p_limit NOT BETWEEN 1 AND 1000`, then `LIMIT p_limit`; its 0067 replacement
retains that guard. NULL does not enter the IF and LIMIT NULL removes the page
bound. The normal TypeScript adapter can validate numeric callers, but direct
dispatcher execution remains granted and the SQL claims its own bound.

Use a forward replacement with
`IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN ... END IF`.
First assert NULL, zero, negative and 1001 fail with 22023 before row locks or
outbox writes. Assert 1 and 1000 operate within their page sizes, with unrelated
workspaces untouched beyond selected candidates and no broadened grants.
Keep recovery's queue-checksum and active-reservation truth unchanged. Include
other privileged page-limit functions only when their final definitions show
the same concrete hole; do not bulk-rewrite all SQL IF statements.
