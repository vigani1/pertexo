# Worker transport and outbox review

Date: 2026-09-12. Scope: 18 frozen inventory files read in full by the primary
reviewer. Three unit files / 33 tests passed. Probes used the current compiled
worker with injected dependencies only. Related runtime owners and service
integration fixtures are reviewed separately; this ledger does not certify
their implementations or run fault-injection services.

## Individual file judgments

| File | Disposition | Specific judgment |
| --- | --- | --- |
| `apps/worker/src/transport/coordinator-runtime-provider.ts` | KEEP; TEST WQ-099 | Explicit override wins, capability-registry override suppresses auto-composition, enabled job determines activation. Named runtime options retain cohort and timeout-context policy. Keep these semantics visible rather than a generic provider factory. |
| `apps/worker/src/transport/dispatch-consumer-capabilities.ts` | KEEP; TEST WQ-099 | Validates unique job names, checks readiness after awaiting consumers, and reports exact missing capability. One shared consumer may serve several names; repeated waitUntilReady calls are coalesced by the concrete consumer, not evidence of multiple consumers. |
| `apps/worker/src/transport/dispatch-providers.ts` | FIX WQ-096; REFACTOR/TEST WQ-099 | Composes metrics/consumer registry/dispatcher explicitly. Constructor argument evaluation can acquire database before producer/dispatcher validation throws. Nested conditional arrays obscure the otherwise simple activation table. |
| `apps/worker/src/transport/node-attempt-runtime-provider.ts` | KEEP ownership transfer; TEST/REFACTOR WQ-099 | Correctly closes preview store if invoker construction fails and preserves primary/cleanup errors. Ownership transfers to createNodeAttemptRuntime at the documented invocation; verify that callee during runtime review rather than double-closing here. Activation is calculated twice but not a correctness defect for frozen config. |
| `apps/worker/src/transport/outbox-dispatch-result.ts` | KEEP | Four explicit outcome counts over at most one bounded claim batch are clearer than an unnecessary reducer abstraction. Claim/exhaustion/reclaim observations use finite labels. |
| `apps/worker/src/transport/outbox-dispatcher.ts` | FIX WQ-097/WQ-098; TEST WQ-099 | Validates checksum and queue contract, preserves durable unknown outcomes, gates enabled consumers and isolates ordinary metrics. Close does not cache/own every dispatch; run loop may enter a fresh poll sleep after close; capacity timeouts do not bound underlying work. |
| `apps/worker/src/transport/outbox-publication-settlements.ts` | KEEP lease truth; TEST WQ-097/WQ-099 | Retains original lease while ambiguous queue/mark operations may settle, and late mark uses original token. Owns pending promise rejection without false release. Snapshot draining and late new work require integration with dispatcher close; add late failure/stale/no-unhandled tests. |
| `apps/worker/src/transport/preview-maintenance-runtime-provider.ts` | FIX WQ-096; TEST WQ-099 | Early activation/encryption checks are useful. Store/encryption/client acquisition precedes try; returned close closes delivery dependencies concurrently with the consuming runtime and lacks cached promise. Preserve custom delivery ownership distinction. |
| `apps/worker/src/transport/transport-job.ts` | KEEP; TEST WQ-099 | Compile-time complete JobName map and queue-pair validation are clear; repetitive entries buy exhaustiveness. Do not replace with unchecked dynamic object construction for line reduction. |
| `apps/worker/src/transport/transport-lifecycle.ts` | FIX WQ-096; WQ-057 integration | Drain starts before shutdown. Eager close calls defeat allSettled on sync throw; first-only rejected reason loses other cleanup failures. Runtime dependency ordering must be explicit. |
| `apps/worker/src/transport/transport-metrics-adapter.ts` | KEEP; TEST WQ-099 | Finite failure-class switch and finally decrement preserve paired accounting. Outer queue observer contract contains callback errors; adding duplicate catches everywhere would obscure which seam owns them. |
| `apps/worker/src/transport/transport-operation-deadline.ts` | FIX WQ-085 extension | Timer cleared and late promise normally observed; rejection handler's instanceof on hostile input can throw after clearing timer, leaving outer promise pending with an unhandled rejection. No cancellation is provided by this deadline helper. |
| `apps/worker/src/transport/transport-tokens.ts` | KEEP | Stable DI tokens and explicit dependency type match module providers. Failure-notification delivery override is transport-level, not automatically an application-level option; test/document actual supported composition seam. |
| `apps/worker/src/transport/transport.module.ts` | KEEP; WQ-057/WQ-096 integration | Provider order and exported drain/runtime services express actual composition. Splitting providers is justified by independent activation/resource ownership, not just file size. Preserve one shared drain state. |
| `apps/worker/src/transport/trigger-runtime-provider.ts` | KEEP; TEST WQ-099 | Mirrors coordinator activation policy while forwarding trigger settings and optional logger. No provider-created resources exist outside the delegated runtime invocation. |
| `apps/worker/test/outbox-dispatcher.test.ts` | KEEP core invariants; TEST/FIX WQ-097–WQ-099 | Strong checksum, contract, disabled consumer, unknown lease and metric isolation assertions. Tests called idempotent/drained do not cover pending repeated close or timed-out raw capacity work; 102-event fixture violates configured batch size 10. Real-timer restoration is beforeEach rather than guaranteed after fake-clock tests. |
| `apps/worker/test/transport-metrics-adapter.test.ts` | KEEP; TEST WQ-099 | Exact bounded labels, failure mapping, latency and finally decrement are useful. Add queue/job mismatch and outer queue callback-failure integration rather than asserting the adapter never throws. |
| `apps/worker/test/workflow-publish-transport-contract.test.ts` | KEEP | Small cross-package contract test uses the real persisted payload producer and real queue parser; keep despite its size. It catches drift that module-local schema tests cannot. |

