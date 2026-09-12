# Remaining-work audit — application surfaces

Snapshot: commit `778a406256e5f70ed724f36a72018095ff828c51` plus the existing
working-tree changes present on 2026-09-12. This is a read-only review of
`apps/api`, `apps/worker`, `apps/retention`,
`apps/recovery`, `apps/lifecycle-command`, and `apps/operator-command`, against
the plan, ADRs 001/004/005/006/012/015/027/028/029/030, current tests, and the
generated source inventory at
[source inventory](source-inventory.json). No repository files
were changed by this audit; current working-tree tests and generated evidence
are included where available.

## Implementation closeout

The four worker lifetime actions identified below are complete. Both wakeup
scanners and failure-notification recovery accept a caller signal through the
database transaction seam; coordinator and preview-maintenance close abort and
bound active background work before closing owned adapters. Preview and failure
notification claim/completion operations use the queue transport signal, while
the separate execution-deadline signal can still produce a durable terminal
deadline outcome. Deferred claim, completion, scanner, recovery, duplicate,
late-settlement, and non-cooperative shutdown tests pin those choices.

The non-cooperative cases prove the documented timeout-race behavior, not that
an arbitrary dependency terminates. Real local PostgreSQL honored propagated
cancellation, but a dependency that ignores cancellation may continue after the
runtime returns its timeout result. Production termination remains bounded by
the process/container deadline rather than an unconditional in-process shutdown
guarantee.

API priority coverage now measures 15 files after source-identical overlap
partitioning: 664 tests passed, with 97.44% statements and 96.39% branches
before the two API-overlap files are removed from risk aggregation. Public
authorization, OIDC cleanup/encryption, composition, workflow-authoring, and
webhook ingress tests hit 83 of the 108 newly exposed branches; the remaining
25 are exact reviewed defensive, unreachable, or generated rows. Worker
coverage passed 337 tests at 94.26% statements / 95.84% branches; the separate
lifecycle cohort names five shutdown-critical modules. The current application
risk inventory is 25 API-priority, 11 API-orchestration, 16 worker, and 3
lifecycle-command rows, all reviewed with zero unreviewed debt.

The audit prose and action table below record the evidence that motivated the
implementation. Their future-tense actions are resolved by this closeout and
the generated [risk snapshot](risk-snapshot.json).

## Original executive disposition

The application code has no newly proven data-integrity or authorization defect
in this pass. The API’s previously reported error ownership, connection-test
cancellation, SSE observer retention, bootstrap cleanup, and contract issues
are represented by current code and tests. The worker’s previously reported
readiness-marker race is closed by a terminal stopping state and public
lifecycle tests. Retention, recovery, lifecycle-command, and operator-command
remain thin composition boundaries with meaningful local tests.

One planning coverage-row disposition was corrected below as **REVIEW
CORRECTION W02**: the no-signal completion arm was reachable through the handler
at that point. The implementation now forwards the chosen transport signal.

The following planning table records the four worker lifecycle actions that
were subsequently implemented. They were bounded design or evidence gaps, not
claims of an observed production incident:

