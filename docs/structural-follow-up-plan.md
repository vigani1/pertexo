# Structural follow-up implementation plan

Date: 2026-09-12. Status: planning only; primary-agent file-by-file correction
review complete. No finding in this document is implemented by this plan.

This plan accounts for every follow-up recorded as `PF-01` through `PF-07`
and `WF-S01` in the structural inventories and post-fix audit. It was checked
against the current source tree, direct callers, nearby tests, migration
history, and the applicable ADRs. The ordering is deliberate: close the two
P1 correctness defects first, then the startup correctness/diagnostic work and
its entrypoint evidence, and only then evaluate the three conditional items.

The audit documents remain historical evidence. Implementation should update
this plan's checklist and regenerate current evidence, but it must not rewrite
published migrations, weaken existing `KEEP` decisions, or split cohesive
modules merely because they are long.

## Outcome and ordering

| Order | Item | Status against current source | Decision |
| ---: | --- | --- | --- |
| 1 | PF-04 | **Confirmed** | Forward-only P1 database correctness fix. |
| 2 | PF-05 | **Confirmed** | Focused P1 transition-precedence fix. |
| 3 | PF-01 | **Confirmed** | P2 retention startup cleanup fix, delivered with PF-03 evidence. |
| 4 | PF-02 | **Confirmed**, with a verified scope correction | P2 bounded diagnostic classifier across six entrypoints and two operational log sites. |
| 5 | PF-03 | **Confirmed**; five entrypoints need test seams, and lifecycle-command's existing seam still needs failure-path corrections | Add app-owned bootstrap/process evidence and repair the precise ownership failures below, without a generic lifecycle framework. |
| 6 | PF-06 | **Conditional** | Measure two private candidates independently; retain current code unless the gate passes. |
| 7 | PF-07 | **Conditional** | Decide the public evaluator's hostile-object contract before changing behavior. |
| 8 | WF-S01 | **Conditional** | Remove the dead testing-only union member only after the compatibility gate. |

There is no unsupported audit item. “Conditional” means the observation is
real but does not yet authorize the proposed source change. No new ADR is
needed for PF-01, PF-02, PF-04, PF-05, or PF-03's test seam: they implement or
prove existing contracts. PF-06 must remain private. PF-07 does not need an
ADR if it only makes the existing two-field JSON boundary accessor-safe; any
proposal to broaden accepted context/graph semantics is outside this plan and
would require a separate architectural decision.

## Cross-cutting constraints

- Preserve the retention, recovery, operator-command, lifecycle-command, API,
  and worker resource-ownership boundaries. A bootstrap owns only resources
  acquired before it invokes the long-running worker/command; the invoked
  owner remains responsible afterward.
- Telemetry must start before instrumented dynamic imports. A process
  diagnostic helper must therefore be a leaf import and must not load an
  application, logger, exporter, or framework.
- Preserve error identity. Cleanup and diagnostic failures may be reported,
  but they must not replace the initiating bootstrap or operation error.
- Preserve the database fail-closed residual scan, legal holds, fences,
  bounded pages, command ledger, and forward-only migration history.
- Preserve deterministic workflow plans, event order, persisted checkpoint
  formats, cancellation/unknown-outcome truth, and bounded admission.
- Preserve all `KEEP` dispositions in the source inventories. In particular,
  do not split the workspace purge coordinator, coordinator observation
  loader, checkpoint validation, workflow observation grammar, operations
  facade, or transaction helpers for this work.
- Do not add a common configurable process-lifecycle framework. The existing
  lifecycle-command bootstrap is an example of an app-owned seam, not a new
  cross-app abstraction.
- Preserve unrelated uncommitted files. Before each implementation unit, take
  a fresh `git status --short`, stage only that unit if commits are later
  authorized, and never rewrite existing history.

## PF-04 — maintenance-rerun rows block tenant-row purge

**Status:** confirmed, P1 correctness.

### Verification basis

`0057_workspace_tenant_rows_purge.sql` explicitly deletes the tables in its
ordered `v_tables` list, then scans every non-preserved `app` table containing
`workspace_id` and raises SQLSTATE `55000` on residue.
`0066_operator_maintenance_rerun.sql` later introduced
`app.operator_maintenance_rerun_requests`, which is absent from both the
deletion and preserved lists. Normal request creation inserts the row and
processing only changes it from `pending` to `completed`. Its sole FK is from
`command_id` to the global `operator_commands` ledger, so deletion of a
workspace, run, attempt, retention batch, or purge job does not cascade it.
No migration through the current `0086` head replaces the purge function or
deletes this row.

The same conclusion does not apply to `operator_unknown_outcome_evidence` or
`operator_run_replay_requests`: their owning attempt/run/version chains
provide the relevant cascades. `operator_commands` has no `workspace_id` and
must remain an independent command ledger. ADR 013 requires the bounded,
legal-hold-aware purge behavior, while ADR 027 preserves the separate
lifecycle-command authority.

### Smallest justified change and exact files

1. Add
   `packages/database/migrations/0087_workspace_maintenance_rerun_purge.sql`.
   It must `CREATE OR REPLACE` the exact existing
   `app.execute_workspace_tenant_rows_page(uuid,uuid,bigint,integer,bigint,char)`
   body, changing only the ordered table inventory by adding
   `operator_maintenance_rerun_requests` at the dependency-safe point before
   its possible targets are removed. PostgreSQL requires the full function
   body in a forward migration; that duplication is justified and is not a
   reason to edit `0057` in place. Restate `SECURITY DEFINER`, fixed
   `search_path`, `row_security=on`, public/serving-role revocation, and the
   maintenance-role grant.
2. Advance `transactionalThrough` in
   `packages/database/migrations/migration-execution-plan.json` to the exact
   `0087` filename. This is a bounded transactional catalog replacement, not
   an online migration.
3. Advance `EXPECTED_MIGRATION_HEAD` in
   `packages/database/src/platform/readiness.ts` and its exact assertion in
   `packages/database/test/serving-readiness.test.ts`.
4. Add the SQL-shape test
   `packages/database/test/workspace-maintenance-rerun-purge-migration.test.ts`.
   It should read `0087`, require the unchanged function signature/security,
   bounded page predicate, hold/fence/high-water errors, fail-closed residual
   scan, explicit table disposition, and grants. Do not change
   `workspace-tenant-rows-purge-migration.test.ts` to pretend that published
   migration `0057` changed.
5. Add
   `packages/database/test/workspace-maintenance-rerun-purge-migration.integration.test.ts`.
   Use the established disposable-database and `copyMigrationsBefore`
   fixtures to migrate exactly through `0086`, populate valid rerun records,
   and then apply `0087`.
6. Extend
   `packages/database/test/workspace-purge-foundation.integration.test.ts` so
   the supported `createWorkspacePurgeCoordinator(...).processNext(...)`
   path proves end-to-end completion with the affected records; direct SQL
   alone does not prove the coordinator contract.
   Its disposable database currently omits `pertexo_operator` from CONNECT
   grants; add that role to this fixture if the new case opens the supported
   operator request connection. Do not bypass request authorization merely to
   reuse the existing owner pool. Reuse
   `packages/database/test/support/artifact-migration-fixture.ts`'s
   `copyMigrationsBefore(directory, '0087_')` and
   `packages/database/test/support/disposable-database.ts` in the new upgrade
   suite; neither shared helper needs a production-behavior change.
7. Append `0087_workspace_maintenance_rerun_purge.sql` to the current-head
   fixture/expected-migration lists in:

   - `packages/database/test/fixtures/migration-history-v1.json`
   - `packages/database/test/support/control-ledger-coordinator.integration.support.ts`
   - `packages/database/test/oidc-browser-binding-migration.integration.test.ts`
   - `packages/database/test/artifact-finalization-retention-deadline-migration.integration.test.ts`
   - `packages/database/test/artifact-media-type-http-safety-migration.integration.test.ts`
   - `packages/database/test/webhook-trigger-prior-head.integration.test.ts`
   - `packages/database/test/published-migration-repair.integration.test.ts`
   - `packages/database/test/schedule-claim-migration.integration.test.ts`
   - `packages/database/test/coordinator-run-store-migrations.integration.test.ts`

8. Update exact current-head expectations from `0086` to `0087` in:

   - `packages/database/test/compatibility-release.integration.test.ts`
   - `packages/database/test/connections-compatibility.integration.test.ts`
   - `packages/database/test/connections-concurrency-security.integration.test.ts`
   - `packages/database/test/coordinator-run-store-migrations.integration.test.ts`
   - `packages/database/test/coordinator-run-store-observations.integration.test.ts`
   - `packages/database/test/execution-value-persistence.integration.test.ts`
   - `packages/database/test/rls.integration.test.ts`
   - `packages/database/test/schedule-triggers.integration.test.ts`
   - `packages/database/test/webhook-triggers.integration.test.ts`

Historical prose about the `0086` operator-attempt repair and
`operator-attempt-reclaim-state-migration.test.ts` still refer to that
specific migration and must not be mechanically renamed.

### Contracts and invariants

- Every invocation affects one named surface and at most `p_page_size` rows,
  except the already-documented current-version parent/child units bounded at
  twice the page size.
- The job must be `purging`; the `tenant_rows` step must be `running`; lease
  token, fence, expiry, projected sequence, and projected hash must still
  match. A stale lease or changed high water fails closed.
- An unreleased legal hold blocks deletion before any new row is removed.
- A nonempty page returns `completed=false`, releases the step back to
  `pending`, and can be retried. Only a clean residual scan marks the step
  complete.
- RLS, definer ownership, fixed search path, role grants, immutable-table
  arming, and transaction-local purge tokens remain unchanged.
- Delete rerun request rows, not the global `operator_commands` ledger.
- Keep evidence/replay-table cascades as real FK behavior; do not add redundant
  explicit deletion merely to make the test pass.

### Regression evidence and measurable acceptance

The prior-head integration must create all four supported combinations:
`pending` and `completed` requests for both `retention_batch` and
`workspace_purge_job`. Use supported request/processing functions wherever
the state permits, not constraint-disabled invalid rows. With page size one,
record every returned surface/count and prove no page exceeds its bound,
multiple claims resume correctly, and all four request rows disappear.

In the same disposable database:

- a second workspace's rerun request and target rows remain byte-for-byte
  unchanged;
- an active hold prevents the page, release permits resumption, and a stale
  lease token/fence is rejected without deletion;