## WQ-096 — transport provider acquisition and dependency-safe close

Priority P2; FIX. Exact locations:

- `dispatch-providers.ts:53–67`: database is acquired before queue producer and
  OutboxDispatcher constructor; later construction failure has no local rollback.
- `preview-maintenance-runtime-provider.ts:63–98`: notification store,
  encryption and HTTP client/delivery composition precede try. A later failure
  can strand earlier owners. Its catch ignores cleanup errors and evaluates
  synchronous close before allSettled can contain it.
- Same provider `close:121–135`: runtime.close, notificationStore.close and
  encryptionRuntime.close run concurrently. Runtime close must stop/drain the
  consumer that uses that delivery store/encryption before closing them. Repeated
  wrapper close also restarts these calls rather than sharing one outcome.
- `transport-lifecycle.ts:38–62`: an eager synchronous dispatcher close throw
  skips all runtime closers. Public lifecycle probe observed zero coordinator
  closes after dispatcher.close threw synchronously. Only the first async
  failure is subsequently rethrown even if several owners fail.

Plan: register each successfully acquired owner immediately, invoke closers
through safe thunks, and preserve primary plus secondary failures. For the
notification wrapper, stop/drain runtime first, then close its dependency store
and encryption (independent dependencies may close together afterward). If
drain times out, follow the agreed forced-close policy and report remaining
in-flight work; do not silently claim ordered completion. Cache the close
promise before starting any closer. The secure HTTP client currently exposes
no close handle, so do not invent one or close a borrowed client. Verify its
transport owner during provider-runtime review.

Keep injected overrides' ownership contract intentional. A custom delivery
capability does not imply ownership of a hidden database/encryption runtime.
Coordinate with WQ-057 app-level rollback; a provider-level cleanup fix does
not make Nest automatically close all previously created sibling providers.

Acceptance: fail each acquisition/constructor step; preserve original error
and all cleanup errors; sync/rejected/stalled runtime close; no delivery
dependency close before consuming jobs stop; repeated close shares settlement;
all independent closers attempted. Use minimal factory seams or module mocks
for resource acquisition tests, not live providers or a generic DI framework.