| Priority | Boundary | Evidence | Specific action and acceptance |
| --- | --- | --- | --- |
| P2 | Coordinator scanner shutdown | `apps/worker/src/execution/coordinator-runtime.ts:208-248` starts a loop whose two `claimDueWakeups()` calls accept no signal and whose `close()` awaits `scannerLoop` directly. `packages/database/src/execution/{due-node-wakeup-scanner,deadline-wakeup-scanner}.ts:6-27` issue `pool.query` without a caller signal. The worker DB pool policy supplies a 125,000 ms `query_timeout` for the worker role (`packages/database/src/platform/postgres-pool-policy.ts:59-64,99-108`), so a normal configured DB query is eventually bounded, but the application does not own a close deadline and a fake/hung port can wait forever. | Add an optional `AbortSignal` to both scanner ports and wire it through the database package’s supported cancellation/ownership seam after verifying the configured `pg` adapter’s semantics; do not assume a raw `pool.query` signal option is sufficient. Pass a close controller through the loop and keep a final bounded close guard at the runtime seam. Test: defer each scanner call, call `runtime.close()`, assert the exact signal is aborted, the loop and both adapters settle, repeated close is idempotent, and an injected never-settling port returns the documented timeout/aggregate result. Live lock/network hang behavior is unknown until a service drill. |
| P2 | Failure-notification recovery shutdown | `apps/worker/src/execution/preview-maintenance-runtime.ts:183-208` calls `failureNotificationStore.recoverDue(25,3)` without a signal and waits for `recoveryLoop` during close. `FailureNotificationStore.recoverDue` has no signal in `packages/database/src/execution/failure-notification-contracts.ts:82`. The worker pool query budget bounds the real SQL to 125 s, but no app-owned shutdown deadline is asserted. | Add signal support to `recoverDue` and the recovery loop through the database package’s supported cancellation/ownership seam; preserve PostgreSQL authority and retry-on-next-cycle behavior. Test a deferred recovery call, close during it, exact signal propagation, no post-close second call, and cleanup aggregation. Run one enabled-notification worker process with a blocked query/controlled DB stop to record actual termination against ECS grace. Until that drill, classify live hang and RTO as unknown. |
| P2 (evidence/design clarification) | Preview terminal completion cancellation | `PreviewAttemptRunStore.complete` accepts `signal` (`apps/worker/src/execution/preview-attempt-handler.ts:75-89`), and the database adapter forwards it to `withTenantScopedClient` (`apps/worker/src/execution/preview-attempt-runtime.ts:100-120`). `completeOutcome` and all direct completion paths in `preview-attempt-handler.ts:159-230` currently omit it. This may be deliberate for a deadline outcome: the supervisor execution signal is already aborted at the deadline, while terminal persistence should still commit; however, queue shutdown cancellation is not explicitly bounded at this app seam. No production hang is proven. | Decide/document that terminal persistence uses the transport context signal (not the expired supervisor execution signal), or an explicitly derived completion signal with a bound. Forward that chosen signal on success, invalid-output, control, and deadline completion. Test exact signal identity, deadline completion still commits when only the execution signal is aborted, queue abort reaches the DB operation, and late completion cannot write after cancellation. |
| P2 | Failure-notification claim/complete cancellation (related) | `createFailureNotificationHandler` checks queue abort before claim but `claimDelivery` and `completeDelivery` have no signal in the store contract (`apps/worker/src/execution/failure-notification-handler.ts:54-120`; database contract `failure-notification-contracts.ts:46-64`). The provider delivery itself receives a signal. | Resolve as part of the recovery/terminal-signal decision: add signals to claim and completion where cancellation is safe, or explicitly state why durable terminal completion is intentionally non-cancelable and apply a local bound. Add deferred claim/complete tests. Do not infer an incident from the current source; the configured DB query budget and provider timeout are separate bounds. |

The API has no analogous newly confirmed defect. Its remaining concern is
assurance scope: most feature files are intentionally outside the selected
coverage cohorts. They have direct tests, but a full API percentage must not be
claimed from the selected 12-file critical cohort plus the separate four-file
orchestration cohort.

The real release blockers remain external: AWS dual-region/Object Lock and IAM,
provider behavior, Redis topology, deployed ECS drain/readiness, PostgreSQL
failover/PITR/regional restore and capacity, autoscaling, dashboards/pager
exercises, and signed image/provenance. Local unit and disposable PostgreSQL
tests cannot substitute for those results.

## Planning coverage and evidence scope

The planning `coverage/risk-uncovered-branches.json` was schema 7, generated at
`2026-09-11T21:09:43.867Z`; it records 344 reviewed sites and zero unreviewed
sites in its selected policy. Exactly 30 rows are owned by the six requested
application families: API 11, worker 16, lifecycle-command 3, retention 0,
recovery 0, and operator-command 0. “0” means no registered uncovered row, not
that the app is selected for measurement or that every runtime path was tested.
Retention, recovery, and operator-command have direct tests but no selected
coverage cohort. Lifecycle executable-only branches are covered by subprocess
behavioral evidence while remaining outside the unit V8 counters. Worker
integration references are not relabeled as executed without a matching
successful run artifact.

