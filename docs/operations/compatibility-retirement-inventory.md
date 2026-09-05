# Compatibility-retirement inventory

- Last reviewed: 2026-08-30
- Next required review: 2026-11-30
- Policy owner: platform runtime owner
- Decision authority: ADR 010

This is the live inventory for persisted or externally visible identities that
ordinary dead-code analysis must not remove. `Open-ended` means the identity is
accepted by the current release and has no approved last-supported release.
An entry may move to `removal approved` only after its production evidence,
removal test, and rollback artifact are attached to the same change.

| Retained path | Protected identity | First / last supported release | Required cohorts | Repository proof | Production evidence before removal | Exact removal test | Rollback plan | Owner / review |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Authoring graph reader | Workflow graph `schemaVersion: 1` and canonical checksum | Initial authoring release / open-ended | API writers and readers; worker compilation readers | `packages/workflow-model/test/retained-workflow-v1.test.ts`; `packages/workflow-model/test/fixtures/retained-workflow-v1.json`; workflow graph contract tests | Zero retained draft or published graph rows whose schema is 1, plus a full-retention-window replay report | Delete the retained V1 fixture and parser branch in one change; the prior fixture must fail with the documented unsupported-version error | Redeploy the last artifact containing the V1 reader; do not rewrite retained rows during rollback | Workflow model owner / 2026-11-30 |
| Executable envelope reader | Executable `schemaVersion: 2`, source graph version 1, runtime-policy version 1, checksum algorithm, and pinned executor identities | Compatibility epoch 1 / open-ended | API publish/readiness and every worker cohort | `packages/workflow-engine/test/executable-workflow-*.test.ts`; `packages/workflow-engine/test/executable-workflow.fixtures.ts`; database compatibility-release tests | Durable dependency query at the blocking epoch returns zero active versions, nonterminal/replayable runs, attempts, checkpoints, and unpublished outbox rows for the identity | Remove one exact parser/executor identity and its immutable fixture; readiness of an old release must fail and the subtractive release must pass | Redeploy the retained additive worker/API release named in the retirement record | Workflow engine owner / 2026-11-30 |
| Checkpoint V1 reader | Workflow checkpoint `schemaVersion: 1` | Initial execution release / open-ended | All worker cohorts; API run-event/cancellation readers that encounter retained runs | `packages/workflow-engine/test/checkpoint-seam.test.ts`; V1 branches in checkpoint/transition tests | Zero nonterminal or replay-eligible runs and zero retained checkpoints with schema 1 for the full retention window | Remove `parseCheckpointV1Boundary` and `WorkflowCheckpointV1`; the pinned V1 checkpoint fixture must produce the unsupported-version error | Redeploy the last worker/API artifact with the V1 reader; restore no data and rewrite no checkpoint in place | Workflow engine owner / 2026-11-30 |
| Checkpoint V2 reader | Workflow checkpoint `schemaVersion: 2`, including branch selections and structured-control state | Structured-control release / open-ended | Condition through schedule API/worker cohorts | Workflow-engine branching, parallel, For Each, wait, persistence, and recovery suites | Same blocking-epoch dependency query, grouped by checkpoint schema and engine version, reports zero rows | Remove only through a successor-checkpoint migration change with old/new fixtures, mixed-fleet readiness, and recovery tests | Roll back to the additive dual-reader artifact while predecessor rows remain untouched | Workflow engine owner / 2026-11-30 |
| Node/executor release history | Immutable compatibility epochs 1–24 and each epoch's definition, executor, policy, and fingerprint identities | Epoch 1 / epoch 24 is current maximum; all retained epochs remain executable through their cohort maximum | `core` and every staged/activation cohort declared by `PLATFORM_RELEASE_COHORTS` | Node-catalog registry/release tests; workflow executable identity fixtures; database `compatibility-release` unit/integration suites | ADR 010 blocking epoch, audited zero-dependency result, fleet preactivation readiness, no replay/trigger references, and retained rollback image digest | Remove one history entry/executor only after a subtractive-release test proves old publication/run/replay/trigger admission fails closed and all remaining fixtures execute | Redeploy the named additive release containing both identities; never force a fingerprint or mutate an epoch | Node catalog owner / 2026-11-30 |
| Queue and outbox payload readers | Identifier-only job payload `schemaVersion: 1`, outbox event names, and deterministic job IDs | Initial transport release / open-ended | Current and previous API/worker transport cohorts during rollout | Queue contract tests; database transport/outbox integration suites; production coordinator redelivery and recovery suites | Queue inspection plus authoritative unpublished-outbox query report zero predecessor payloads across the maximum queue retention and redelivery window | Remove the predecessor parser branch; its pinned payload fixture must fail deterministically while current duplicate/redelivery tests remain green | Redeploy the dual-reader worker; leave PostgreSQL outbox rows authoritative and rebuild Redis transport | Queue/transport owner / 2026-11-30 |
| Retired legacy execution-runtime surface | Removed broad transaction functions formerly published by `packages/database/src/execution-runtime.ts`; durable event reads and cancellation moved to behavior-owned modules without changing stored formats | Initial execution release / removed 2026-08-30 | No runtime cohort consumes the retired surface; retained rows remain handled by the production coordinator and node-attempt stores | Coordinator CAS, scheduling, observations, retry/wait, parallel recovery, For Each cancellation, HTTP node-attempt, run-event, API SSE, and package-contract suites | Current production stores already own all supported retained checkpoint, attempt, event, outbox, and cancellation identities; removal changes no schema or stored identity | Repository search has no legacy module or export; package-contract test rejects former broad exports; production crash/outage and retained-data suites run against successor stores | Redeploy commit `993f849` or another recorded pre-removal image only if an undiscovered source consumer exists; retained rows require no rewrite | Database execution owner / retired; re-audit 2026-11-30 |
| Database rolling head | Published migrations through `0075_workspace_purge_step_release.sql`, prior-head upgrade behavior, and role/function signatures | Migration 0000 / open-ended; current head 0074 | Migration, API, worker, maintenance, operator, dispatcher, and lifecycle roles | Migration-head unit tests; prior-head and compatibility-rollout integration suites; readiness signature checks | Successful mixed-version rollout and rollback rehearsal from the immediately prior production head, with backup/PITR evidence | Apply every published migration to a disposable prior-head database; old/new readiness probes and compatibility cohorts must match their declared support | Restore from the rehearsed backup or redeploy the compatible predecessor artifact; published migration files are never edited or removed | Database migration owner / each migration change |