## WQ-097 — dispatcher lifecycle must own every operation it starts

Priority P2; FIX. `outbox-dispatcher.ts:268–293` sets lifecycle=closed and
returns immediately on every later close. It tracks loopPromise but not an
independently invoked public dispatchOnce. `runLoop:397–412` enters a fresh poll
sleep after dispatch finishes even if close happened while dispatch was pending.
`checkReadiness:256–266` has no terminal/drain recheck after awaited probes.

Local current-build probes:

1. Deferred database close: second close resolved while first still waited.
2. Deferred direct dispatch claim: close finished database/producer cleanup;
   resolving the claim afterward yielded call order db.close, producer.close,
   publish. The fake allowed publication to expose ordering; a real closed
   producer may reject instead. Do not claim a demonstrated extra live job.
3. Running loop with 200 ms poll interval/100 ms close-operation timeout:
   resolve an empty in-flight claim immediately after close starts; close still
   fails TransportOperationTimeoutError at 100 ms because a new sleep begins.
   The probe awaited the remaining 110 ms so its poll timer finished.

Plan: cache one close promise, register every admitted dispatch operation, and
stop new admissions at the existing lifecycle/drain seam. Define whether a
claim already in progress is drained to publication or safely left leased for
recovery; preserve durable lease/token behavior in either case. Do not release
an ambiguous publish/mark merely because shutdown began. Recheck terminal state
before entering poll delay, and use an abort-aware/wakeable delay whose cancel
request cannot be lost before listener/wake installation. Recheck readiness
after awaited probes so a closed/draining dispatcher cannot newly report ready.

Settle/track admitted dispatches before taking the pending-publication snapshot
and closing database/producer. If a bounded drain expires, retain late-result
observation and ensure it cannot initiate unowned work on a closed dependency.
Thunk both final closers so sync database.close cannot skip producer.close.
Aggregate independent failures rather than exposing only the first one.

Acceptance: close before start, while claiming/publishing/marking/observing,
between dispatch completion and delay setup, and during existing delay;
concurrent direct dispatchOnce calls; concurrent/repeated close returning the
same outcome; readiness success racing drain/close; late unknown queue success,
late database mark success/failure and token rejection. Assert no new operation
after dependencies close, no false publication claim, no unnecessary full poll
wait, exact owner counts and no unhandled rejection. Keep existing retry/unknown
outcome tests and normal polling recovery. Coordinate with WQ-096/WQ-057.

## WQ-098 — bound actual capacity-sampling work, not only its await

Priority P2; FIX. `outbox-dispatcher.ts:438–493` bounds each hook's wait then
catches timeout and starts the next workspace. The original hook has no signal
and remains active. pendingCapacityWorkspaces<=100 and sampled cache<=1,000
therefore do not bound active database observations. Similarly, queue/backlog
observations are raced but not canceled; inspect their concrete adapter bounds
before declaring a leak there.

Local probe supplied four valid events in one allowed batch and four hook calls
waiting on the same unresolved promise. With a 100 ms operation timeout, after
340 ms all four hooks had started and all four were still active. The probe
then resolved the raw work and closed the dispatcher normally.

Plan: give the sampling owner a cancellable hook contract (using the existing
WorkspaceDatabase options, including WQ-091 forwarding) or keep the actual raw
operation in a bounded active set. Do not launch replacement samples while a
timed-out operation still consumes the chosen capacity. Best-effort telemetry
may drop/coalesce new samples; it must not retain unbounded unresolved work.
Distinguish last-attempt from last-success timestamps if retry policy changes.
Keep workspace identity out of metric labels and preserve the existing cache
limits/5-minute policy unless separately justified.

Acceptance: successive never-settling hooks, abort-ignoring hook, late success/
rejection, shutdown during timeout, repeated workspace and >100 queued distinct
workspaces across valid batches. Assert bounded actual active count and waiter
count, no new sampling after close, observed late rejection and honest cleanup
outcome. Preserve prompt durable publication when telemetry is slow or fails.
Do not simply increase timeouts, add retries, or rename the current wrapper
"cancellation". Coordinate artifact-metrics query signal ownership with WQ-095.