- populated unknown-outcome evidence and replay-request rows disappear through
  their actual FK chains;
- the global operator command records remain queryable after workspace purge;
- the supported coordinator completes `tenant_rows`, proceeds through the
  remaining purge steps, and can reach deletion completion without residual
  `operator_maintenance_rerun_requests`;
- a second call after completion is idempotent at the supported coordinator
  boundary; and
- readiness reports the `0087` head on a fresh schema and on the exact
  `0086 -> 0087` upgrade.

### Dependencies and verification commands

This item has no dependency on another PF item. It must land before any later
migration and should be reviewed as one schema/application-readiness unit.

```sh
pnpm --filter @pertexo/database exec vitest run \
  test/workspace-maintenance-rerun-purge-migration.test.ts \
  test/workspace-tenant-rows-purge-migration.test.ts \
  test/migration-execution-plan.test.ts \
  test/serving-readiness.test.ts
pnpm database:schema:check
docker compose up -d --wait postgres
pnpm --filter @pertexo/database exec vitest run \
  --config vitest.integration.config.ts \
  test/workspace-maintenance-rerun-purge-migration.integration.test.ts \
  test/workspace-purge-foundation.integration.test.ts
pnpm --filter @pertexo/database typecheck
```

## PF-05 — simultaneous cancellation/deadline contradicts waiting-node state

**Status:** confirmed, P1 correctness.

### Verification basis

`workflow-transition-observations.ts` can install both durable facts in one
advance. `workflow-transition-stops.ts` currently gives cancellation precedence
for loop control, but its ordinary deadline pass first changes a `waiting`
invocation to `timed_out`; the later cancellation pass only sees nonterminal
work that remains. `transition-decisions.ts` independently and correctly gives
the run `canceled`. The resulting node/run mismatch contradicts ADR 021, which
requires committed cancellation to win for a purely waiting safe invocation
when both facts are first observed together. The production operations facade
passes those observations into this same transition core.

### Smallest justified change and exact files

1. Change only the stop selection in
   `packages/workflow-engine/src/workflow-transition-stops.ts`. Derive one
   explicit precedence decision for each nonterminal ordinary or scoped
   invocation rather than running incompatible deadline-first and
   cancellation-second passes. Do not rewrite the scheduler, observation
   grammar, decisions module, or checkpoint shape.
2. Extend
   `packages/workflow-engine/test/executable-workflow-controls.test.ts` with an
   authentic compiled-executable case. Produce the waiting state through the
   real `wait` observation/advance path rather than mutating a branded
   checkpoint with `Object.assign`.
3. Extend
   `apps/worker/test/coordinator-consumer-retry-wait.integration.test.ts` with
   a focused real-engine case. Seed/accept a compiled workflow, persist a
   genuine node Wait, commit both database-owned cancellation and deadline
   facts before a fresh coordinator consumes them, and verify the durable
   checkpoint, node row, run row, events, and absence of an attempt outbox.
   Keep the existing Redis-outage/due-wakeup scenario unchanged; the new case
   may reuse its fixture but must not use its stub `CoordinatorAdvanceEngine`.

No database production file should change for PF-05 unless the integration
test exposes an independent persistence validator defect. Such a defect must
be reported and scoped separately rather than silently widening this item.

### Contracts and invariants

- Precedence remains: truthful unsafe possible dispatch/outcome uncertainty
  first; active running effects remain for reconciliation; for safe
  `pending`/`ready`/purely `waiting` work, cancellation wins over a simultaneous
  deadline; deadline-only waiting work becomes `timed_out`.
- Cancellation-only behavior stays `canceled`. Existing terminal invocations
  are not rewritten, and no terminal state is resurrected.
- Both ordinary and branch/iteration-scoped Waits use the same precedence.
- Settling a Wait removes `resumeAt` and `waitKind`, emits no attempt admission
  or node-run admission, and cannot resume work.
- Preserve deterministic observation/event order, persisted external-event
  handling, event sequence arithmetic, and run terminalization. The expected
  simultaneous derived events are `node.canceled` then `run.canceled`; there
  is no `node.timed_out`.
- Keep loop cancellation semantics, unsafe reconciliation, retry-backoff Wait,
  and the V1/V2 serialized checkpoint parsers unchanged.

### Regression evidence and measurable acceptance

The engine suite must cover both supplied observation orders, persisted and
non-persisted observation windows, cancellation-only, deadline-only,
simultaneous controls, node Wait and retry-backoff Wait, a scoped Wait, already
terminal nodes, a safe running attempt, and an unsafe possibly-dispatched
attempt. Plans, checkpoints, event names/sequences, and admission arrays must
be asserted exactly.

The worker/database case closes the remaining evidence gap only when it shows:
run and node status `canceled`; both facts consumed once; no `node.timed_out`;
no `resume_at`/`wait_kind`; no new `execute-node-attempt` outbox; no extra
attempt; and the same result after coordinator redelivery/fresh runtime.

### Dependencies and verification commands

PF-05 is independent of PF-04 at source level. Run it second so the two P1
correctness changes remain separately reviewable.

```sh
pnpm --filter @pertexo/workflow-engine exec vitest run \
  test/executable-workflow-controls.test.ts \
  test/retry-wait-cancellation.test.ts \
  test/workflow-transition-risk-behavior.test.ts
pnpm --filter @pertexo/workflow-engine typecheck
docker compose up -d --wait postgres redis
WORKER_TRANSPORT_INTEGRATION=true \
  pnpm --filter @pertexo/worker exec vitest run \
  --config vitest.integration.config.ts \
  test/coordinator-consumer-retry-wait.integration.test.ts
```

## PF-01 — retention pre-handoff cleanup short-circuits

**Status:** confirmed, P2 correctness. Deliver together with PF-03 retention
entrypoint evidence, after PF-02's nonthrowing classifier exists.

### Verification basis

`apps/retention/src/main.ts` individually catches rejections from the
asynchronous database/coordinator closers, but calls the synchronous dual-region
artifact and ledger `close()` methods without guards. Both implementations can
throw aggregate errors. An artifact close failure therefore skips ledger and
telemetry cleanup and replaces the initiating acquisition error at the process
fallback. `apps/retention/src/run.ts` already has the correct normal-owner
shape: it attempts every cleanup and aggregates after the worker is invoked.
That owner must not be duplicated in bootstrap.

### Smallest justified change and exact files

- Refactor only the pre-`workerInvoked` failure path in
  `apps/retention/src/main.ts`. Attempt, in current dependency-safe order,
  `enforcement`, `preview`, `runArtifacts`, `workspacePurge`, `database`,
  `databaseRuntime`, `artifacts`, `ledger`, and telemetry. Catch synchronous
  throws and rejected promises, report each cleanup failure best-effort with a
  fixed error classification and resource label, then rethrow the exact
  initiating error.
- Add the exhaustive source-level regression to
  `apps/retention/test/main.test.ts` as part of PF-03. Do not alter
  `apps/retention/src/run.ts` or its existing cleanup tests.

The listed pre-handoff order retains today's order, not the normal worker's
different order. Before handoff none of these coordinators is running; every
coordinator lease must be released before the shared database runtime, and
artifact/ledger clients remain available until their dependents are closed.
Do not mechanically reverse the normal worker's cleanup sequence.

Construct the complete `runRetentionWorker` argument object, including metrics,
**before** setting `workerInvoked=true`. The current flag at main line 110 is
set before metrics creation at line 119: a metric-construction exception skips
all pre-handoff cleanup even though the worker was never called. Test that
case with every already-created resource present. Keep the flag immediately
before the actual invocation after argument construction succeeds.

### Contracts and measurable acceptance

- Fault every acquisition boundary after zero through all resources. Only
  acquired resources are closed, each exactly once, in the declared order.
- Fault every asynchronous close, each synchronous close, artifact and ledger
  together, telemetry shutdown, and cleanup logging. Later cleanup attempts
  still occur and the original object is the rejection observed by the caller.
- Signal listeners are removed on every bootstrap exit.
- When `runRetentionWorker` is invoked, bootstrap performs no owner cleanup on
  success or failure; `run.ts` remains the one normal lifetime owner.
- A successful handoff has no duplicate closes and retains the same worker
  dependency object and signal.

### Verification commands

```sh
pnpm --filter @pertexo/retention exec vitest run \
  test/main.test.ts test/run.test.ts test/config.test.ts
pnpm --filter @pertexo/retention typecheck
```

## PF-02 — hostile error names cross process and structured diagnostics

**Status:** confirmed, P2 hardening. The original audit listed five process
fallbacks. Current repository inspection found a sixth production entrypoint,
`apps/lifecycle-command/src/main.ts`, with the same two raw classifications.
The structural inventory also correctly flags two inner operational log sites.
The complete scope is therefore six mains plus those two sites.

### Smallest justified change and exact files

1. Add the leaf module
   `packages/observability/src/process-error-classification.ts` with one total,
   synchronous function returning only the fixed vocabulary `Error` or
   `NonError`. It may use `instanceof Error` only inside a catch-all guard;
   it must never read `.name`, `.message`, `.code`, properties, prototypes, or
   stringify the input. A throwing proxy/prototype trap returns `NonError`.
2. Export a dedicated
   `@pertexo/observability/process-error-classification` subpath from
   `packages/observability/package.json`, including its browser-false entry.
   Do not add it to the broad root facade or make it import logger/telemetry.
   Extend `packages/observability/test/package-contract.test.ts` to assert the
   exact deep export and browser map, following its transport-metrics test.
   Keep `packages/observability/src/index.ts` unchanged; the existing all-source
   coverage include already picks up the new leaf module.
   Add a Node self-reference case for this exact subpath to
   `infrastructure/validate-built-package-exports.mjs` and assert its presence
   in `infrastructure/validate-built-package-exports.test.mjs`. The validator
   checks an explicit case list, not every export automatically. Keep this
   package's existing browser-map convention; do not assume it has the false
   conditional export used by the validator's other browser-rejection cases.
3. Add
   `packages/observability/test/process-error-classification.test.ts` for
   ordinary/built-in/custom-name errors, every primitive, null, objects with
   throwing `name`/`message`/`code` getters, proxies with throwing
   `getPrototypeOf`/`get` traps, and repeated calls. The function must never
   throw and must never trip a marker getter.