## Release-cohort coverage

The node-catalog cohort list is authoritative and currently contains `core`
plus staged and activation cohorts for HTTP, Condition, Switch, Parallel,
Merge, For Each, Wait, Slack, Email, webhook, and schedule releases. Each cohort
must retain every executable registry epoch up to its declared maximum. Adding a
cohort or compatibility path requires adding or updating an inventory row in
the same change.

## Retirement evidence record

A retirement pull request must record:

1. the durable blocking epoch and fingerprint;
2. the audited dependency-query timestamp and zero-result artifact;
3. API and worker preactivation readiness for the subtractive release;
4. the production traffic and retention window examined;
5. the immutable rollback artifact/image identity;
6. the exact fixture removed and the expected unsupported-version failure; and
7. approval by the row's owner.

Absence from current source call graphs, queue emptiness, deployment age, and
low traffic are not retirement evidence.

## Database migration compatibility exceptions

Published migration bytes are immutable. The hashes below identify the exact
historical bytes retained in Git, and the current runner accepts no other
non-current value. A release inventory must run query M1 against every supported
database before any row can be retired.

| Migration | Accepted historical SHA-256 | Affected population | Forward repair / new-database invariant | Owner | Retirement criterion |
| --- | --- | --- | --- | --- | --- |
| `0037_failure_notification_destinations.sql` | `9f76e5fefc3914a808cb000f796760e17902876a4418d006bb82674d7778eede` | Databases that applied the first published 0037 bytes (Git commit `0cef4f6b9fb234d60042f2289fc5c92ba4565153`) | Migration 0067 installs the destination dispatch lock and corrected owner-inclusive RLS policies. New databases receive the current 0037 bytes and still converge through 0067. | Database migration owner | M1 reports zero supported databases with this value and a prior-release restore/upgrade rehearsal rejects its removal nowhere. |
| `0038_execution_admission.sql` | `89117c0311337b655503557f7a66f63c04aa9eb6736be6ddfc4b02dea4eedf95` | Databases that applied the first published 0038 bytes (Git commit `37b218154ceef2766a268419f6f96028035771a3`) | Migration 0067 creates or repairs active-admission reservation state, functions, grants, RLS, and the bigint recovery counter. | Database migration owner | M1 reports zero supported databases with this value and the 0038-to-head restore/upgrade rehearsal passes without accepting it. |
| `0038_execution_admission.sql` | `0b7c70eee52daefeacbd092e1831852aa4260b60b899832b565ec524e47b2be2` | Databases that applied the second published 0038 variant (Git commit `9110363c89ba9b8b01096d1d763e0026baf5f148`) | Same forward-only 0067 convergence; current inserts are protected by the repaired entitlement/admission functions and constraints. | Database migration owner | Same as the preceding 0038 row, demonstrated for this exact hash. |
| `0038_execution_admission.sql` | `27ca68dc5e20560d80fbaab2524b3cd0c9fe0361b68792538a69aac30d4f9857` | Databases that applied the third published 0038 variant (Git commit `ae609d228965023116b97592869cb3798818fb4b`) | Same forward-only 0067 convergence; current databases receive the final 0038 bytes and 0067 remains idempotent. | Database migration owner | Same as the preceding 0038 row, demonstrated for this exact hash. |
| `0070_preview_execution_deadline.sql` | `beabac6354d519a98878e57645d74c8afa8c46454bf13fc3886835774da0c914` | Databases that successfully applied the first 0070 bytes (Git commit `3a96742a9706ccad78db1ef5bf1640a13ba08316`). Because forced RLS hid retained rows from its backfill, successful databases in this cohort necessarily had no retained preview rows requiring repair. | The accepted schema is identical for that cohort. Current 0070 temporarily disables and restores forced RLS so populated upgrades backfill every row; the populated prior-head integration test protects this path. | Database migration owner | M1 reports zero supported databases with this value and populated and empty prior-head restore/upgrade rehearsals pass after removing acceptance. |