Selected cohorts at that planning point were:

* API critical: 12 files, 100% statements/branches/functions/lines, 632 tests.
* API orchestration: `application-error-mappers.ts`, `connections/connection-testing.ts`, `workflow-runs/sse-authorization-lifetime.ts`, and `workflow-runs/use-cases.ts`; 96.04% statements, 93.68% branches, 96.97% functions, 96.75% lines, 632 tests.
* Worker: 13 files, 94.26% statements, 95.84% branches, 86.61% functions, 94.59% lines, 328 tests.
* Lifecycle-command: 4 files, 91.67% statements, 93.48% branches, 73.68% functions, 95.06% lines, 25 tests.

These numbers are overlapping cohort measurements, not repository-wide app
coverage. The generated source inventory contains 658 files overall. The six
requested apps contain 227 source files: API 149 (123 runtime,
26 declaration/import/re-export-only), worker 63 (61 runtime, 2
declaration/import/re-export-only), retention 5, recovery 3,
lifecycle-command 4, and operator-command 3. Thus the six-app runtime count is
199. Across the entire 658-file inventory, 576 files are runtime-syntax files;
406 runtime files belong to at least one selected coverage cohort and 170 are
outside selected cohorts. The 170 value is whole-inventory scope, not a count
for the six requested apps, and none of these inventory counts is an
untested-path claim.

## API inventory and disposition

### Composition and platform (4 root files, 23 platform files)

`src/main.ts`, `src/app.ts`, `src/app.module.ts`, and
`src/application-error-mappers.ts` own process bootstrap, typed runtime-source
composition, dynamic feature registration, Nest shutdown hooks, and error
mapper ordering. `src/platform/{config,database,health,http,identity,observability,rate-limit,artifacts,connections,schedules,webhooks,workflow}` owns configuration, health/drain, HTTP context/problem handling, telemetry, rate limiting, and runtime adapters. The API bootstrap suite exercises route registration, readiness and artifact checks, contradictory runtime inputs, late factory failure, synchronous and asynchronous cleanup failures, and shutdown aggregation. `main.ts` remains a process-entrypoint seam rather than a fabricated unit percentage.

No new composition defect was confirmed. Preserve the invariant that API
construction never executes production nodes; runtime-source unions reject
ambiguous or contradictory overrides; every resource created by a factory is
inside one cleanup boundary; readiness is not marked before dependencies pass;
and drain is visible independently from liveness. The problem filter now owns
safe unknown-error normalization and contains both mapper and logging failures.

### Feature file inventory

The following is the complete API source inventory by feature family (the
machine-readable file above contains exact per-file kind, hash, and cohort
presence):