4. Replace both the bootstrap structured metadata and process-fallback
   classification in:

   - `apps/api/src/main.ts`
   - `apps/worker/src/main.ts`
   - `apps/operator-command/src/main.ts`
   - `apps/recovery/src/main.ts`
   - `apps/retention/src/main.ts`
   - `apps/lifecycle-command/src/main.ts`

5. Replace the same raw metadata classification in:

   - `apps/operator-command/src/run.ts`
   - `apps/recovery/src/restore-before-serve.ts`

6. Update/add assertions in:

   - `apps/api/test/main.test.ts`
   - `apps/worker/test/main.test.ts`
   - `apps/operator-command/test/main.test.ts`
   - `apps/operator-command/test/run.test.ts`
   - `apps/recovery/test/main.test.ts`
   - `apps/recovery/test/restore-before-serve.test.ts`
   - `apps/retention/test/main.test.ts`
   - `apps/lifecycle-command/test/main.test.ts`
   - `apps/lifecycle-command/test/process-lifecycle.test.ts`

The lifecycle subprocess expectation must change from the dependency-specific
`ZodError` to fixed `Error`. Event names, levels, exit behavior, and the
structured logger's already-sanitized cause argument remain unchanged.

### Contracts and measurable acceptance

- The only emitted `errorType` values are `Error` and `NonError`; a custom
  error name and marker strings in `name`, `message`, `code`, getters, proxy
  traps, or `toJSON` never appear in stdout, stderr, or structured metadata.
- Classification is total and nonthrowing, so it cannot prevent resource
  cleanup or replace the initiating failure.
- Ordinary errors remain distinguishable from non-Error thrown values without
  exposing subclasses. All existing event names and `level: fatal` fields stay
  exact; failed process startup still sets exit code 1.
- Static loading of the helper does not load the application, logger,
  OpenTelemetry SDK, or exporter before `telemetry.start()`.
- Operational functions still pass the original cause to the structured
  logger's existing sanitizer and preserve their aggregate cleanup behavior.

### Failure reporting must not bypass cleanup

The primary review followed both inner log sites to their resource owners.
Replacing `errorType` alone does not make these paths safe:

| File | Required localized correction | Regression |
| --- | --- | --- |
| `apps/operator-command/src/run.ts` | After capturing the initiating operation error, guard `logger.error` independently so cleanup always executes. Keep the existing bounded database/telemetry cleanup and aggregate ordering. | In `apps/operator-command/test/run.test.ts`, fail an operation and the failure logger together; both close attempts still occur and the aggregate retains the initiating error first. Also combine with each close failure. |
| `apps/recovery/src/restore-before-serve.ts` | Set operation-failure state before diagnostic callbacks. Independently guard the failure metric and error logger so neither can skip coordinator, ledger, artifact, or telemetry cleanup. Preserve the existing aggregate contract and inventory behavior. | In `apps/recovery/test/restore-before-serve.test.ts`, fault failure metrics and logging individually/together after a readiness/inventory failure; verify every close attempt, original error first, and cleanup errors retained. |
| Six `apps/*/src/main.ts` files named above | Guard bootstrap-failure logging and cleanup-failure logging themselves, not just classification. A nonthrowing classifier does not make a logger nonthrowing. Preserve the exact initiating rejection and continue every acquired-resource cleanup attempt. | In each owning `main.test.ts`, make `fatal` throw after an acquisition failure; make cleanup `error` logging throw after a close failure. Neither secondary diagnostic failure may stop cleanup or replace the original cause. |

Local fake-dependency probes reproduced both inner failures: an operator error
logger replaced the initiating error and skipped database/telemetry cleanup;
a recovery failure metric replaced the initiating error and skipped all four
closers. These are failure-path reproductions, not claims of a production
incident. Do not change the structured logger globally or invent a new logging
framework to fix these callers.

### Dependencies and verification commands

Implement the helper first. Apply it while extracting/testing the five PF-03
bootstraps so no temporary test asserts the unsafe vocabulary. PF-01 uses the
same helper for cleanup-failure metadata.

```sh
pnpm --filter @pertexo/observability exec vitest run \
  test/process-error-classification.test.ts test/package-contract.test.ts test/telemetry.test.ts
pnpm --filter @pertexo/observability build
pnpm built-exports:check
pnpm --filter @pertexo/observability typecheck
pnpm --filter @pertexo/operator-command exec vitest run test/run.test.ts test/main.test.ts
pnpm --filter @pertexo/recovery exec vitest run test/restore-before-serve.test.ts test/main.test.ts
pnpm --filter @pertexo/lifecycle-command exec vitest run test/main.test.ts test/process-lifecycle.test.ts
```

## PF-03 — execute the real app-owned entrypoint orchestration

**Status:** confirmed for API, worker, operator-command, recovery, and
retention. Lifecycle-command already has an exported injectable bootstrap,
direct tests, an ESM guard, and a compiled subprocess suite. Reuse that test
shape, but do not label its cleanup behavior resolved: it has the same
metrics-before-handoff defect and unguarded failure logging.

### Verified evidence gap

`api-bootstrap.test.ts` imports `src/app.ts`; it does not execute API main.
`worker-process-lifecycle.fixture.mjs` imports `dist/app.js` and
`WorkerProcessShutdown`, not worker main. Operator-command, recovery, and
retention have config/run tests but no main tests. Their mains own config
parsing, telemetry-before-import order, partial acquisition cleanup, signal
listeners, handoff flags, and terminal process formatting, so adjacent tests
cannot prove them.

### Smallest justified source changes

For each of the five mains below, keep the entire app-specific orchestration in
that file but make it import-safe and injectable in the same style as
lifecycle-command:

- `apps/api/src/main.ts`: export `bootstrapApi`; accept optional config,
  telemetry factory, and module loader. Retain `listen({host, port})`, startup
  logging, close-on-failure, and telemetry shutdown.
- `apps/worker/src/main.ts`: export `bootstrapWorker`; accept optional config,
  telemetry factory, module loader, and shutdown-owner factory. Preserve
  `WorkerProcessShutdown.install()` as the owner after application creation.
- `apps/operator-command/src/main.ts`: export `bootstrapOperatorCommand`;
  accept optional config, telemetry factory, module loader, and narrow process
  object. Preserve abort signal composition, stdout result, listener removal,
  and `commandInvoked` handoff.
- `apps/recovery/src/main.ts`: export `bootstrapRecovery`; accept optional
  config, telemetry factory, module loader, and narrow process object. Preserve
  acquisition order, abort timeout, sync artifact/ledger cleanup guards, and
  `recoveryInvoked` handoff.
- `apps/retention/src/main.ts`: export `bootstrapRetention`; accept optional
  config, telemetry factory, module loader, metrics factory, and narrow process
  object. Preserve the shared database runtime, signal ownership,
  `workerInvoked` handoff, and implement PF-01 only in its pre-handoff cleanup.

Additional exact ownership corrections, required by this review:

| File | Change and acceptance |
| --- | --- |
| `apps/recovery/src/main.ts` | Construct metrics and the complete restore argument object before `recoveryInvoked=true`. A metrics exception must leave the flag false and close the coordinator, ledger, artifacts and telemetry. |
| `apps/retention/src/main.ts` | Construct metrics and the full worker argument object before `workerInvoked=true`; apply the PF-01 close matrix to this failure. |
| `apps/lifecycle-command/src/main.ts` | Construct metrics and the full worker argument object before `workerInvoked=true`. Extend the existing injectable seam; do not create another bootstrap. On metrics failure clear readiness, close coordinator/ledger/telemetry, remove listeners, and preserve the original error. |
| `apps/operator-command/src/main.ts` | Construct the timeout/composed signal and full command arguments before `commandInvoked=true`; only the actual command invocation transfers cleanup ownership. Keep valid timeout configuration and ordinary command behavior unchanged. |
| `apps/lifecycle-command/test/main.test.ts` | Add metrics-construction and throwing-failure-logger cases; assert zero worker invocations, exact acquired-resource cleanup and listener removal. Existing invoked-worker rejection must still avoid duplicate cleanup. |
| `apps/lifecycle-command/test/lifecycle-command-process.fixture.mjs` | Add a bounded metrics-failure mode using the real compiled exported bootstrap and fake dependencies; do not copy the algorithm. |
| `apps/lifecycle-command/test/process-lifecycle.test.ts` | Assert the metrics-failure child never reports worker activation and does report readiness/coordinator/ledger/telemetry cleanup, with a bounded exit. Preserve the existing real-entrypoint invalid-config test. |

The primary reviewer reproduced lifecycle metrics failure through its exported
bootstrap with validated configuration and injected dependencies: the worker
was never invoked and only telemetry start/fatal logging ran; none of its
resource closers ran. Recovery and retention contain the same ordering.

#### Worker signal owner and telemetry owner

Test the real cleanup owners, not only a fake `close`/`shutdown` supplied to a
main test:

- `apps/worker/src/main.ts`: retain the constructed shutdown owner. If a
  subsequent install/startup-log step fails, close through that owner; use
  direct application close only when owner construction never returned. This
  prevents bypassing the owner's signal-listener cleanup or starting a second
  application close.
- `apps/worker/src/runtime/worker-process-shutdown.ts`: allow `close()` without
  an OS signal for startup rollback, while preserving `SIGINT`/`SIGTERM` on real
  signal paths. Cache one promise before invoking application close; convert
  synchronous close throws into that promise, guard failure logging, and
  always uninstall listeners. Make partial `install()` failure roll back the
  first registration before rethrowing. No public generic lifecycle manager
  or second application-close owner is needed.
- `apps/worker/test/worker-process-shutdown.test.ts`: cover partial install,
  synchronous close throw, rejected close plus throwing error logger, startup
  close without a signal, repeated closes and both signals. Preserve exact
  one-close behavior and listener removal. The signal callback must not leave
  an unhandled rejection when diagnostics fail.
- `packages/observability/src/telemetry.ts`: distinguish a never-started SDK
  from one whose start was attempted and failed. The latter must receive one
  cleanup attempt; the former retains its current no-SDK-shutdown contract.
  Cache a promise before invoking SDK shutdown, including synchronous throws,
  so repeated calls do not retry shutdown. Keep successful-start idempotence,
  disabled telemetry, instrumentation/sanitization and no restart after stop.
- `packages/observability/test/telemetry.test.ts`: use the SDK factory seam to
  prove failed-start cleanup, original start-error identity, synchronous and
  asynchronous shutdown failure caching, and identical returned shutdown
  promises. A failed start is terminal until shutdown; do not silently retry
  partially initialized SDK startup.