M1 — deployed checksum inventory (run once per database and retain the result
with database identity, application release, and observation time):

```sql
SELECT name, checksum
FROM pertexo_internal.schema_migrations
WHERE (name = '0037_failure_notification_destinations.sql'
       AND checksum = '9f76e5fefc3914a808cb000f796760e17902876a4418d006bb82674d7778eede')
   OR (name = '0038_execution_admission.sql'
       AND checksum IN (
         '89117c0311337b655503557f7a66f63c04aa9eb6736be6ddfc4b02dea4eedf95',
         '0b7c70eee52daefeacbd092e1831852aa4260b60b899832b565ec524e47b2be2',
         '27ca68dc5e20560d80fbaab2524b3cd0c9fe0361b68792538a69aac30d4f9857'
       ))
   OR (name = '0070_preview_execution_deadline.sql'
       AND checksum = 'beabac6354d519a98878e57645d74c8afa8c46454bf13fc3886835774da0c914')
ORDER BY name, checksum;
```

## Unvalidated database constraints

`NOT VALID` preserves historical rows but PostgreSQL enforces each constraint
for every insert and update after creation. These seven states are deliberate;
`workflow_runs_input_ref_expiry_valid` is not listed because migration 0043
validates it immediately.

| Table / constraint | Historical population and detection | Forward invariant | Owner | Permanent-exception / validation criterion |
| --- | --- | --- | --- | --- |
| `audit_events.audit_events_preview_terminal_uuid_v7` | Audit facts predating migration 0028 may use non-v7 identifiers; C1 detects violating retained rows. | New `preview.execution_terminal` facts must use UUIDv7. | Preview execution owner | Retain while immutable audit history is retained; validate only after C1 is zero for a full audit-retention window or formally keep permanent. |
| `usage_events.usage_events_preview_uuid_v7` | Usage facts predating migration 0028 may use non-v7 identifiers; C1 detects violations. | New `preview_execution` facts must use UUIDv7. | Usage/billing owner | Retain while immutable billing history is retained; validate only after C1 is zero for the complete billing-retention window or formally keep permanent. |
| `workflow_runs.workflow_runs_failure_notification_destination_version_fk` | Runs created before migration 0037 may lack a resolvable destination-version pin; C1 detects violations. | Every new non-null run pin references its workspace-scoped immutable destination version. | Failure-notification owner | Validate after C1 is zero on every supported database and rollback/retained-run tests pass. |
| `run_failure_notification_intents.run_failure_notification_intents_destination_version_fk` | Historical intents created before migration 0037 may lack a destination-version row; C1 detects violations. | Every new intent references its immutable destination version. | Failure-notification owner | Validate after C1 is zero beyond the intent retention/redelivery window on every supported database. |
| `run_failure_notification_intents.run_failure_notification_intents_run_pin_fk` | Historical intents may not match the full immutable run pin introduced by 0037; C1 detects violations. | Every new intent is bound to the exact run policy/destination/secret pin. | Failure-notification owner | Validate together with the other 0037 notification constraints after C1 is zero and delivery recovery is rehearsed. |
| `workflow_runs.workflow_runs_execution_entitlement_fk` | Runs predating migration 0038 were backfilled to entitlement version 1; C1 detects any row whose version cannot be resolved. | Every new run references the immutable workspace entitlement version used for admission. | Execution-admission owner | Validate after C1 is zero on every supported database and retained-run replay plus rollback rehearsals pass. |
| `workflow_runs.workflow_runs_replay_lineage_valid` | Runs predating migration 0065 may not satisfy the replay/source-command equivalence; C1 detects violations. | New replay runs have both source and command; non-replay runs have neither. | Operator/replay owner | Validate after C1 is zero beyond retained replay eligibility and prior-release replay/rollback rehearsals pass. |

