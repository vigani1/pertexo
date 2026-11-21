# F58 — Inline pure steps

Status: proposed. Decision: [ADR 096](../adr/096-inline-pure-steps.md).
F58 implements option C from [Cost of a pure step](step-transaction-cost.md).
Implementation follows the integration module rollout in F57.

## Implementation slices

1. **Versioned registration.** In
   `packages/node-sdk/src/definitions/catalog.ts`, extend `NodeManifest`
   and `nodeManifestSchema` with the execution class. Preserve the stored
   shape and verification of old pins. In `execution/registry.ts`, extend
   `createNodeRegistry` and `pinRegistrations` to verify origin and the
   definition/executor pairing, including the attempt fallback. Wire trusted
   origin in `packages/node-catalog/src/catalog.ts` and `server.ts` from
   the core registration source and F57's integration module source.
   Check origin before merging registrations. Keep all shipping versions on
   the attempt path.
2. **Run a chain behind an off-by-default server setting.**
   - **SDK and worker.** Add a synchronous inline invocation and result tag
     in `packages/node-sdk/src/execution/node-execution.types.ts` and the
     restricted context in `execution/inline.runtime.ts`. Keep shared
     bounded schema parsing and failure mapping in `registry.ts`. Build
     the closed code from core registrations and validate its dependency
     closure through the existing architecture checks. In `apps/worker`,
     validate the setting in `src/config/worker-environment.schemas.ts` and
     `src/config/worker.ts`. Pass it through
     `src/transport/providers/coordinator.ts` to
     `createCoordinatorRuntime` in `src/runs/coordinator.runtime.ts`.
     Compose the pure registry there, independently of the provider
     composition in `src/providers/node-registry.ts`. Exercise the path
     with a test registration from the trusted core source.
   - **Engine.** In `packages/workflow-engine/src/transition`, have
     `advanceWorkflow` in `advance-workflow.ts` drive bounded inline
     execution at the admission decision. Reuse
     `advanceWorkflowFromSchedulerState` in `advance.ts`,
     `deriveWorkflowTransitions` in `derived.ts` and
     `buildWorkflowTransitionPlan` in `plan.ts`. Represent settled inline
     attempts as a distinct plan case from delivery admissions. Advance
     one working transition through the same observation handling and
     enqueue only the final outstanding deliveries. Consume the persisted
     fact cursor once, allocate event sequence numbers across the complete
     batch and finalize one revision from the original checkpoint. Honor
     existing ready ordering and stop at a scheduler frontier that requires
     external outcomes. Carry budget exhaustion as immediate work, even
     when the checkpoint has no other logical change.
   - **Input and completion.** Reuse the input preparation under
     `attempt/execute.ts` (`executeNodeAttempt`),
     `attempt/prepare-attempt-input.ts` (`prepareNodeAttemptInput`) and
     `attempt/mapping.ts` (`resolveMappedNodeInput`). Prepare Merge's
     settled input through `mergeCoordinatorObservations` in
     `observation/coordinator.ts`. Supply the immutable run input and
     variable snapshot, scoped upstream data and transaction-local
     completed outputs. Keep the same mapping diagnostics, storage bounds
     and output-variant selection. Pass the inline outcome to
     `applyWorkflowObservations` in `transition/observations.ts` through
     the same success/failure lowering as persisted attempt outcomes.
     Share the normalization currently reached from
     `executorFailureCompletion` in the worker's
     `attempts/delivery/executor-failure.ts`. Reuse
     `resolveAttemptFailures` in `observation/coordinator-failures.ts`
     and `decideRetry` in `attempt/retries.ts`, including due time and
     attempt count. Resolve callable results through
     `settleCallableResult` in `transition/settle-result.ts` using the
     last inline outputs alongside persisted values.
   - **Core.** In `packages/core/src/runs/advance`, pass the opt-in from
     `advanceRun` through `run-advance.store.ts`'s `advance`. Use its
     existing `withCoordinatorWriteClient` lock order and authoritative
     delivery validation. Claim the receipt under the run lock before
     running kernels, and co-locate claim and completion in that
     transaction. Preserve the queued-run capacity check and deferred
     receipt handling in `persist/commit.ts`'s `saveRunTransition`
     before any inline records become durable. Extend the bounded reads in
     `load/load-run.ts` and `load/completion.repository.ts`. Include the
     transaction-local outputs when `resolveRunResult` evaluates a final
     callable value.
   - **Records and events.** In `persist/node-admissions.ts`, extend
     `persistCoordinatorExecutionTransitions` and share the identity
     allocation in `persist/admissions/create-executions.repository.ts`.
     Use the existing node run and attempt tables, input/output codecs and
     attempt numbering. Share the outcome field mapping in
     `core/src/attempts/completion/apply-completion.ts` and the row
     projections in `outcomes.repository.ts` for terminal writes
     inside the coordinator transaction. The queue consumer continues to
     use the lease and receipt checks in `completeNodeAttempt`. Write
     started and completion facts through the gapless event append in
     `persist/admissions/events.repository.ts`. Account for these facts
     in the new checkpoint's event cursor so redelivery cannot apply them
     twice. Preserve failure notification intent and audit writes from
     `saveRunTransition`. In `persist/persist-run-transition.ts`, use
     `persistCoordinatorRunTransition` and `continuesImmediately` from
     `persist/transition-plan.ts` for CAS and wakeup. An existing queued
     attempt can supply the wakeup when its outcome is required.
     Publish the committed range and step metrics once through the
     worker's `createCoordinatorHandler` and
     `createCoordinatorTelemetry`.
