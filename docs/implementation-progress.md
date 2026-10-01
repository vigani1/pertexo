# Backend Implementation Progress

Last updated: 2026-10-01

This is the mutable delivery tracker for
[`workflow-platform-backend-plan.md`](./workflow-platform-backend-plan.md).
A phase is complete only when its plan requirements and applicable
vertical-slice criteria have passed. Local checks never substitute for the
external production evidence listed under Phase 7.

## Current qualification

### F29 — queue-only workflow concurrency

The ADR058 first slice is implemented locally on `feat/workflow-concurrency`.
Independent manager review identified three correctness fixes; their focused
regressions now pass, with final rerun and independent rereview still required.
Scoped PR checks/merge and natural postmerge qualification remain open.
This does not close Phase 7 or supersede the
historical qualification fingerprints below. F12 must be qualified on merged
main before F29 release.

- [x] Current workflow cap, durable acceptance tickets, workspace-authoritative
      admission, ordered starts, and grandfathered reservations implemented.
- [x] Authorized CAS/idempotent settings commands and timestamped queued-run
      blockers implemented with settings/history UI.
- [x] Real PostgreSQL proof: 22 concurrency cases plus 18 existing regression
      cases; 878 database unit tests. Coverage includes reverse starts, shared
      workspace capacity, settings/acceptance races, control-path delivery,
      legacy upgrade, role boundaries, and readiness drift rejection.
- [x] Final full PostgreSQL suite: 103 files / 741 tests passed. The privileged
      trigger-disabled terminal-history seed allocates mandatory tickets
      explicitly; its normal-planner budgets remain unchanged.
- [x] Real HTTP proof: three authorization, command, replay, and policy cases.
- [x] Enabled non-artifact API service cohort after the F12 repair merge:
      20 files / 87 tests passed. Artifact-transfer and three opt-in browser
      suites (25 tests) were skipped in that cohort; F29's live browser proof
      below was executed separately, not inferred from a skipped suite.
- [x] Real API/worker/browser proof: cap 1 leaves the second run queued with no
      node execution; an acknowledged worker-runtime restart preserves state;
      browser removal releases the second run with ordered start timestamps.
- [x] Pre-review head `b67fc180` passed `pnpm check`: full build, typecheck, lint, contracts, architecture,
      complexity, duplication and unit suites passed (API 1,745, worker 868,
      database 878, web 792 tests). Changed React Doctor score: 100/100.
- [x] Pre-review head `b67fc180` passed `pnpm test:coverage`: 24 cohorts bound to source fingerprint
      `sha256:198aa04d84d05ffc8c94893acc070ff10e50930640ab59d7b546829c04a82581`;
      zero unreviewed / 390 reviewed residual branches across 210 selected
      files and 8,075 coverable lines. Only two unchanged timestamp-guard
      reviews were re-pinned for whole-file instrumentation fingerprints;
      no exclusion or budget was broadened.
- [x] `pnpm test:browser-probes` (seven assertions) and
      `pnpm deployment:check` (60 assertions) passed locally.
- [x] Lock order, mixed-version fail-closed enforcement, and rollback documented
      in [the enforcement note](./operations/workflow-concurrency-enforcement.md).
- [ ] Independent manager review and complete release qualification.
- [x] Close the reviewed active-insert serialization race, preserve committed
      reservations during FIFO deferral, and cancel stale reads before
      denied-write cache eviction; focused RED/GREEN proofs recorded below.
- [ ] Requalify the repaired head and complete independent rereview.
- [ ] Scoped PR merged with required checks; natural postmerge result inspected.

The PostgreSQL receipt proof exercises bounded maintenance reaping and verifies
both new tables in the authoritative tenant purge function; it does not claim
an executed tenant-row purge. The live restart is a worker-runtime lifetime
restart, not an operating-system process kill. Skip overflow and independent
queue configuration remain deferred. No production deployment or activation
was performed.