Local probes observed zero SDK shutdown calls after a thrown SDK start, two
calls after repeated synchronously throwing shutdown, and a worker close
promise rejected with the logger's error. These tests must prove the corrected
owner behavior before main-level tests can claim cleanup coverage.

API and worker Nest applications already call telemetry shutdown from
`TelemetryShutdown.onApplicationShutdown`. Their bootstrap fallback can also
call the same idempotent lifecycle. Assert one underlying SDK cleanup effect,
not an artificial global one-call limit on that shared lifecycle method.
Do not remove the fallback needed when application shutdown fails before the
Nest telemetry hook runs. Application-returned aggregate errors remain intact:
the bootstrap preserves the error it received rather than unwrapping it.

Each of the five newly injectable mains must add an ESM
`fileURLToPath(import.meta.url) === process.argv[1]`
guard around its existing terminal catch. Imports in unit tests must not run
the process entrypoint. Keep each default module loader adjacent to its
bootstrap so telemetry starts before the same dynamic imports as today.

### Exact test files

Add direct source tests:

- `apps/api/test/main.test.ts`
- `apps/worker/test/main.test.ts`
- `apps/operator-command/test/main.test.ts`
- `apps/recovery/test/main.test.ts`
- `apps/retention/test/main.test.ts`

Add isolated compiled-process tests and fixtures without centralizing a
cross-app lifecycle framework:

- `apps/api/test/api-main-process.fixture.mjs`
- `apps/api/test/main-process.test.ts`
- `apps/worker/test/worker-main-process.fixture.mjs`
- `apps/worker/test/main-process.test.ts`
- `apps/operator-command/test/operator-main-process.fixture.mjs`
- `apps/operator-command/test/main-process.test.ts`
- `apps/recovery/test/recovery-main-process.fixture.mjs`
- `apps/recovery/test/main-process.test.ts`
- `apps/retention/test/retention-main-process.fixture.mjs`
- `apps/retention/test/main-process.test.ts`

The fixture may import and call the compiled exported bootstrap with controlled
app-owned dependencies. It must not copy the bootstrap algorithm. A separate
invalid-config mode must spawn the actual `dist/main.js` so the real
main-module guard, terminal catch, fixed PF-02 formatter, and exit code execute.
For worker/operator/recovery/retention active modes, use the real child process
as the default process dependency, send actual `SIGINT` and `SIGTERM`, and let
the injected run/application owner record cleanup and exit. API has no
main-owned signal listener; its process evidence instead covers invalid config
and listen failure.

No existing `api-bootstrap.test.ts`, `worker-bootstrap.test.ts`, or worker
application/shutdown process fixture should be repurposed or deleted: those
test different owners.

### Per-app regression matrix and acceptance

Every direct bootstrap suite must cover invalid supplied/default config as
applicable, telemetry start throw, module import failure, logger construction
failure, each sequential resource acquisition failure, cleanup failure,
successful handoff, and invoked-owner rejection. Assert call order, original
error identity, exactly-once cleanup, and no pre-start instrumented imports.
API additionally covers listen rejection. Worker covers shutdown-owner
construction/install failure. The three command/maintenance apps cover both
signals and listener removal on all exits. Retention covers the full PF-01
fault matrix.

Every compiled process suite must have bounded startup/shutdown timeouts and
force-kill cleanup. Acceptance is: actual main invalid config exits 1 with one
fixed event and no input marker; injected active children observe both signals
and close exactly once; successful command output stays valid JSON; no child
hangs or retains a listener/handle after cleanup.

### Required coverage plumbing — not an optional fallback

The primary review found that `owner-suite-source-mapped` is not measured
coverage. The generator retains such a main in
`unmeasuredRunnableEntrypoints`. API and worker's current coverage configs
exclude their mains; the other three apps have no coverage command. Add these
five disjoint, app-owned cohorts as part of PF-03:

| New config | Cohort/output directory under root `coverage/` | Exact measured source |
| --- | --- | --- |
| `apps/api/vitest.entrypoints-coverage.config.ts` | `api-entrypoints` | `src/main.ts` |
| `apps/worker/vitest.entrypoints-coverage.config.ts` | `worker-entrypoints` | `src/main.ts` |
| `apps/operator-command/vitest.entrypoints-coverage.config.ts` | `operator-command-entrypoints` | `src/main.ts` |
| `apps/recovery/vitest.entrypoints-coverage.config.ts` | `recovery-entrypoints` | `src/main.ts` |
| `apps/retention/vitest.entrypoints-coverage.config.ts` | `retention-entrypoints` | `src/main.ts` |

Each config runs its direct `test/main.test.ts` matrix with V8 and emits
`coverage-final.json`, `coverage-summary.json`, and a passing JSON test report.
Give each app a `test:coverage:entrypoints` script in its `package.json`, using
the same JSON reporter/output-file convention as the existing cohorts. Add
all five script invocations to root `package.json`'s `test:coverage` before the
risk report. Keep existing API/worker cohorts unchanged and disjoint; do not
claim child-process counters as parent Vitest coverage.

In `infrastructure/generate-coverage-evidence.mjs`, add all five names to
`SOURCE_COVERAGE_COHORTS`. In its `.test.mjs`, assert the exact new cohort list
and prove that a test-mapped but uncovered main remains unmeasured, whereas
a main present in a valid cohort is `measured-runtime`.

In `infrastructure/report-risk-coverage.mjs`, add all five names to
`RISK_COVERAGE_COHORTS` and strict policies. Add exact required main-file
inventories, following the existing lifecycle-command inventory check, so
missing/empty reports cannot silently pass. Extend
`infrastructure/report-risk-coverage.test.mjs` for missing cohorts, missing or
unexpected source, failed test reports, and new unreviewed branches. Require
all reachable fault-matrix branches to execute; a percentage threshold is not
a substitute for this branch-by-branch acceptance. Add one
`test/entrypoints-coverage-config.test.ts` in each of the five apps to pin the
source include, direct-suite selection, and distinct report directory.

Retain `apps/lifecycle-command/vitest.coverage.config.ts`: it already measures
that main. Its expanded fault tests must refresh that cohort. Existing worker
shutdown and observability telemetry tests continue in their current cohorts.

After the tests pass, run all coverage and `pnpm coverage:evidence`.
Regenerated `docs/remaining-work/source-inventory.json` must classify all five
mains as `measured-runtime`, map their owner suites, and remove them from
`unmeasuredRunnableEntrypoints`;
`docs/remaining-work/risk-snapshot.json` must match the freshly generated risk
report. If any main remains unmeasured or unmapped, PF-03 remains open; do not
hand-edit evidence or weaken the generator's classification. Update
`infrastructure/risk-coverage-reviews.json` only
for genuinely unreachable/defensive residual branches, with fresh source
fingerprints—never to classify an executable failure path away.

### Dependencies and verification commands

PF-02's helper comes first; PF-01 is completed inside retention's PF-03 seam.
Use lifecycle-command only as an example and regression oracle.

```sh
pnpm --filter @pertexo/api build
pnpm --filter @pertexo/api exec vitest run test/main.test.ts test/main-process.test.ts test/api-bootstrap.test.ts
pnpm --filter @pertexo/worker build
pnpm --filter @pertexo/worker exec vitest run test/main.test.ts test/main-process.test.ts test/worker-bootstrap.test.ts test/worker-process-lifecycle.test.ts test/worker-process-shutdown.test.ts
pnpm --filter @pertexo/operator-command build
pnpm --filter @pertexo/operator-command exec vitest run test/main.test.ts test/main-process.test.ts test/run.test.ts
pnpm --filter @pertexo/recovery build
pnpm --filter @pertexo/recovery exec vitest run test/main.test.ts test/main-process.test.ts test/restore-before-serve.test.ts
pnpm --filter @pertexo/retention build
pnpm --filter @pertexo/retention exec vitest run test/main.test.ts test/main-process.test.ts test/run.test.ts
pnpm --filter @pertexo/lifecycle-command exec vitest run test/main.test.ts test/process-lifecycle.test.ts
pnpm typecheck
pnpm test:coverage
pnpm coverage:evidence
```

## PF-06 — repeated workflow scans/private indexing candidates

**Status:** conditional, P3 performance/structure. Repeated work is confirmed;
no latency or memory regression is measured. Do not implement either candidate
until its own gate passes.

### Verified candidates

Candidate A is local to
`packages/workflow-engine/src/coordinator-observations.ts`:

- successful invocations are grouped with `[...group, invocation]`, causing
  quadratic copying for a large group;
- every active loop ordinal scans checkpoint invocations; and
- every merge branch searches all edges and filters all projected invocations.

Candidate B is the per-advance scheduler lookup in
`packages/workflow-engine/src/workflow-transition-state.ts`. Its
`schedulerNodeSideEffectClass` and `schedulerNodeDisabled` helpers repeatedly
flatten root/structured nodes and linearly search them. Current callers are
`workflow-transition-plan.ts` and `workflow-transition-derived.ts`; the state
is initialized in `advance-workflow.ts`.

`node-attempt-input.ts` and `checkpoint-executable-validation.ts` also perform
bounded graph/scope lookups, but they run on different operation paths. They
are comparison data, not authorized edits. The compiler validation index is a
separate private owner and must not become a cross-run cache.

### Measurement phase — exact files

Before a production edit:

1. Add
   `packages/workflow-engine/benchmarks/workflow-transition-scans.mjs`, a
   deterministic runner against built public operations/testing seams. Include
   warm-up plus at least 30 measured samples for small, representative, and
   configured-limit shapes. Record Node version, CPU/platform, source revision
   or dirty-tree hash, scenario/input checksums, iteration count, median, p95,
   max RSS, heap delta, and output/error checksum as JSON.
2. Add `benchmark:structural` to
   `packages/workflow-engine/package.json`; output goes under ignored
   `coverage/`, never into a source module.
3. Add
   `packages/workflow-engine/test/structural-scan-characterization.test.ts`
   and
   `packages/workflow-engine/test/fixtures/structural-scan-characterization.json`.
   Freeze exact plan/event/admission/error checksums for duplicate and
   conflicting facts, nested branch/iteration scopes, stale loops, joins,
   merges, disabled nodes, and missing scheduler nodes.