* Artifacts: `controllers.ts`, `errors.ts`, `guards.ts`, `index.ts`, `module.ts`, `ports.ts`, `service.ts`, `store-port.ts`, plus `tokens.ts`. Owners: `test/artifacts/{controllers,runtime,service,transfer.integration}.test.ts`. Direct transfer tests cover authorization, bounded metadata, signed transfer, store readiness, and cleanup; AWS policy/permission behavior remains external.
* Catalog: `controllers.ts`, `module.ts`, `use-cases.ts` (and `index.ts`). Owners: `test/catalog/{controller,module}.test.ts` plus contracts and node-catalog browser projection tests. No executor or credential disclosure is allowed from discovery.
* Connections: authorization, connection-testing, controllers, errors, failure-notification-destinations, guards, module, telemetry, tokens, types, use-case-support, use-cases, ports/index leaves. Owners: eight direct suites under `test/connections/`, including credential boundaries, HTTP stack, destination commands, telemetry, and use cases. Cancellation is forwarded through decryption and all provider clients; replay skips decryption/provider I/O.
* Executions: initial checkpoint, PostgreSQL event reader, Redis event source, run-event stream, and export leaves. Owners: six execution suites, including Redis-loss and integration streams. PostgreSQL is authoritative; Redis is only a wake-up hint.
* Identity and identity infrastructure: `identity/{crypto,csrf,errors,oidc,ports,session,types}`, and `identity-infrastructure/{oidc-adapter,oidc-request-validation,oidc-response-cleanup,oidc-secret-encryption}`. Owners: `test/identity`, `test/identity-infrastructure`, and bootstrap/real-OIDC tests. Strict endpoint/cookie/key parsing and secret cleanup are present; provider availability and key rotation in deployment remain external.
* Identity-workspace: context/error, contracts, controllers, cursor, database adapter, errors, guards, module, request identifiers, telemetry, tokens, types, use cases, and export leaves. Owners: 11 direct suites plus real API integration. Session-authenticated reads, owner/admin membership reads, opaque cursor bounds, no-store responses, and transaction-time authorization are covered. Membership mutation/invitation is deliberately out of scope.
* Node-testing: controller, errors, guards, module, ports, tokens, use case, validation. Owners: five direct suites and contract tests. Validate is read-only; `test_execute` is durable, acknowledged, idempotent, and worker-owned.
* Schedules and webhooks: controllers, guards, module, service/ingress, telemetry, tokens. Owners: service/ingress/telemetry tests and direct webhook integration. Signature/replay, raw-byte bounds, content-type, trigger authorization, and async acceptance are covered; provider/load and production ingress exercises remain external.
* Workflow-authoring: controllers, cursor, errors, etag, guards, lifecycle/restore/use cases, graph/serializers, module, ports, telemetry, tokens, types, and export leaves. Owners: ten direct suites plus lifecycle/version-restore integration. Immutable versions, ETags/CAS, executable validation, archive/restore, and activation projection are covered.
* Workflow-runs: controllers, errors, event-streamer, guards, module, persistence, SSE authorization lifetime, stream cleanup, tokens, use cases, and leaves. Owners: six direct suites plus SSE resilience/integration. The authorization lifetime coalesces refreshes, owns timers/listeners, aborts on loss, and stops cleanly; risk rows are retained as reviewed defensive/invariant branches below.
* Workspaces: actor context, audit, authorization, policy, types. Owners: three direct policy/audit/authorization suites. Workspace identity and capability checks remain explicit and transaction-backed.

### API bounded follow-up

No implementation change is recommended from this audit. Keep the four-file
orchestration cohort and its 11 reviewed SSE rows as a separate honest gate.
If assurance is strengthened, add a long-stream regression that measures live
authorization observers after 10,000 frames, explicit abort during initial
subscription, and cleanup failure composition through `streamRunEventFrames`.
Acceptance is bounded pending observers, one authorization abort, one cleanup
attempt per owner, and unchanged PostgreSQL backfill ordering. This is an
assurance reinforcement; current direct tests and the prior retention fix are
evidence that the old defect is closed.

## Worker inventory and disposition

The worker source inventory contains 63 files (61 runtime and 2
declaration/import/re-export-only):

* Root/platform: `main.ts`, `app.ts`, `worker.module.ts`, config, database and observability modules, and export/testing leaves. `worker-bootstrap`, process-lifecycle, config, and compatibility tests cover dynamic construction, role checks, startup failure, clean SIGINT/SIGTERM, and disabled-consumer keepalive.
* Execution: coordinator engine/handler/runtime/telemetry; core identities; node-attempt engine/handler/runtime/execution-environment; node runtime capabilities, artifact policy, provider-connection runtime, execution fields; preview attempt handler/runtime/supervisor, preview maintenance/reconciliation, unknown-outcome and operator replay runtimes; failure-notification delivery/handler; provider telemetry and persistence projection. Direct unit suites plus PostgreSQL/Redis service cohorts cover leases, CAS, provider dispatch evidence, artifact metadata, duplicate delivery, deadline/unknown outcomes, preview retention, and reconciliation.
* Transport: consumer capability registry, dispatch providers, outbox dispatcher/result/settlements, operation deadlines, all runtime providers, metrics adapter, transport job/tokens/module/lifecycle. Direct and integration suites cover identifier-only payloads, claim/publish/mark races, late settlement ownership, readiness, drain, queue redelivery, and cleanup order.
* Runtime: abortable delay, artifact metrics, drain state, process keepalive/shutdown, readiness/readiness monitor, resource monitor. Readiness monitor and shutdown have selected tests; resource monitor and keepalive are direct lifecycle seams but outside the selected risk denominator.
* Triggers: trigger handler/runtime/telemetry. Schedule scanner, release pinning, reconciliation, and failure telemetry are covered by trigger and schedule integration suites.