Implementation commits: `c02f0ce4` (database/contracts/API) and `36392cdb`
(settings/history UI and integrated proof). Normal merge `a3f0af4c` incorporates
the manager-reviewed F12 qualification repairs; it is not a release or postmerge
main qualification claim.

The CI-routing follow-up normally merged F12's reviewed browser-owner fix
`80621acb` in `f1b4cb4`, then gives the concurrency fixture its own required
browser-installed CI step and ordinary/local cohort exclusion. Local execution
with the CI environment and an attested task-owned Compose project passed
one live test; the unchanged strict JSON validator accepted it with zero skips.
Ownership unit tests cover 45 accepted and rejected configurations. CI routing
and local-quality contracts pass; this is not a hosted CI completion claim and
does not change the manager's fixed-point core implementation review.
The CI proof project is temporarily retained for the authorized review-fix
verification; its finished browser/worker lifetimes are closed and Redis DB11
is empty. No everyday service was adopted.

The review fixes were reproduced before implementation. Eight real PostgreSQL
API/worker × running/waiting × marked/unmarked INSERT races observed the writer
blocked by the authenticated settings transaction, then incorrectly committed
after the cap. The post-counter policy check now rejects all eight with the
expected `PTC01`/`PTC02`. A real coordinator-store test reproduced B's lost slot
when cap 2 reservations were lowered to 1 and B arrived before A. The repaired
path preserves and rebinds B's reservation through deferral, duplicate delivery
and store restart; A then B start using their committed slots, without a third
grant. Twelve new regressions (the nine original failures plus worker/context,
binding and real-recovery boundaries), the existing 22 concurrency cases and
19 coordinator scheduling cases pass: 51 assertions. Readiness mutation tests
reject helper body and execution-ACL drift for API, worker and dispatcher.

Frontend commit `2a8d89f0` cancels the exact protected settings read before cache
eviction. All 21 settings tests pass, including held GET + denied PUT
401/403/404 with real HTTP and cancellation-ignoring reads, remount/network
failure and fresh authorized recovery; changed React Doctor remains 100/100.
The new reservation helper is worker-only and readiness pins its body and exact
ACL; the trigger fingerprint now includes its serialized second policy check.

Heavy qualification suites were serialized after concurrent runs hit unchanged
workflow-engine and coordinator-observation test timeouts. Isolated observation
tests and the final full database suite passed with their original budgets;
no production code, timeout, or gate was changed to hide those failures.

Task-owned PostgreSQL and Redis containers were removed after qualification;
their disposable fixture data was discarded. Everyday services and the 43
uncommitted paths in the primary checkout were left untouched. The F29 branch
has not been pushed and has no configured upstream.

### Historical backend qualification

The backend fixes are recorded in commit `f0484564`. The final SSE
public-projection correction keeps the original validation error, starts the
transport cleanup budget before awaiting an uncooperative nested iterator, and
observes late fulfillment/rejection without leaking resources. The full API
run passed 97 files / 1,277 tests.

The pre-cleanup full local qualification,
`pertexo-local-quality-2026-09-14t09-35-41-831z-24290-031bb08c`, passed all 21
required cohorts at full-run candidate fingerprint
`sha256:37fb33395ed496f5fbfb5dda82ac221c03bbc54b802155569a37ae6079d28743`.
Its app/package source inventory fingerprint is
`sha256:b460ce440131ff15831907d051f0b062f7f1e943ad538925a4c2bd6872c7d01c`.
The source inventory accounts for 691 files, and risk evidence records 405
reviewed / 0 unreviewed branches across 186 selected files and 7,500
coverable lines. This fingerprint and evidence describe the pre-cleanup
candidate only; they are not a claim about the post-move source tree. Local
service evidence contains 665 assertions. The only
exclusions are the three declared AWS-only control-ledger cases. This remains
local qualification; that run did not perform hosted CI, deployment, provider
requests, or AWS operations.