Use valid graphs at `WORKFLOW_GRAPH_CONTRACT_LIMITS`—1,000 total nodes, 4,000
edges, 1,000 loop iterations—and representative lower populations. Do not
create a nominal “1,000-node” fixture that exceeds aggregate structured limits.
Capture CPU profiles for the configured-limit merge and loop scenarios in
separate fresh processes. Baseline and candidate must use the same runtime,
host load policy, sample count, inputs, and runner.

### Selection threshold

Select a candidate only if all characterizations are identical and, in two
independent runs, its affected configured-limit scenario improves both median
and p95 by at least 20%, while max RSS grows by no more than 10% and no more
than 16 MiB. CPU profiles must attribute the baseline cost to the named scan or
array-copy sites and show the selected cost reduced. A lower operation-count
curve (quadratic to linear or repeated flatten/search to one construction plus
lookup) is required in addition to wall-clock timing. If the threshold is not
met or profiles point elsewhere, record the results in this plan and retain
the current code.

### Candidate A implementation, only if selected

Change only `coordinator-observations.ts` and its focused tests. Accumulate
groups in mutable local arrays during construction, then expose them as
readonly; pre-index terminal invocations by iteration-scope identity; pre-index
merge incoming edges by target/port and projected invocations by scope. Keep
all indexes local to one coordinator-observation derivation. Preserve insertion
and ordinal ordering, duplicate/conflict detection, first-match behavior,
missing-branch disposition, scope-prefix semantics, and exact error codes.

Candidate A regression owners are:

- `packages/workflow-engine/test/executable-workflow-foreach.test.ts`
- `packages/workflow-engine/test/executable-workflow-foreach-part-2.test.ts`
- `packages/workflow-engine/test/executable-workflow-branching.test.ts`
- `packages/workflow-engine/test/parallel-output-assurance.test.ts`
- `packages/workflow-engine/test/operation-risk-branches.test.ts`
- the new characterization and benchmark files.

### Candidate B implementation, only if independently selected

Add one private `schedulerNodeById` map to the in-memory
`MutableWorkflowTransition`, built once in `advance-workflow.ts` and consumed
by the two helpers in `workflow-transition-state.ts`. Adjust the callers in
`workflow-transition-plan.ts` and `workflow-transition-derived.ts` only as
required by that private state shape. Do not place the map in a persisted
checkpoint, executable, public type, module cache, or cross-run cache. Duplicate
node behavior and missing-node fail-closed errors must be characterized before
construction; disabled and side-effect values must be identical.

Preserve the distinct lookup contracts: side-effect lookup throws when the
graph or node is missing; disabled lookup returns false. Both existing
flatten-and-find helpers use the **first** matching node. A plain `new Map`
over duplicates would instead choose the last node. Build first-wins or prove
duplicates rejected at every supported seam and retain that rejection. Do not
reuse `boundedReadyAdmissions`' different map without preserving its semantics.

Candidate B exact production files are therefore:

- `packages/workflow-engine/src/advance-workflow.ts`
- `packages/workflow-engine/src/workflow-transition-state.ts`
- `packages/workflow-engine/src/workflow-transition-plan.ts`
- `packages/workflow-engine/src/workflow-transition-derived.ts`

Its regression owners are `scheduler-projection.test.ts`,
`advance-workflow-transitions.test.ts`, `workflow-transition-risk-behavior.test.ts`,
and the new characterization/benchmark files. Do not combine A and B into one
change merely because both pass independently; compare each incremental delta.

### Verification commands

```sh
pnpm --filter @pertexo/workflow-engine build
pnpm --filter @pertexo/workflow-engine benchmark:structural -- \
  --output ../../coverage/pf06-baseline.json
pnpm --filter @pertexo/workflow-engine exec vitest run \
  test/structural-scan-characterization.test.ts \
  test/executable-workflow-foreach.test.ts \
  test/executable-workflow-foreach-part-2.test.ts \
  test/executable-workflow-branching.test.ts \
  test/parallel-output-assurance.test.ts \
  test/scheduler-projection.test.ts \
  test/advance-workflow-transitions.test.ts \
  test/operation-risk-branches.test.ts \
  test/workflow-transition-risk-behavior.test.ts
pnpm --filter @pertexo/workflow-engine typecheck
```

## PF-07 — evaluator context accessor contract

**Status:** conditional, P3 contract investigation. Current worker isolation is
not broken and no production HTTP exploit is established.

### Verification basis

`projectExpressionContext` checks that the context owns `runInput` and
`nodeOutputs`, then reads those two properties while constructing the value
passed to `canonicalizeJson`. A hostile top-level getter therefore executes on
the host. The evaluator catches its exception before queue admission, so no
worker is created. Once a top-level data descriptor is obtained,
`canonicalizeJson` already walks arrays/objects with property descriptors and
rejects nested accessors without invoking them.

Production call chains normalize or validate JSON before evaluation:

- `packages/workflow-engine/src/operations.ts` normalizes run input/completed
  outputs and calls `resolveValueSource`;
- `packages/workflow-model/src/mapping.ts` forwards the mapping context in the
  evaluator request; the policy projector, not mapping, restricts exposure to
  the two fields (mapping context may also contain `structuredInputs`);
- API node testing validates parsed draft/sample JSON through
  `apps/api/src/node-testing/{use-case,validation}.ts`;
- API runtime composition and worker preview/attempt runtimes only construct
  `JsonataEvaluator` instances and pass those normalized operation inputs.

The exported `ExpressionEvaluator` interface in
`packages/workflow-model/src/expressions/policy.ts` is nevertheless a supported
direct seam and tests/injected adapters call it. The type says JSON, but current
runtime behavior deliberately accepts `unknown` values defensively. That is
why the desired hostile-object guarantee must be explicit before changing it.

### Contract gate

Before implementation, record one of these mutually exclusive decisions in
this plan with an owner/date and evidence:

1. **No-accessor evaluator boundary.** The public evaluator guarantees that no
   accessor anywhere in the supplied context executes. This is recommended if
   the defensive `unknown` runtime boundary is intended to protect direct
   adapters as well as HTTP callers.
2. **Canonical-JSON-only boundary.** Hostile JavaScript objects are explicitly
   outside the public contract; production normalization plus worker isolation
   is sufficient. In this case PF-07 becomes unsupported as an implementation
   task and closes with contract documentation only.

Required evidence is an exhaustive repo consumer search, the package's private
publication status, direct-adapter owner review, and a probe showing worker
creation count and getter markers for top-level and nested accessors. Do not use
the absence of an HTTP exploit alone to choose the weaker contract.

### Smallest implementation if no-accessor is selected

Change only
`packages/workflow-model/src/expressions/policy.ts` and
`packages/workflow-model/test/expressions.test.ts`. In
`projectExpressionContext`, obtain own descriptors for `runInput` and
`nodeOutputs`; reject absent/accessor descriptors before reading their `.value`
fields; then pass those values to the existing accessor-safe
`canonicalizeJson`. Wrap the entire reflection/extraction/canonicalization
operation in a local catch that throws a fresh native `TypeError` with one
constant non-sensitive message, such as `invalid expression context`. Never
inspect or rethrow the hostile caught value. This matters because the current
evaluator catch uses `cause instanceof Error` and `cause.message`: a descriptor
trap can throw another hostile proxy and make that catch itself reject.
The policy-local normalization keeps the two-file implementation sufficient
and the evaluator's stable `evaluation_failed` result intact.
No evaluator lifecycle, worker runtime, graph normalization, mapping, or
production caller needs modification.

Acceptance: top-level and nested getter/setter contexts execute zero accessors,
create zero workers, and return the exact stable failure; proxy descriptor or
prototype traps, including traps throwing hostile proxies or revoked proxies,
produce the same resolved error result and create zero workers. Reflection can
execute proxy traps; this is not a promise to sandbox arbitrary JavaScript or
terminate a non-returning trap. Ordinary null-prototype and
plain JSON contexts produce identical values/checksums; context projection
still exposes only `runInput` and `nodeOutputs`; input limits, cancellation,
queue capacity, timeout, shutdown, and restart tests are unchanged.

### Smallest change if canonical-JSON-only is selected

Add an explicit JSDoc contract beside `ExpressionContextV1`/
`ExpressionEvaluator` in `policy.ts`, and add a normal canonical-JSON boundary
test in `expressions.test.ts`. Do not add a test that blesses executing hostile
getters. Record PF-07 as unsupported for implementation in this checklist.

### Verification commands

```sh
rg -n "JsonataEvaluator|ExpressionEvaluator|\.evaluate\(" packages apps
pnpm --filter @pertexo/workflow-model exec vitest run \
  test/expressions.test.ts test/mapping.test.ts test/package-contract.test.ts
pnpm --filter @pertexo/workflow-model typecheck
pnpm built-exports:check
```

## WF-S01 — dead `stop_scheduling` cancellation-decision variant

**Status:** conditional, P3 interface cleanup.

### Verification basis

`packages/workflow-engine/src/runtime.ts` declares
`CancellationDecision.kind = 'stop_scheduling'`, but `decideCancellation`
returns only `outcome_unknown`, `await_reconciliation`, or `canceled`. The
helper and type are exported only through the server-only
`@pertexo/workflow-engine/testing` facade. Repository-wide source search finds
test consumers only; no production adapter imports or produces the dead value.
The package is currently private, but the testing subpath is an intentional
built export, so narrowing its declaration still requires a compatibility
gate.

### Compatibility gate and smallest change

Confirm all of the following before recommending removal:

- the live source/test consumer search, built-output search, package export
  validator, and workspace dependency graph have no consumer requiring
  `stop_scheduling` (the defining union and historical audit prose are not
  consumers);
- no supported out-of-repository fixture or release-qualification harness
  consumes the private testing declaration; and
- a generated declaration diff shows only removal of the impossible union
  member, with no production entrypoint change.

If the gate passes, delete the one union member from
`packages/workflow-engine/src/runtime.ts`. `testing.ts` continues to re-export
the narrowed type and needs no source edit. Add a compile-time exhaustive
consumer assertion to
`packages/workflow-engine/test/retry-wait-cancellation.test.ts`; keep behavior
assertions in `expanded-public-boundary-coverage.test.ts` and the testing-facade
assertion in `executable-workflow-foreach-part-2.test.ts`.

If a supported consumer exists, retain the member, document that exact consumer
beside the type, and add a compile-time compatibility test for that consumer's
actual use, not a runtime test requiring the dead value to be produced. Do not
invent a production branch or make `decideCancellation` return a semantically
false value merely to populate the union.