Important worker invariants confirmed:

* The dispatcher claims only enabled, composed consumer capabilities; it does
  not publish a job kind without a ready consumer. Unknown publication/mark
  outcomes retain durable ownership until late promises settle.
* Runtime providers transfer ownership of resources only at explicit factory
  boundaries. Same-phase resources close concurrently; consumer drain precedes
  dependent release. Injected database runtimes lease pools without double
  closing the shared runtime.
* Production node execution validates the pinned workflow projection, release,
  invocation scope, branch/iteration ancestry, side-effect class, and dispatch
  evidence before calling an executor. Preview execution stays separate and
  never mutates production workflow state.
* Readiness checks are fail closed, marker writes/revocations are aggregated,
  and shutdown enters a terminal state before a deferred check can recreate
  readiness. Queue, DB, and provider signals are not interchangeable; this is
  why the preview completion action above needs an explicit contract.

## Retention, recovery, lifecycle-command, and operator-command

### Retention (5 runtime files)

`config.ts`, `main.ts`, `maintenance-loops.ts`, `metrics.ts`, and `run.ts` form
a thin maintenance composition. Config parsing enforces strict bounds,
production OTLP, artifact/ledger identity separation, and operation timeout
shorter than the lease. Eight independent loops use readiness gates, bounded
batches, exponential backoff capped at 30 s, abort-aware waits, and isolated
failure handling. `run.ts` starts readiness/supervisors and performs ordered
all-settled cleanup. Tests: config (4), metrics (1), run (13; approximately 18
tests total). They cover loop decision matrices, readiness failure, capacity,
poll/backoff cancellation, failure isolation, cleanup aggregation, and
undefined rejections. The app delegates retention authority to the database;
do not duplicate SQL policy here. The remaining qualification is deployed
Object Lock/versioning/ledger behavior and purge SLAs.

### Recovery (3 runtime files)

`config.ts`, `main.ts`, and `restore-before-serve.ts` parse strict bounds and
perform sequential fail-closed readiness: database, ledger, artifact, workspace
reconcile, then bounded artifact inventory/digest/replica verification. Cleanup
is attempted on every pre-invoke failure. Config/restore tests (about 13) cover
success ordering, each readiness failure, undefined errors, cleanup failures,
artifact verification, page/record bounds, pre-abort, and telemetry-start
failure. This proves local orchestration only; regional failover, AWS
credentials, Object Lock, RPO/RTO, and real control-ledger recovery are
unknown until a controlled deployment drill.

### Lifecycle-command (4 runtime files)

`config.ts`, `main.ts`, `readiness-marker.ts`, and `run.ts` own one-shot
workspace lifecycle dispatch. Config validates role, actor/reason, operation
deadline/budget, OTLP, and lease relationships. The command writer is the only
owner of the lifecycle ledger command. Tests cover parser/config, marker
permissions, run ordering/cleanup, bootstrap failures, and compiled child
process SIGINT/SIGTERM behavior. The three `main.ts` V8 rows are executable
entrypoint branches: subprocess evidence verifies fatal formatting and clean
signals, but the unit collector does not merge child-process counters. No
additional code issue was found.

### Operator-command (3 runtime files)

`config.ts`, `main.ts`, and `run.ts` implement the separate one-shot operator
role. Config uses a discriminated union for ten command kinds with bounded
actor/reason/IDs/replay JSON/dry-run fields and forbidden-role checks. `run.ts`
routes every command to its exact database operation and aggregates bounded
cleanup failures without replacing the primary failure. Current tests cover all
ten variants, null status, pre-abort, readiness/operation failures, cleanup
timeout, undefined errors, and multiple cleanup failures. There is no selected
coverage cohort and no registered uncovered row; do not call it untested. A
useful low-priority assurance addition is a parser table for the four variants
not individually named by current config tests (`due-work.resume`,
`run.cancel`, `unknown-outcome.record-evidence`, `purge.rerun`), with acceptance
that all ten parser shapes reach the same bounded run seam. This is evidence
improvement, not a production defect. Live operator IAM admission remains
external.