C1 — constraint-state and violation inventory. Run the first query on every
supported database. For each returned row, execute
`ALTER TABLE app.<table> VALIDATE CONSTRAINT <constraint>` inside a disposable
restore: success proves zero violations without mutating production; failure is
the retained evidence that the exception remains necessary.

```sql
SELECT ns.nspname AS schema_name,
       relation.relname AS table_name,
       constraint_record.conname AS constraint_name,
       constraint_record.convalidated,
       pg_get_constraintdef(constraint_record.oid) AS definition
FROM pg_constraint constraint_record
JOIN pg_class relation ON relation.oid = constraint_record.conrelid
JOIN pg_namespace ns ON ns.oid = relation.relnamespace
WHERE ns.nspname = 'app'
  AND constraint_record.conname IN (
    'audit_events_preview_terminal_uuid_v7',
    'usage_events_preview_uuid_v7',
    'workflow_runs_failure_notification_destination_version_fk',
    'run_failure_notification_intents_destination_version_fk',
    'run_failure_notification_intents_run_pin_fk',
    'workflow_runs_execution_entitlement_fk',
    'workflow_runs_replay_lineage_valid'
  )
ORDER BY table_name, constraint_name;
```

The readiness probe pins the exact definitions and validation states for the
two UUIDv7 exceptions and verifies the remaining schema contract. Any proposal
to validate or permanently retain an exception must update this ledger, the
readiness contract where applicable, and the compatibility test evidence in
the same change.