## WQ-099 — simplify activation reading and make transport tests contractual

Priority P2 for missing behavioral proof; P3 for optional local refactoring.

`dispatch-providers.ts:98–148` constructs a registry with nested conditional
spreads. A small named list of `{ jobName, consumer }` candidates filtered by
enabled jobs can express the activation table more directly, but preserve the
existing distinction between explicit runtime override, auto-composition and
capability-registry override. Do not create a public registry-builder framework
or erase separate production/preview jobs sharing one attempts consumer.
Calculate nodeAttemptActivation once per provider invocation if passed onward;
do not make activation mutable or infer it from queue names.

Required tests and corrections:

- Public registry: empty/duplicate/invalid jobs, absent consumer, consumer
  wait rejection, consumer becomes unready after wait, exact ready subset,
  shared consumer for multiple jobs. Test input validation independently of
  dispatcher behavior; retain post-await isReady check.
- Provider activation matrix: every supported maintenance job (preview
  reconciliation, unknown outcome, replay, notification), notification with
  missing encryption, custom delivery, runtime override and capability override;
  disabled providers must acquire zero resources. Node provider tests already
  exist in broader runtime tests; reuse those and add missing owner cases.
- `outbox-dispatcher.test.ts` capacity-limit fixture currently returns 102
  events although batchSize=10 (and production maximum=100). Drive multiple
  valid claim batches while the first sample is blocked; assert the same
  100-pending limit. Cache-eviction test likewise returns batches of 100 to a
  configured limit 10. Prefer correct configured batch sizes to permissive fakes.
- Unknown failure test's waitFor(not.toHaveBeenCalled) can pass before the
  settlement handler runs. Use a controlled settlement/known drain turn and
  assert no mark/release after it has actually completed. Add stale mark,
  rejected settlement, mark rejection and close while each is pending.
- Add WQ-097 lifecycle tests with close deferred/rejected/synchronous, not
  only sequential successful repeated close. Add claim/readiness/release errors,
  unsupported payload type, actual queue contract mismatch, null input and
  late boundary outcomes. Preserve checksum-before-publication and exact token.
- Put fake timers back in afterEach/finally and close every started dispatcher.
  beforeEach(useRealTimers) leaves the previous test's teardown order implicit.
  Replace zero-delay waits used as lifecycle synchronization with deferred
  operation-start signals where practical.
- Metrics: invalid job/queue pairing, exact decrement after completion failure,
  and outer queue observer isolation. `transport-job.ts` is a compile-time
  mapping, not an unknown-value parser; do not invent hostile inputs to its
  typed internal helper and call that a production security flaw.

Acceptance: valid fixtures match database/queue contracts, tests distinguish
unknown from definite publication failure, owner regressions fail on current
code, and optional activation cleanup preserves provider/job mapping exactly.
No arbitrary line-count or helper-count threshold is used.

## WQ-085 extension — transport deadline rejection has the same settlement trap

`transport-operation-deadline.ts:23–28` clears its timeout before doing
`error instanceof Error` inside an unobserved .then rejection handler. Local
probe rejected with a proxy whose getPrototypeOf throws: one unhandled
rejection, outer bounded promise still unsettled after its 10 ms deadline and
a 30 ms observation. Apply WQ-085's non-inspecting rejection settlement and
late-observer tests here. Keep TransportOperationTimeoutError for actual timer
expiry and retain any intentionally required safe public classification at a
higher layer. Also ensure publication error-code classification cannot replace
the underlying release/settlement policy for hostile adapter failures.

## Order

WQ-085 extension and WQ-096/WQ-097 ownership first, then WQ-098 actual work
bounding. WQ-099 supplies regression/fixture truth before optional activation
refactoring. Database lease authority and unknown-outcome handling remain
unchanged; no implementation or external service mutation was performed.
