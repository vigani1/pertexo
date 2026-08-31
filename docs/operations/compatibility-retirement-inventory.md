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
| Database rolling head | Published migrations through `0073_transient_data_retention.sql`, prior-head upgrade behavior, and role/function signatures | Migration 0000 / open-ended; current head 0073 | Migration, API, worker, maintenance, operator, dispatcher, and lifecycle roles | Migration-head unit tests; prior-head and compatibility-rollout integration suites; readiness signature checks | Successful mixed-version rollout and rollback rehearsal from the immediately prior production head, with backup/PITR evidence | Apply every published migration to a disposable prior-head database; old/new readiness probes and compatibility cohorts must match their declared support | Restore from the rehearsed backup or redeploy the compatible predecessor artifact; published migration files are never edited or removed | Database migration owner / each migration change |

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