### Invariants and acceptance

Cancellation ordering remains unsafe running possible dispatch ->
`outcome_unknown`, other running/waiting work -> `await_reconciliation`, and no
active work -> `canceled`. Production transition ownership stays in the normal
engine; the testing helper does not become a second state machine. Acceptance
is zero live source/type occurrences of the dead member and no built export
declaration exposing it after a passing compatibility gate. Historical plans,
audit records, and a negative compatibility assertion may still name it.
Require unchanged runtime results, a clean declaration build, and
passing built export validation.

```sh
rg -n "stop_scheduling|CancellationDecision|decideCancellation" . \
  --glob '!node_modules/**'
# After building, explicitly search ignored declarations too:
rg --no-ignore -n "stop_scheduling|CancellationDecision" packages/workflow-engine/dist --glob '*.d.ts'
pnpm --filter @pertexo/workflow-engine exec vitest run \
  test/retry-wait-cancellation.test.ts \
  test/expanded-public-boundary-coverage.test.ts \
  test/executable-workflow-foreach-part-2.test.ts \
  test/package-contract.test.ts
pnpm --filter @pertexo/workflow-engine build
pnpm --filter @pertexo/workflow-engine typecheck
pnpm built-exports:check
```

## Primary-agent file-by-file review ledger

This is the primary agent's own plan-impact review, not a delegation result or
a claim to have re-audited every line of the repository. It covers all eight
items, their proposed edit surfaces, callers, test seams, and acceptance
plumbing. Production edit candidates were read directly; test-only head
updates were checked at their exact literals/list context, and retained
regression suites were checked for the relevant contracts. `NEW` means a
specified file to create during implementation, not an existing file that was
read or a test that already passed. `KEEP` means no edit is justified by this
plan, not that the file has no possible defects.

### Database: PF-04

Paths in the first column are relative to `packages/database/`.

| File | Primary review result / implementation disposition |
| --- | --- |
| `migrations/0057_workspace_tenant_rows_purge.sql` | KEEP published history. Read the bounded purge function, table order, residual scan and grants; its table inventory lacks rerun requests. Copy only the function into the new migration. |
| `migrations/0066_operator_maintenance_rerun.sql` | KEEP published history. Request rows survive completion and have no target/workspace deletion cascade; both supported target types require explicit purge disposition. |
| `migrations/0063_operator_execution_recovery.sql` | KEEP. Evidence table's attempt FK is a genuine cascade; populate it in the regression, not a redundant purge-table edit. |
| `migrations/0065_operator_run_replay.sql` | KEEP. Replay rows have run/version ownership cascades; prove them with valid fixture rows. |
| `migrations/0087_workspace_maintenance_rerun_purge.sql` | NEW. Exact signature/security/body preservation except the added ordered table; no preserved-list escape hatch. Recheck the head before assigning this filename if another migration lands first. |
| `migrations/migration-execution-plan.json` | EDIT `transactionalThrough`; leave online exceptions unchanged. |
| `src/platform/readiness.ts` | EDIT only `EXPECTED_MIGRATION_HEAD`. Existing compatibility function hashes do not describe the purge function and must not be rewritten. |
| `test/serving-readiness.test.ts` | EDIT the exact head assertion; other tests already use the shared constant. |
| `test/workspace-tenant-rows-purge-migration.test.ts` | KEEP historical `0057` SQL-shape expectations. |
| `test/workspace-maintenance-rerun-purge-migration.test.ts` | NEW. Pin signature, security/grants, holds/fences, page bounds and residual fail-closed behavior in `0087`; compare the replaced body to `0057` with only the intended inventory delta. |
| `test/workspace-maintenance-rerun-purge-migration.integration.test.ts` | NEW. Exact prior-head upgrade, four valid request combinations, page-size-one resume, isolation, real cascades, holds/fences and retained global commands. |
| `test/workspace-purge-foundation.integration.test.ts` | EDIT. Existing memory ledger/object-store fixtures and real SQL support a coordinator regression. Add operator CONNECT if used; drive `processNext`, not only SQL pages. Preserve the existing held-step and cancellation cases. |
| `test/support/artifact-migration-fixture.ts` | KEEP/reuse. Cutoff is exclusive; `'0087_'` copies through `0086`. |
| `test/support/disposable-database.ts` | KEEP/reuse. Explicit database/role allowlist and disconnected teardown; no forced broad database cleanup. |
| `test/fixtures/migration-history-v1.json` | EDIT append the new head; preserve every historical entry. |
| `test/support/control-ledger-coordinator.integration.support.ts` | EDIT expected migration list append only. |
| `test/oidc-browser-binding-migration.integration.test.ts` | EDIT expected remaining-migrations list append only; preserve its prior cutoff. |
| `test/artifact-finalization-retention-deadline-migration.integration.test.ts` | EDIT expected remaining-migrations list append only. |
| `test/artifact-media-type-http-safety-migration.integration.test.ts` | EDIT expected remaining-migrations list append only; preserve its repair scenario. |
| `test/webhook-trigger-prior-head.integration.test.ts` | EDIT expected remaining-migrations list append only. |
| `test/published-migration-repair.integration.test.ts` | EDIT expected remaining-migrations list append only; no historical repair rewrite. |
| `test/schedule-claim-migration.integration.test.ts` | EDIT expected remaining-migrations list append only. |
| `test/coordinator-run-store-migrations.integration.test.ts` | EDIT both current-head assertions and expected migration list; preserve historical checkpoint scenarios. |
| `test/compatibility-release.integration.test.ts` | EDIT current-head result literals only, including all four occurrences. |
| `test/connections-compatibility.integration.test.ts` | EDIT both current-head result literals only. |
| `test/connections-concurrency-security.integration.test.ts` | EDIT both current-head result literals only. |
| `test/coordinator-run-store-observations.integration.test.ts` | EDIT current-head result literal only. |
| `test/execution-value-persistence.integration.test.ts` | EDIT current-head result literal only. |
| `test/rls.integration.test.ts` | EDIT current-head result literal; retain incompatible-head rejection and isolation tests. |
| `test/schedule-triggers.integration.test.ts` | EDIT current-head result literal only. |
| `test/webhook-triggers.integration.test.ts` | EDIT current-head result literal only. |
| `test/operator-attempt-reclaim-state-migration.test.ts` | KEEP its `0086` filename: it tests that historical repair, not the current head. |
| `test/readiness-probe.test.ts` | KEEP its synthetic `0081` row/expected-input pair; it is not a stale production-head assertion. |
| `test/migration-execution-plan.test.ts` | KEEP/run dynamic execution-plan validation after head advancement. |

The exact-head search was checked across all database source/tests, not just
the files initially named in the finding. Do not mechanically replace every
occurrence of `0086` or older migration names. Database production ownership,
transaction helpers and the workspace-purge coordinator remain KEEP.

### App/resource owners: PF-01, PF-02, PF-03

| Exact file | Primary review result / implementation disposition |
| --- | --- |
| `apps/api/src/main.ts` | EDIT import-safe bootstrap, fixed diagnostics and guarded failure cleanup; preserve telemetry-before-import and listen behavior. |
| `apps/api/src/app.ts` | KEEP. Application acquisition/close remains its own owner; bootstrap must not duplicate internal resource handling. |
| `apps/api/test/api-bootstrap.test.ts` | KEEP/run. It imports app, not main; cannot substitute for new main evidence. |
| `apps/worker/src/main.ts` | EDIT injectable bootstrap and retained shutdown owner; rollback through it after install/start-log failure. |
| `apps/worker/src/app.ts` | KEEP. Application owns execution runtime close; do not move it into main. |
| `apps/worker/src/runtime/worker-process-shutdown.ts` | EDIT cached sync/async close, guarded diagnostic and partial-listener-install rollback. A direct probe left one SIGINT listener after SIGTERM registration failed. |
| `apps/worker/test/worker-process-shutdown.test.ts` | EDIT real-owner fault matrix; do not test only a stub owner in main tests. |
| `apps/worker/test/worker-process-lifecycle.fixture.mjs` | KEEP. It imports compiled app and shutdown owner, not main; preserve its existing lifecycle evidence. |
| `apps/worker/test/worker-process-lifecycle.test.ts` | KEEP/run existing real signal/process regression. |
| `apps/worker/test/worker-bootstrap.test.ts` | KEEP/run app bootstrap regression independently of new main tests. |
| `apps/operator-command/src/main.ts` | EDIT bootstrap/process injection, fixed diagnostics, listener cleanup and arguments-before-handoff. |
| `apps/operator-command/src/run.ts` | EDIT only failure reporting/classification so it cannot bypass bounded close attempts or original-first aggregates. |
| `apps/operator-command/test/run.test.ts` | EDIT existing cleanup/error suite for throwing logger plus original failure and close failures. |
| `apps/recovery/src/main.ts` | EDIT bootstrap/process injection; metric/argument construction must precede ownership transfer. |
| `apps/recovery/src/restore-before-serve.ts` | EDIT failure-state assignment/reporting guards; retain ordered readiness and four-owner aggregate cleanup. |
| `apps/recovery/test/restore-before-serve.test.ts` | EDIT metric/logger failure combinations alongside current readiness/cleanup tests. |
| `apps/retention/src/main.ts` | EDIT full PF-01 acquisition/close matrix and PF-03 handoff ordering; all acquired resources stay reachable on metrics failure. |
| `apps/retention/src/run.ts` | KEEP. Existing invoked-worker owner already catches synchronous closes and accumulates cleanup failures. |
| `apps/retention/test/run.test.ts` | KEEP/run normal-owner regression; do not assert bootstrap ownership after invocation. |
| `apps/retention/src/metrics.ts` | KEEP. Factory is a possible throwing boundary; inject/fault it from main rather than redesign metrics. |
| `apps/lifecycle-command/src/main.ts` | EDIT existing seam, metrics-before-handoff and guarded diagnostics; not a new exported bootstrap. |
| `apps/lifecycle-command/test/main.test.ts` | EDIT acquired-resource metrics failure and throwing diagnostics; retain worker-rejection no-double-close case. |
| `apps/lifecycle-command/test/lifecycle-command-process.fixture.mjs` | EDIT bounded metrics-failure mode using compiled bootstrap. |
| `apps/lifecycle-command/test/process-lifecycle.test.ts` | EDIT fixed Error classification and new child mode; retain signal/invalid-config cases. |
| `packages/observability/src/process-error-classification.ts` | NEW leaf, fixed two-value vocabulary, total classification; no logger/exporter imports. |
| `packages/observability/test/process-error-classification.test.ts` | NEW hostile values, revoked/throwing proxies, marker getters, repeatability and no throws. |
| `packages/observability/package.json` | EDIT exact deep export/browser map; no broad root export. |
| `packages/observability/test/package-contract.test.ts` | EDIT deep-export assertion and run existing browser exclusion checks. |
| `packages/observability/src/telemetry.ts` | EDIT attempted-start state and cached shutdown promise, including synchronous SDK failure. Keep instrumentation/sanitization and disabled/never-started behavior. |
| `packages/observability/test/telemetry.test.ts` | EDIT real SDK-factory failure matrix; direct probes demonstrated missing failed-start cleanup and repeated sync shutdown. |
| `packages/observability/src/nest-runtime.ts` | KEEP. Nest's TelemetryShutdown hook shares the same idempotent lifecycle with main's fallback. |
| `apps/api/src/platform/observability/observability.module.ts` | KEEP. Do not remove the Nest telemetry hook or add a second SDK owner. |
| `apps/worker/src/platform/observability/observability.module.ts` | KEEP for the same ownership reason. |
| `packages/observability/vitest.coverage.config.ts` | KEEP. All-source include already covers telemetry and the new classifier. |