## Exact planning risk rows owned by these apps

All rows below are from the planning schema-7 report. That source artifact marked
all of them reviewed and none unreviewed; this report corrects one disposition
(W02) where current handler code contradicts the generated justification.
`reviewed-uncovered` is a report state, not a claim that the behavior is
missing. `generated` means V8 produced an implicit branch with no source
coordinate; `unreachable`/`defensive`/`integration` are classifications that
must remain supported by the selected source revision and evidence.

### API — 11 rows (`sse-authorization-lifetime.ts`)

| Branch | Location | State/classification | Disposition |
| --- | --- | --- | --- |
| 5/1 | generated line 0 | reviewed-uncovered / unreachable | Sole pending authorization promise owns its own success settlement; coalescing tests cover the public seam. |
| 6/1 | generated line 0 | reviewed-uncovered / unreachable | Sole pending authorization promise owns its rejection settlement. |
| 15/1 | generated line 0 | reviewed-uncovered / unreachable | Listener and timer assignment occur in one synchronous job after pre-abort. |
| 19/1 | generated line 0 | reviewed-uncovered / unreachable | Watchdog constructs the wait only after the non-aborted check; timer is assigned synchronously. |
| 20/1 | generated line 0 | reviewed-uncovered / unreachable | Watchdog cancels only after wait resolution; abort/deadline paths settle first. |
| 1/0 | line 58 | reviewed-uncovered / defensive | Authorization loss and explicit refresh may race; `revoked` makes stream abort idempotent. |
| 13/1 | line 223 | reviewed-uncovered / defensive | Native/composed signals provide a reason; fallback remains safe for a conforming signal without one. |
| 14/0 | line 250 | reviewed-uncovered / defensive | One listener is removed by every competing settlement path. |
| 16/0 | line 260 | reviewed-uncovered / defensive | Watchdog precheck contains a nonstandard synchronously changing signal. |
| 17/0 | line 266 | reviewed-uncovered / defensive | Second abort check closes the listener-registration race. |
| 18/0 | line 272 | reviewed-uncovered / defensive | Late timer delivery after settlement is harmless and cleanup remains idempotent. |

### Worker — 16 rows

| File | Branch | Location | State/classification | Disposition |
| --- | --- | --- | --- | --- |
| `execution/failure-notification-delivery.ts` | 1/1 | generated line 0 | reviewed-uncovered / generated | Implicit `SecureHttpError` fallthrough; concrete pre-/post-dispatch policy tests exercise source decisions. |
| same | 27/2 | line 502 | reviewed-uncovered / unreachable | Destination store contract is the closed Slack-or-email union; `assertNever` is defensive type exhaustiveness. |
| `execution/node-attempt-execution-environment.ts` | 4/1 | generated line 0 | reviewed-uncovered / generated | Implicit executor-controlled dispatch fallthrough; before-execute, executor-controlled, and missing-evidence decisions are tested. |
| `execution/node-attempt-handler.ts` | 7/1 | generated line 0 | reviewed-uncovered / generated | Implicit heartbeat decision fallthrough; surrounding heartbeat outcomes are tested. |
| `execution/node-runtime-capabilities.ts` | 8/0 | line 304 | referenced-only / integration | Named artifact-reference integration streams normal node output through persistence. Source-linked, not a passing-run claim. |
| same | 8/1 | line 313 | reviewed-uncovered / defensive | Preview artifact persistence is retained for future artifact-producing executors; current supported preview outputs inline values. |
| same | 29/1 | line 447 | referenced-only / integration | Named HTTP node-attempt integration composes dual-region store and verifies persisted stream. Source-linked only. |
| `execution/preview-attempt-runtime.ts` | 0/0 | line 81 | reviewed-uncovered / unreachable | Production preview dispatch receives the queue signal; omission only exists on the general optional store port. |
| same | 0/1 | line 81 | referenced-only / integration | Preview-delivery integration passes worker abort signal through DB dispatch. |
| same | 1/0 | line 96 | reviewed-uncovered / unreachable | Production preview heartbeat receives the queue signal. |
| same | 1/1 | line 96 | referenced-only / integration | Preview-delivery integration passes worker signal through DB heartbeat. |
| same | 2/0 | line 112 | **REVIEW CORRECTION W02 / reachable no-signal arm** | The optional-signal branch was reachable in the planning tree: `completeOutcome` calls omitted `signal` on success, invalid-output, control, and deadline paths. The closeout forwards the transport signal and adds exact-signal tests. |
| same | 2/1 | line 112 | referenced-only / integration (not signal-forwarding proof) | At planning time the preview-delivery integration covered preview behavior but did not prove handler signal forwarding. The closeout's direct handler tests now provide that proof. |
| `runtime/worker-readiness-monitor.ts` | 10/1 | generated line 0 | reviewed-uncovered / unreachable | `currentCheck` owns its `finally`; no other path replaces it. Public coalescing/shutdown tests cover lifecycle. |
| same | 1/0 | line 32 | reviewed-uncovered / defensive | `Promise.allSettled` retains both marker-operation failures. Injected marker tests cover fail-closed behavior. |
| same | 2/0 | line 33 | reviewed-uncovered / defensive | Production filesystem failure aggregates into fail-closed lifecycle; injected marker avoids mutating host `/tmp`. |