The subsequent documentation and infrastructure organization passes
`pnpm prepush:check`, `pnpm deployment:check`, `pnpm images:check`, and
`pnpm exercise:check`. The new documentation checks retain link and current
operational-policy validation without requiring retired audit records.
Fresh coverage binds all 24 producer cohorts to app/package source fingerprint
`sha256:52bccd43d4b33466f1d2228a9a4edb663eae9ca0fdceebc65610ecc6fd07e9cd`.
`pnpm coverage:evidence` regenerated the [source inventory](./remaining-work/source-inventory.json)
and [risk snapshot](./remaining-work/risk-snapshot.json): 691 sources, zero
unmapped runtime files, and 405 reviewed / zero unreviewed residual branches.
Source-to-test mapping is not execution coverage. These checks verify the
cleanup; the service-backed qualification above remains explicitly pre-cleanup.

## Status summary

| Checkpoint | Status | Evidence retained |
| --- | --- | --- |
| Phase 0A — repository and process skeleton | Complete | ADR 001; API/worker bootstrap and lifecycle checks; `pnpm check` |
| Phase 0B — PostgreSQL tenancy and RLS proof | Complete | ADR 003; clean PostgreSQL migration and RLS integration matrix |
| Phase 0C — HTTP and observability foundation | Complete | Compiled API/worker role, health, and telemetry smoke checks |
| Phase 0D — queue, outbox, and duplicate-delivery proof | Complete | ADRs 005–006; unit, real-service, and recovery assertions |
| Phase 0E — execution durability and engine gate | Complete | ADRs 005, 007–009; engine, process-recovery, SSE-outage, and transport-outage proofs |
| Phase 1 — identity/workspace vertical slice | Complete | ADR 004; generated-contract drift and real-service identity/RLS evidence |
| Phase 2 — workflow authoring vertical slice | Complete | ADRs 002/011; draft, publication, lifecycle, and version-restore evidence |
| Phase 3 — first executable-node slice | Complete | ADR 010; compatibility, execution, rollout, and recovery evidence |
| Phase 4 — first side-effecting integration slice | Complete | ADRs 007/016; PostgreSQL/outbox/BullMQ retry-wakeup and recovery evidence |
| Phase 5 — orchestration slice | Complete | ADRs 008, 017–022; branching, parallelism, retry/wait, notification, and recovery matrix |
| Phase 6 — V1 providers and triggers | Complete | ADRs 012–014, 023–026; provider, webhook, schedule, retained-history, and rollout evidence |
| Phase 7 — production operations | **In progress** | Repository implementation is qualified locally; external deployment, provider, load, recovery, telemetry, and pager evidence remains open |
| F29 — queue-only workflow concurrency | **In progress** | ADR058 implementation and real PostgreSQL/HTTP/browser proofs; manager review and release qualification remain open |

The 0A–0E rows subdivide the plan's single Phase 0 and do not change its
authoritative scope. All accepted architecture decisions remain under
[`adr/`](./adr/); their presence governs implementation but does not close
production gates.

## Phase 7 — Production operations

Status: **In progress**

### Authority and production policy

- [x] ADR 013 governs destructive retention, workspace purge, legal hold, and
      backup-erasure behavior.
- [x] ADR 015 fixes the initial SLO, hosting regions, backup, failover,
      recovery, RPO, and RTO strategy.
- [x] Operated legal authority, backup rotation, minimization, and retention
      policy inputs are recorded without claiming legal certification.
- [x] ADR 027 governs asynchronous tenant-facing deletion and restore dispatch.

### Retention, deletion, and legal hold

- [x] Dedicated maintenance credentials and migration-role substitution are
      bounded and do not grant serving-role access.
- [x] External control-ledger adapters, ordered PostgreSQL projection,
      high-water reconciliation, and restore-before-serve are implemented.
- [ ] Prove the dual-region append-only ledger and restore-before-serve gate
      against production AWS accounts, regions, IAM roles, and Object Lock.
- [x] Legal-hold placement/release, bounded resumable retention, leases,
      fencing, dry-run support, and dependency-safe 30/90/365-day retention are
      implemented.