Every new main test/fixture has a distinct owner; these are not generic
placeholders or requests to decide the test seam during implementation:

| NEW file | Exact responsibility |
| --- | --- |
| `apps/api/test/main.test.ts` | Direct API acquisition/listen/cleanup and diagnostics matrix. |
| `apps/api/test/api-main-process.fixture.mjs` | Compiled API bootstrap with controlled listen failure. |
| `apps/api/test/main-process.test.ts` | Actual-main invalid config plus bounded compiled listen-failure child. |
| `apps/worker/test/main.test.ts` | Direct worker acquisition, shutdown-owner construction/install/start-log failures and cleanup matrix. |
| `apps/worker/test/worker-main-process.fixture.mjs` | Compiled bootstrap with real process signals and real shutdown owner. |
| `apps/worker/test/main-process.test.ts` | Actual-main invalid config and both signal exits; no leaked child. |
| `apps/operator-command/test/main.test.ts` | Direct command argument/handoff/listener/output/failure matrix. |
| `apps/operator-command/test/operator-main-process.fixture.mjs` | Compiled bootstrap, real process object and controlled command lifecycle. |
| `apps/operator-command/test/main-process.test.ts` | Invalid-config exit, JSON result and both signal paths. |
| `apps/recovery/test/main.test.ts` | Direct acquisition, metrics-before-handoff, sync/async cleanup and diagnostics matrix. |
| `apps/recovery/test/recovery-main-process.fixture.mjs` | Compiled bootstrap with controlled recovery owner and real signals. |
| `apps/recovery/test/main-process.test.ts` | Actual-main invalid config and bounded active-child signal cleanup. |
| `apps/retention/test/main.test.ts` | Exhaustive PF-01 resource and reporting faults, metrics failure and correct worker handoff. |
| `apps/retention/test/retention-main-process.fixture.mjs` | Compiled bootstrap with controlled retention owner and real signals. |
| `apps/retention/test/main-process.test.ts` | Actual-main invalid config and both active-worker signal paths. |

### Coverage/reporting plumbing

The five new configs and their exact includes/output directories are specified
in PF-03. The remaining edit/test inventory is explicit here:

| Exact file | Disposition |
| --- | --- |
| `apps/api/package.json` | EDIT add `test:coverage:entrypoints`; keep current coverage/orchestration/publisher commands. |
| `apps/worker/package.json` | EDIT add entrypoint command; keep lifecycle cohort and its current source selection. |
| `apps/operator-command/package.json` | EDIT add entrypoint command; no existing coverage command to rely on. |
| `apps/recovery/package.json` | EDIT add entrypoint command. |
| `apps/retention/package.json` | EDIT add entrypoint command. |
| `package.json` | EDIT root coverage chain to invoke five new commands before risk report. |
| `apps/api/test/entrypoints-coverage-config.test.ts` | NEW config contract for API main/direct tests/output. |
| `apps/worker/test/entrypoints-coverage-config.test.ts` | NEW config contract for worker main/direct tests/output. |
| `apps/operator-command/test/entrypoints-coverage-config.test.ts` | NEW config contract for command main/direct tests/output. |
| `apps/recovery/test/entrypoints-coverage-config.test.ts` | NEW config contract for recovery main/direct tests/output. |
| `apps/retention/test/entrypoints-coverage-config.test.ts` | NEW config contract for retention main/direct tests/output. |
| `infrastructure/generate-coverage-evidence.mjs` | EDIT five source cohort names, not the truthful unmeasured classification. |
| `infrastructure/generate-coverage-evidence.test.mjs` | EDIT cohort enumeration and measured-vs-mapped main regression. |
| `infrastructure/report-risk-coverage.mjs` | EDIT five strict risk cohorts/policies and exact main inventories. Existing loader expects both coverage and test-results JSON. |
| `infrastructure/report-risk-coverage.test.mjs` | EDIT missing/wrong inventories, failed evidence and unreviewed branch gates. |
| `infrastructure/risk-coverage-reviews.json` | REGENERATE/REVIEW affected branch locators and fingerprints only after new coverage. Never label an executable startup branch unreachable to pass. |
| `docs/remaining-work/source-inventory.json` | GENERATE only after implementation. Primary check found all 658 source hashes still match and exactly five unmeasured mains. |
| `docs/remaining-work/risk-snapshot.json` | GENERATE from fresh report. Primary check found ten existing risk cohorts and no missing source paths; five new cohorts are absent today. |
| `apps/lifecycle-command/vitest.coverage.config.ts` | KEEP existing main cohort; refresh its results with expanded failure tests. |
| `infrastructure/validate-built-package-exports.mjs` | EDIT explicit Node consumer case for the new classifier subpath. Existing workflow-engine/testing case remains the WF-S01 runtime export check, not a declaration-diff substitute. |
| `infrastructure/validate-built-package-exports.test.mjs` | EDIT assert the new explicit case is registered; retain fixture tests for missing output and wrong ownership. |

### Workflow: PF-05, PF-06, PF-07, WF-S01

Paths below are relative to `packages/` unless explicitly starting with `apps/`.

| File | Primary review result / disposition |
| --- | --- |
| `workflow-engine/src/workflow-transition-stops.ts` | EDIT PF-05 ordinary waiting precedence; keep loop semantics and existing terminal/running truth. The ordinary deadline loop currently terminalizes Wait before the cancellation loop sees it. |
| `workflow-engine/src/workflow-transition-observations.ts` | KEEP. Controls are installed before due resumption; both flags can be true. Preserve persisted-fact event suppression. |
| `workflow-engine/src/transition-decisions.ts` | KEEP. Run cancellation precedence is already correct; admission map is not a drop-in replacement for first-match scheduler helpers. |
| `workflow-engine/test/executable-workflow-controls.test.ts` | EDIT simultaneous controls through genuine Wait observations; existing single-control test mutates a clone, so it is not sufficient new proof. |
| `apps/worker/test/coordinator-consumer-retry-wait.integration.test.ts` | EDIT add separate real-engine durable-controls case. Existing outage scenario uses a stub engine and must remain intact. |
| `workflow-engine/src/coordinator-observations.ts` | CONDITIONAL A. Read grouping copies, loop scans and merge edge/scope scans; preserve conflict detection, ordering and branch-prefix semantics. No production change before measurements. |
| `workflow-engine/src/workflow-transition-state.ts` | CONDITIONAL B. Preserve first-match and different missing-node behaviors when replacing the two repeated flatten/find helpers. |
| `workflow-engine/src/advance-workflow.ts` | CONDITIONAL B. Sole transition-state constructor; one per-advance private index only. Keep observations/stops/plan sequencing. |
| `workflow-engine/src/workflow-transition-plan.ts` | CONDITIONAL B. Two side-effect lookup call sites; no event/admission/checkpoint format change. |
| `workflow-engine/src/workflow-transition-derived.ts` | CONDITIONAL B. Disabled lookup during loop admission; retain readiness/join/loop behavior. |
| `workflow-engine/package.json` | EDIT measurement script only before selection; package remains private with intentional root/testing exports. |
| `workflow-engine/benchmarks/workflow-transition-scans.mjs` | NEW measurement runner, reproducible inputs/statistics/profiles/checksums; no claimed improvement before running it. |
| `workflow-engine/test/structural-scan-characterization.test.ts` | NEW identical-behavior gate for each independent candidate. |
| `workflow-engine/test/fixtures/structural-scan-characterization.json` | NEW reviewed exact expected results; never refresh to disguise candidate behavior changes. |
| `workflow-engine/test/executable-workflow-foreach.test.ts` | KEEP/run stable scoped ordinals; extend only if candidate A lacks a characterized case. |
| `workflow-engine/test/executable-workflow-foreach-part-2.test.ts` | KEEP/run nested completion and intentional testing-facade exports. |
| `workflow-engine/test/executable-workflow-branching.test.ts` | KEEP/run scoped branch/merge and direct-missing-branch behavior. |
| `workflow-engine/test/parallel-output-assurance.test.ts` | KEEP/run persisted output identity, duplicate/recovery behavior. |
| `workflow-engine/test/operation-risk-branches.test.ts` | KEEP/run bounded persisted-fact and operation-error contracts. |
| `workflow-engine/test/scheduler-projection.test.ts` | KEEP/run nested-body traversal; new characterization carries B's lookup expectations. |
| `workflow-engine/test/advance-workflow-transitions.test.ts` | KEEP/run deterministic recomputation, duplicate facts, wait and control behavior. |
| `workflow-engine/test/workflow-transition-risk-behavior.test.ts` | KEEP/run conflicts, missing nodes/scopes and due-resumption suppression. |
| `workflow-engine/src/operations.ts` | KEEP. Public advance/attempt facade owns normalized engine inputs; no split or cross-run cache. |
| `workflow-engine/src/node-attempt-input.ts` | KEEP. Different operation path; not authorized by either PF-06 candidate. |
| `workflow-engine/src/checkpoint-executable-validation.ts` | KEEP. Identity validation is not a scheduler-cache owner. |
| `workflow-model/src/expressions/policy.ts` | CONDITIONAL PF-07. Descriptor extraction plus local fresh-error normalization, or explicit JSON-only contract after owner decision. |
| `workflow-model/src/expressions/evaluator.ts` | KEEP if policy normalizes all projection failures. Inspected catch can throw on hostile cause; policy regression must prove it now receives only safe local failures. |
| `workflow-model/src/canonical-json.ts` | KEEP. Nested ordinary object/array accessors already use descriptor rejection; proxy reflection can throw and is handled at the policy boundary. |
| `workflow-model/test/expressions.test.ts` | CONDITIONAL EDIT. Exact stable result, zero getter calls/worker creation, nested cases and traps throwing hostile proxies; retain pool/timeout/limits/restart tests. |
| `workflow-model/src/mapping.ts` | KEEP. Forwards context and maps typed evaluator errors; projector restricts exposed fields. |
| `workflow-model/test/mapping.test.ts` | KEEP/run injected evaluator and value-resolution contract. |
| `workflow-model/test/package-contract.test.ts` | KEEP/run supported exports; no new PF-07 export. |
| `apps/api/src/node-testing/use-case.ts` | KEEP. Parsed draft flows into validation; no evaluator ownership change. |
| `apps/api/src/node-testing/validation.ts` | KEEP. Sample input canonicalized before mapping; no HTTP exploit demonstrated. |
| `apps/api/src/node-testing/ports.ts` | KEEP. Typed evaluator dependency remains unchanged. |
| `apps/api/src/platform/workflow/workflow-runtime.module.ts` | KEEP. Runtime composition constructs evaluator; not the context-boundary owner. |
| `apps/worker/src/execution/node-attempt-engine.ts` | KEEP. Injectable evaluator adapter contract unchanged. |
| `apps/worker/src/execution/node-attempt-runtime.ts` | KEEP. Evaluator construction/lifetime unchanged. |
| `apps/worker/src/execution/preview-attempt-runtime.ts` | KEEP. Preview evaluator construction/lifetime unchanged. |
| `workflow-engine/src/runtime.ts` | CONDITIONAL WF-S01. Exactly one dead type alternative, no producer; preserve runtime policy. |
| `workflow-engine/src/testing.ts` | KEEP re-export; declaration changes transitively only if the gate passes. |
| `workflow-engine/src/index.ts` | KEEP production export boundary; never expose this testing helper there. |
| `workflow-engine/test/retry-wait-cancellation.test.ts` | CONDITIONAL EDIT exhaustive type consumer; existing runtime reconciliation/uncertainty assertions retained. |
| `workflow-engine/test/expanded-public-boundary-coverage.test.ts` | KEEP/run canceled and unsafe-uncertainty results. |
| `workflow-engine/test/package-contract.test.ts` | KEEP/run testing-vs-production export contract. |