3. **Register pure versions, then enable by default after proof.** Add
   versions in `packages/nodes-core/src/catalog/definition-registrations.ts`
   and `executor-registrations.ts` and their owning definition/executor
   files. Start with `flow/{condition,switch,merge}`, `data/set` and
   `data/lists/{filter,sort}`. Cover bounded list and data transforms
   such as Text, Number and Date once their full configuration and pure
   dependency closure pass the qualification checks. Keep each legacy
   pin resolvable. Use the same kernel in the inline and attempt bindings
   of a new version. First ship support with the setting off. Run the
   proof against those versions before changing the default. Confirm
   that disabling the setting with work already queued preserves both
   pending retries and existing attempt deliveries.

For Each keeps its current iteration batches. Reuse
`deriveLoopBodyReadiness` and `advanceLoopIterations` in
`transition/derived.ts` and the persisted loop barriers in
`core/src/runs/advance/persist/settlement.repository.ts`. Exercise
consecutive inline work within a batch, including a budget yield within an
iteration. Cross-batch coalescing is outside F58.

## Tests that prove it

**Correctness.** Run the existing engine, core run/attempt and worker recovery
and resilience suites with the setting on. Cover a forced retry, a delayed
retry wakeup, failure routing, an error workflow, run and step deadlines,
cancellation, pinned samples, F02 suites, replay, output reuse and SSE
reconnect. Assert at least one new-version inline attempt actually completes
without its own `execute-node-attempt` outbox or lease. Test both budget
limits, fresh-budget fallback, a mixed inline/attempt frontier and
continuation across a For Each batch. With two eligible workspaces, assert
the second makes progress before the first finishes a long chain.

Use the owner harness in
`apps/worker/test/support/coordinator/recovery-harness.ts` and the process
kill setup in `apps/worker/test/support/recovery/processes.ts`. Pause a
real coordinator child after K of N inline invocations and before commit
using test-side instrumentation. Use a second pause after SQL writes and
before COMMIT to prove rollback of records that reached PostgreSQL. With a
separate connection, assert that neither pause exposes those invocation
records, completion events, a new checkpoint, receipt or next outbox row.
SIGKILL the child, redeliver and assert every expected invocation and
attempt number appears exactly once with the expected output. Repeat on
the committed side and assert redelivery adds zero rows or events. Use
test-side barriers with independent timeouts and require the reached marker
before killing. Use a mixed chain with a permanent failure in its middle
and assert the failed attempt's input and safe error, the chosen handler,
the skipped success successor, and the final run disposition and error
workflow behavior. See the tests fail with split persistence, stale receipt
handling or bypassed failure routing before accepting their green runs.

**Equivalence.** Publish every curated template with applicable new pins
through the real publish path. Run each fixture twice on the same build
with the same pins and inputs and the setting off and on. Use the existing
curated-template controlled transports under
`apps/worker/test/support/curated-templates/`. Run the engine transition
cases, including
`packages/workflow-engine/test/checkpoint/persisted-conformance.test.ts`
and `test/transition/scheduling/invocation-key-conformance.test.ts` in both
modes for cases that execute steps. Require identical run outputs, node-run
records and ordered logical events with controlled delivery order. Match
rows by node and invocation scope, then attempts by number. Normalize
timestamps and map freshly generated physical IDs to those identities.
Compare payloads, error codes, side-effect class and retry dispositions.
Check the intentionally different transport facts directly, including the
absence of inline leases, dispatch marks and attempt outbox rows. For
concurrent delivery cases also check gapless sequencing and causal order
under the production scheduler.

**Safety.** Assert that real registry composition refuses an integration
declaration of `inline`, including one that claims trusted metadata, and
rejects a connection slot, capability or dispatch-aware executor binding
on a core inline definition. Through the real restricted runtime, use
fixture kernels that try host file, network, credential, module-loading
and code-generation access. Require a refusal or unavailable interface and
zero requests at a local listener or writes to a scratch marker. Check
that the kernel cannot read ambient time or randomness. Prove the import
check rejects forbidden direct and transitive dependencies. Validate
malformed and oversized inputs/outputs and a runaway expression against
the normal policy. Prove the budget cuts off a synchronous kernel as
well as an expression.

**Performance.** Re-run the J7 harness from the batch J7/J9 evidence,
using `apps/worker/test/runs/consumer/latency.integration.test.ts` as its
tracked starting point. Run Manual → 1 or 10 pure steps → Terminate
with the Set, Condition and Text cycle and the same published pins in
both modes. Use 200 starts at eight at a time, active limit 200, and the
documented production worker, dispatcher and admission settings. Keep
the stack and runner class fixed, alternate off/on and report at least
three paired repetitions. Use the J7 idle/observer corrections for
`pg_stat_database`, `pg_stat_statements` and Redis `INFO commandstats`.
Report totals per run and marginal per-step costs as (10 − 1) ÷ 9,
client statements, queue hops, burst wall time, and worker and PostgreSQL
CPU before and after. Record the commit, environment and run URLs with
the raw reports. The target for the 10-step workflow is about 90
transactions and 360 Redis commands per run, and a 200-run burst in
25–30 seconds. The historical estimates compare to about 330, 1,200
and 78 seconds. Measure a fresh post-B off baseline and report its
actual deltas and variance. Keep the default off until the targets are
demonstrated.

Run the existing `.github/workflows/simulate-load.yml` on GitHub runners
in both modes. Use the S5 steady and overload scenarios and the S10
worker-memory scenario at the same minimum 4 GiB, 2 vCPU sizing. Include
the pure-step pins in the mixed workload and reuse the existing load driver
in `infrastructure/single-server/test/drill/load/`. Report run URLs,
host CPU, memory and restart counts, queue drain, start latency and
cross-workspace progress. Require zero lost, duplicated or stranded runs
and compare with the matched off baseline. Use isolated compose projects
and ports throughout.