### Lifecycle-command — 3 rows (`src/main.ts`)

| Branch | Location | State/classification | Disposition |
| --- | --- | --- | --- |
| 9/0 | line 141 | reviewed-uncovered / defensive | Executable entrypoint fatal condition is exercised by compiled subprocess, not merged into unit counters. |
| 10/0 | line 145 | reviewed-uncovered / defensive | Error formatter preserves only safe type name; subprocess verifies sanitized Zod failure. |
| 10/1 | line 145 | reviewed-uncovered / defensive | Unknown-thrown-value branch is conservative and not reached by current subprocess injection; retain explicit review. |

Retention, recovery, and operator-command have no current risk rows.

## Implemented follow-up plan

Items 1–3 below are complete on the current local tree. External release
evidence in item 4 remains pending.

1. **P2, worker lifecycle contracts.** Add cancellation parameters to
   coordinator wakeup scanners and notification recovery/claim/completion as
   contract decisions permit, then route them through the database package’s
   supported cancellation/ownership seam after verifying adapter semantics.
   Add exact-signal unit tests and never-settling cleanup tests. This depends
   on database port changes and must preserve role pool query/statement
   budgets.
2. **P2, preview completion decision.** Choose transport-context cancellation
   versus non-cancelable bounded terminal persistence; document it against ADRs
   005/007/016. Add success, invalid-output, control, deadline, queue-abort,
   and duplicate tests. Do not pass the already-aborted supervisor execution
   signal to terminal persistence without proving it can still commit.
3. **P2, compose/process evidence.** Run worker process tests with coordinator
   scanners and failure-notification recovery enabled, controlled DB loss, and
   a measured termination budget. Run equivalent deployed ECS drain/readiness
   drills. Record pass/fail artifacts by exact source revision.
4. **P3, measurement honesty.** Keep selected cohorts separate and re-review
   classifications when source or evidence changes, including
   **REVIEW CORRECTION W02**; do not treat the current 30-row set as immutable.
   If broader app coverage is desired, create named cohorts for the operational
   apps rather than summing selected-file reports; parser-table tests for
   operator variants are optional evidence improvement.
5. **Release-gated external work.** Qualify AWS versioned/Object-Lock buckets,
   dual-region ledger repair, IAM/ECS immutable invocation, provider/Redis
   outage behavior, PostgreSQL failover/PITR/regional restore and capacity,
   autoscaling, telemetry/pager routing, signed provenance, and image digest
   promotion. Until those artifacts exist, retain Phase 7 and production SLO
   checklist items as incomplete.