The built declaration search currently finds the member in `dist/runtime.d.ts`
and the type re-export in `dist/testing.d.ts`, as expected. This is declaration
presence, not proof of an external consumer. Out-of-repository compatibility
remains unverified. Historical structural audits remain unchanged.

### Review evidence, not implementation acceptance

- Direct local probes reproduced lifecycle metrics-before-handoff leakage,
  operator/recovery diagnostic failures skipping cleanup, telemetry failed-start
  and synchronous-shutdown ownership failures, and worker logging/partial
  install failures. No provider or deployed service was involved.
- Evaluator probes: top-level getter executed once; nested getter executed
  zero times; all three rejected-context cases created zero workers; a trap
  throwing a hostile proxy escaped through the current error handler.
- All 658 inventory source hashes match current contents. This binds the
  review to the existing dirty tree; it is not a fresh whole-repository audit.
- The existing generator/risk-report unit suites passed: 30 tests, zero
  failures/skips. They validate current reporting machinery, not the proposed
  five cohorts or future implementation.
- Documentation validation passed: 13 tests and 488 local links across 101
  documents. Whitespace/path checks passed; absent files are explicitly NEW.
- Review handoff is on `main`, tracking `origin/main` (locally recorded as
  zero behind / 27 ahead). Only this plan was edited in this correction review;
  it remains uncommitted alongside the pre-existing dirty tree. No commit,
  push, migration, service startup or external exercise was performed.
- New files, source fixes, forward migration, new process matrices, benchmark
  results and external gates remain unimplemented/unproved below.

## External qualification remains separate

None of the local PF items authorizes a deployed exercise, provider call,
message, destructive drill, repository-setting change, or production
migration. Preserve the existing external IDs and their canonical criteria:

| Gate | Existing obligation; not replaced by this plan |
| --- | --- |
| E00 | Exact environment, region/release identity, synthetic tenants, resource/recipient allowlists, cost/time caps, operator/approver, stop/rollback conditions, and evidence retention. This is a prerequisite to every external exercise. |
| DB-011 | Representative tenant skew/burst cardinality, query plans, lock/WAL/vacuum behavior, and fairness. |
| DB-017; E01-07/13/14 | Actual pooler/RLS semantics, headroom, replica lag, backup/PITR, and failover with approved RPO/RTO. |
| DB-016 | Run the existing M1/C1 compatibility-exception inventories on every supported database before retirement. |
| OBS-006 | Retrieve a real API -> outbox -> worker trace under the deployed retention/access/sampling policy. |
| E01-01…15; ART-008; INT-010; RL-002 | Deployed identity/IAM/Object Lock, provider failure/load/alert/retention evidence, and correct Redis topology. |
| INT-013; ART-001/002 | Real connection and cross-region latency/cost measurements before pooling or regional optimization. |
| X01/X02 | Image provenance/SBOM/scans, repository protection, independent review, and release-bound evidence. |
| E01-09 | Actual worker/container termination and recovery. The local background deadline bounds waiting; it does not kill a dependency that ignores cancellation. |

These gates retain their existing authorization requirements and evidence
locations in `docs/operations/external-platform-contract.md`,
`docs/operations/regional-recovery.md`,
`docs/operations/release-security-gate.md`, and
`docs/remaining-work-plan.md`. They are not substeps of PF-01–PF-07 or WF-S01.

## Explicitly unchecked or unavailable evidence

The primary review checked the plan-impact source/caller/test/migration surface
at the depth recorded in the ledger, but did not perform the following:

- No disposable PostgreSQL service was started, so PF-04 has static proof but
  not the required `0086 -> 0087` runtime result. The migration does not exist
  yet; its exact function body, owner, grants, page counts, and coordinator
  completion remain implementation acceptance work.
- No PostgreSQL/Redis worker integration was run for PF-05. The current defect
  is reproduced at the engine seam; durable load/commit/redelivery evidence is
  still required.
- The five missing bootstrap seams/tests and their compiled fixtures do not
  exist. Consequently PF-01/PF-02/PF-03 acceptance matrices and regenerated
  coverage/source mapping remain unchecked.
- PF-06 has no benchmark, operation-count curve, CPU profile, or memory
  comparison. Neither candidate is recommended for implementation today.
- PF-07 has no recorded owner decision between a no-accessor and JSON-only
  evaluator contract. Direct out-of-repository adapter compatibility is not
  established.
- WF-S01 has no affirmative out-of-repository testing-facade compatibility
  attestation or built declaration diff. Removal is not yet recommended.
- No live service, provider, AWS, GitHub/repository setting, external message,
  load test, failover, restore, or destructive exercise was performed. All
  external gates above remain open on their existing authorization track.

Do not mark an item complete while its corresponding unchecked evidence remains.

## Completion checklist

### Correctness first

- [ ] PF-04: add forward migration `0087`; update execution plan/readiness/head
      fixtures; pass exact prior-head and coordinator purge regressions.
- [ ] PF-04: prove all four rerun states/types, bounded pages, holds, stale
      fences, isolation, command-ledger retention, and real evidence/replay
      cascades.
- [ ] PF-05: unify ordinary/scoped stop precedence without changing persisted
      formats or running/unsafe reconciliation.
- [ ] PF-05: pass authentic compiled-executable tests and the real
      PostgreSQL/Redis Wait cancellation+deadline integration.

### Startup and diagnostics

- [ ] PF-02: add the leaf fixed-vocabulary, nonthrowing classifier and hostile
      value/trap tests.
- [ ] PF-03: export guarded app-owned bootstraps for API, worker,
      operator-command, recovery, and retention; retain lifecycle-command's
      existing seam and correct its pre-handoff failure ownership.
- [ ] PF-01: make every acquired retention pre-handoff cleanup attempt run and
      preserve the initiating failure.
- [ ] PF-02: replace raw classification at all six mains and both inner
      operational log sites.
- [ ] PF-03: pass every direct fault matrix and compiled process/signal suite;
      preserve telemetry-before-import and ownership handoffs.
- [ ] PF-03: repair telemetry attempted-start/synchronous-shutdown ownership
      and worker shutdown caching/listener rollback; guard failure reporting.
- [ ] PF-03: wire five strict entrypoint coverage cohorts and regenerate
      evidence; all five mains must be measured and owner-suite mapped with
      no false reviewed-branch classifications.

### Conditional items

- [ ] PF-06 gate: record repeatable baseline characterization, timings,
      operation counts, CPU profiles, and memory evidence.
- [ ] PF-06 decision: select A and/or B only if each independently meets the
      threshold; otherwise record `KEEP` and make no production change.
- [ ] PF-07 gate: record the evaluator contract owner/date and compatibility
      evidence.
- [ ] PF-07 decision: either implement descriptor-safe extraction and tests or
      document JSON-only scope and mark the implementation finding unsupported.
- [ ] WF-S01 gate: prove no supported consumer and inspect the built declaration
      diff.
- [ ] WF-S01 decision: remove the dead member with exhaustive tests, or retain
      it for a documented supported type consumer—never invent production logic.

### Final local verification and handoff

- [ ] Run the focused commands in each item, then `pnpm check` and the relevant
      local integration cohorts. Do not substitute local checks for external
      IDs.
- [ ] Run `pnpm test:coverage`, `pnpm coverage:evidence`, and documentation
      validation only after source/tests are stable; inspect generated changes.
- [ ] Run `git diff --check`, inspect `git status --short`, and distinguish this
      work from the user's pre-existing uncommitted changes.
- [ ] Update this checklist with concrete evidence. Do not mark a conditional
      item implemented without its gate, or a confirmed item complete without
      its runtime regression.
- [ ] Create commits or push only with separate authorization; report exact
      commits, branch/upstream, push state, and remaining uncommitted files.