- [x] Workspace deletion/restore revokes access and triggers, cancels work,
      preserves the recovery window, and records retryable purge progress and a
      non-sensitive completion tombstone.
- [ ] Prove deletion, legal hold, recovery-window, purge, and regional object
      behavior through production deployment and immutable invocation evidence.

### Operator recovery and observability

- [x] Authenticated, authorized, audited, reason-required operator commands
      cover outbox redispatch, lease reconciliation, due-work resume,
      unknown-outcome evidence, cancellation, replay, trigger reconciliation,
      and retention/purge reruns.
- [x] Cardinality-safe metrics and repository-owned dashboards/alerts cover
      API, PostgreSQL, queues, workers, triggers, providers, artifacts,
      retention, purge, and the control ledger.
- [ ] Deploy dashboards and alerts and capture pager-routing/response evidence.
- [x] Non-root, read-only, digest-pinned image/task contracts, separate
      commands and health checks, release-job migrations, and secret-manager
      references are validated locally.
- [ ] Prove rendered image, task-role, filesystem, migration-job, health, and
      secret-manager boundaries in the production deployment.
- [x] Separate API/worker autoscaling inputs are declared against admitted
      load, latency/saturation, oldest-job age, active slots, and resource
      safety.
- [ ] Deploy and measure autoscaling under representative load and saturation.

### Release exercises and completion gates

- [x] The source-stable local quality checkpoint passes coverage, mutation,
      performance, integration, deployment-rendering, recovery, and cleanup
      gates, with explicit AWS exclusions.
- [ ] Run webhook bursts, large fan-out, long-wait, and noisy-tenant load tests
      and prove fair admission under saturation.
- [ ] Run Redis-loss, PostgreSQL-failover, provider-outage, worker-drain, and
      object-storage failure exercises without contradictory durable truth.
- [ ] Run backup/PITR and regional restore drills, reconcile the control ledger
      before traffic, and measure five-minute RPO / 24-hour RTO.
- [x] Root checks, dependency/security scans, migration checks, real-service /
      recovery matrices, and production-build verification pass locally.
- [x] Fixed-head review blockers and high findings are resolved through the
      implementation checkpoint; this does not close external gates.

### Current Phase 7 evidence and open obligations

The local qualification above is paired with the active operational contracts:
[external platform](./operations/external-platform-contract.md), [local
quality](./operations/local-quality-verification.md), [regional recovery](./operations/regional-recovery.md),
[database function readiness](./operations/database-function-readiness.md),
[release/security gate](./operations/release-security-gate.md), [observability
alerts](./operations/observability-alerts.md), and [production data policy](./operations/production-data-policy.md).
These documents define owners, bounds, evidence schemas, cleanup, and explicit
limits; they do not assert deployment.

The remaining named external evidence families are:

- **ART-002:** production artifact latency and capacity observations.
- **ART-008:** live AWS dual-region artifact and recovery qualification.
- **DB-011:** representative PostgreSQL workload, planner/cache, lock/WAL,
  vacuum, and index-usage evidence at expected and burst cardinality.
- **DB-017:** deployed backup/PITR, restore, pooler, failover, RPO/RTO,
  autovacuum, replica-admission, and capacity evidence.
- **INT-010:** protected Slack, Resend, and AWS KMS sandbox compatibility.
- **INT-013:** production-like DNS/connect/TLS concurrency and latency before
  changing the safe no-pooling policy.
- **OBS-006:** production telemetry retrieval and alert/pager proof.
- **RL-002:** deployed non-clustered replicated Redis topology compatible with
  the atomic multi-key rate-limit policy.

The separately authorized Q14/E01 evidence packet covers deployment, storage,
security, provider, load, failure, pager, migration/PITR, regional recovery,
deletion, restore, and purge drills. Every drill requires identity, access,
command, capability, result, and cleanup fields. A completed packet is not
execution evidence; production accounts and deployed infrastructure are still
required. API-key and connected-subscription entities remain deferred by the
V1 scope and must not be invented solely to satisfy deletion coverage.

## Requirement-to-evidence navigation

| Plan area | Canonical owners | High-value proof |
| --- | --- | --- |
| Foundation and process roles | `apps/api/src/main.ts`, `apps/worker/src/main.ts` | API bootstrap and worker lifecycle tests |
| Identity, tenancy, and security | `apps/api/src/identity-workspace/`, `packages/database/src/tenant-access/` | Real identity HTTP and RLS integration tests |
| Authoring and publication | `apps/api/src/workflow-authoring/`, `packages/database/src/authoring/` | Lifecycle and version-restore integration tests |
| Execution, queues, and recovery | `packages/workflow-engine/`, `packages/database/src/execution/`, worker coordinator | Parallel assurance and redelivery/recovery tests |
| Integrations and connections | `packages/integrations/`, API connections | HTTP executor and connection integration tests |
| Providers and triggers | API webhooks, worker triggers, database trigger stores | Direct webhook and schedule recurrence integration tests |
| Artifacts and capacity | `packages/artifact-store/`, database artifact authority, API artifact controller | Dual-region store and artifact transfer tests |
| Operations and recovery | retention/recovery apps, database lifecycle, `infrastructure/ecs/` | Retention inventory and restore-before-serve tests; external evidence remains open |

These routes locate responsibility; they are not independent completion claims.

## API discovery gap closure

The four previously unallocated read surfaces are implemented and verified
locally: `GET /v1/users/me`, workspace member listing with opaque keyset
pagination, `GET /v1/node-definitions`, and `GET /v1/integrations`. They use
existing authentication/rate limits, bounded public projections, authorization,
RLS, generated contracts, and deterministic catalog selection. They do not add
profile administration, invitations, membership mutation, connection
credentials, or a second connection resource. Later identity slices add role
changes and removal (ADR 037, ADR 042), invitations (ADR 038), the
signed-in person's own display-name change (ADR 043), and leaving,
suspension, reactivation and ownership transfer (ADR 047).

## Weft follow-up reads

Post-plan read surfaces close gaps the Weft frontend recorded, each behind its
own ADR and implemented through contracts, database, API, integrations and
web:

| Surface | Route, authority and rate class | Decision and storage |
| --- | --- | --- |
| Webhook delivery log | `GET /v1/workspaces/:workspaceId/workflows/:workflowId/triggers/:triggerId/webhook/deliveries`; `workflow:read` guard plus the owner/admin/builder trigger-read check; `authenticated_read` | [ADR 045](./adr/045-webhook-delivery-log.md). Migration `0115_webhook_delivery_log.sql` adds outcome, HTTP status, signature and replay checks and body size to `app.webhook_trigger_deliveries`. Post-allowance rejections are recorded best effort in their own transaction; the 90-day retention class, RLS and purge are unchanged, and expired rows are never served. |
| Slack channel names | `GET /v1/workspaces/:workspaceId/connections/:connectionId/slack/channels?channelIds=…`; `connection:use` guard and database check; `provider_test` | [ADR 046](./adr/046-slack-channel-name-resolution.md), extending ADR 023. Up to ten IDs per request resolve through `conversations.info` with the connection's bot token under the `connection.credential_accessed` audit fact; names are never stored and unresolved channels return a reason instead of an error. No migration. |
| Schedule run history | `GET /v1/workspaces/:workspaceId/workflows/:workflowId/triggers/:triggerId/schedule/occurrences`; `workflow:read` guard plus the active-member schedule-read check; `authenticated_read` | [ADR 048](./adr/048-schedule-fire-history-and-next-runs.md). Pages the occurrences the scanner already records (`accepted` with its run, or `skipped`), newest first, with a trigger-bound cursor; occurrences past the 90-day trigger-summary cutoff are never served. Throttled or failed claims stay trigger health. No migration: the existing occurrence index serves the keyset. |
| Schedule next runs and draft preview | `GET …/triggers/:triggerId/schedule/next-runs?count=` (`authenticated_read`) and `POST …/triggers/schedules/preview` (`workflow_compile`, CSRF); same authority | [ADR 048](./adr/048-schedule-fire-history-and-next-runs.md) on ADR 014. The persisted next fire, then the instants the scanner would persist, 1–10 (default 3), from the scheduler's own engine, timezone and DST rules and database time. The preview checks an unsaved Schedule step setup with the scheduler's parser and runs in a read-only transaction. The engine caches one `Intl.DateTimeFormat` per canonical timezone. |
| Run data | `GET /v1/workspaces/:workspaceId/runs/:runId/input` and `GET …/runs/:runId/node-runs/:nodeRunId/output`; `run:read` guard; `authenticated_read` | [ADR 050](./adr/050-run-data-reads.md). Returns a run's stored input or one node run's stored output (inline JSON, an artifact reference, `none`, or an input `expired` past its 30-day window) from a workspace-scoped read transaction. Run summaries add `replaySourceRunId`; list items add `failedStep`, named from the run's version graph (nested loop steps included) by one bounded extra query for the page's unsuccessful runs. No migration. The web run page shows each step's Data in and Data out, the run's input with Replay starting from it, and the replay source; run lists say where a run failed. |
| Step history and health | `GET /v1/workspaces/:workspaceId/workflows/:workflowId/step-health` and `GET …/workflows/:workflowId/steps/:nodeId/runs?limit=`; `run:read` guard; `authenticated_read` | [ADR 051](./adr/051-step-history-and-health.md). Both read the workflow's newest 100 runs through the existing workflow and node-run indexes: per step, how often it ran, succeeded, failed or was skipped, its latest status and the median and 95th percentile duration of its successful runs; and one step's latest runs with the run each belongs to. No migration. The editor's step panel gains a Runs tab (health, last result, recent runs) and workflow settings a Steps section ordered by failure rate. |
| Recorded step inputs | `GET /v1/workspaces/:workspaceId/runs/:runId/node-runs/:nodeRunId/input`; `run:read` guard; `authenticated_read` | [ADR 052](./adr/052-record-step-inputs.md). Before its executor runs, each attempt of a step that doesn't use a connection records its resolved input on `app.node_runs.input_ref` under the attempt's lease and fence, best effort and inline only (256 KiB). Admitting a retry clears its predecessor's input, so none passes for another attempt's; a resumed wait keeps its step's. Migration `0119` grants the worker `UPDATE (input_ref)`, and the readiness probe requires it. Steps that ran before read `none`. The run page's Data in shows the recorded input, with where it came from underneath, and otherwise says why there is none and labels the source data as such. |

Evidence: database integration tests on disposable databases
(`webhook-triggers`, `webhook-trigger-prior-head`, `connection-lookup`,
`schedule-trigger-reads`, `workflow-run-api`), DST-boundary projection tests
(`schedule-fire-projection`), the
direct-webhook HTTP integration test, API unit and coverage suites (the delivery
recorder joins the priority cohort and the channel lookup the orchestration
cohort), the API bootstrap HTTP test for the schedule routes, the Slack client
tested against a mocked HTTP boundary, regenerated webhook, connection and
schedule OpenAPI artifacts, and web component and hook tests. Recorded step
inputs are covered by `coordinator-run-store-node-attempts` (recorded under a
live lease, nothing once it is lost) and `workflow-run-api` (read back, `none`
before recording), and were checked against a local stack, where a scheduled
run's steps each recorded what their executor received. Live Slack
workspaces and deployed traffic were not exercised.

## Update protocol

When a checkpoint changes status:

1. Update its checklist and the summary table together.
2. Record concrete ADRs, commits, commands, tests, measured results, or drills.
3. Leave incomplete and deferred requirements unchecked with their blocker.
4. Never mark complete from generated files, unit tests, or prose alone.
5. Re-run the documentation and relevant implementation gates after structural
   changes before treating this tracker as release evidence.
