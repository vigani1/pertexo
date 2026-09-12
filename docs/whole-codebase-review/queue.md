# Queue: complete file-by-file judgment

Reviewed all 31 inventory files against J01–J14. Source, tests, fixture and
configuration were read; no queue implementation was changed. Existing unit
suite: 11 files / 61 tests passed. Redis integration was inspected, not run.

## File ledger

Paths below are relative to `packages/queue/`.

| File | Judgment | Concrete reason / action |
| --- | --- | --- |
| `packages/queue/src/consumer.ts` | KEEP + TEST WQ-017 | Admission, execution and bounded drain are distinct phases. Preserve timeout/transport/drain precedence and cancellation checks; strengthen test isolation and late-settlement coverage. Do not conflate aborted transport processing with physical termination of arbitrary handlers. |
| `packages/queue/src/contracts.ts` | KEEP | Strict identifier-only schemas, historical compatibility versus active advertisement, own-key registry lookup and discriminated job/data typing are justified. Safe parser catches arbitrary failures without inspecting the caught object. |
| `packages/queue/src/defaults.ts` | KEEP | Explicit four-class policy table and nested freezing communicate operational differences better than calculated defaults. |
| `packages/queue/src/delivery-admission.ts` | KEEP | Focused queue/name/outbox-identity gate; invalid deliveries are unrecoverable. BullMQ deserializes wire JSON, so hostile executable object concerns are not asserted as a transport exploit. |
| `packages/queue/src/index.ts` | KEEP | Explicit reviewed export surface; no internal instrumentation helpers leaked. |
| `packages/queue/src/names.ts` | KEEP | Literal names and exhaustive job routing make compatibility changes visible. |
| `packages/queue/src/producer.ts` | FIX WQ-014; FIX/TEST WQ-016 | Readiness lacks a post-await lifecycle check; fallback disconnect promises lack rejection handling. Preserve explicit unknown publication outcome and late settlement. |
| `packages/queue/src/redis-endpoint.ts` | KEEP | Small common endpoint policy with caller-owned error vocabulary; no generic configuration framework needed. |
| `packages/queue/src/redis-telemetry-contracts.ts` | FIX WQ-015 | Error classification occurs outside telemetry isolation and can replace the operation failure. The void command observation promise can also reject on classification failure. |
| `packages/queue/src/redis-telemetry.ts` | KEEP | Fixed labels, package-owned instruments and lazy production observer; no payload/ID attributes. |
| `packages/queue/src/run-event-notifications.ts` | KEEP | Opaque channel derivation, bounded identifier message and best-effort publication are cohesive. Unlike durable outbox publication, a notification timeout need not introduce a durable unknown-outcome state. Check API adapter tests during API review before claiming missing publisher coverage. |
| `packages/queue/src/server-only.ts` | KEEP | Consistent server guard supplements the package browser map. |
| `packages/queue/test/compatibility.test.ts` | KEEP | Independent wire fixture names are checked against every historical job name. |
| `packages/queue/test/consumer.test.ts` | TEST WQ-017 | Good admission, cancellation, readiness and forced-close scenarios; shared mocks retain implementations between tests, and several short real timers should be deterministic. |
| `packages/queue/test/contracts.test.ts` | TEST WQ-017 | Test named “every supported” omits replay although compatibility fixture covers it. Make table completeness an assertion; do not falsely report replay wholly untested. |
| `packages/queue/test/defaults.test.ts` | KEEP | Tests relationships between heartbeat/lock/timeout and retention rather than arbitrary snapshots; add nested freeze checks opportunistically, not a separate refactor. |
| `packages/queue/test/fixtures/queue-jobs-v1.json` | DATA / KEEP | All ten identifier-only wire examples inspected, including historical jobs and replay; UUID shapes and discriminators match parsers. |
| `packages/queue/test/names.test.ts` | KEEP | Independent literal compatibility oracle and queue routing expectations. |
| `packages/queue/test/package-contract.test.ts` | KEEP | Checks browser exclusion and server guard through advertised exports. |
| `packages/queue/test/producer.test.ts` | TEST WQ-014, WQ-016, WQ-017 | Existing close tests cover rejecting close, not rejecting disconnect; close/readiness test covers only Redis-poll phase. Event listeners accumulate in shared mock map. |
| `packages/queue/test/public-surface.test.ts` | KEEP | Explicit runtime manifest usefully protects the package boundary. |
| `packages/queue/test/redis-endpoint.test.ts` | KEEP | Table covers protocol, hostname, normalization and caller-specific error classification. |
| `packages/queue/test/redis-telemetry.integration.test.ts` | KEEP | Opt-in pinned-client success/failure check and owned client finally cleanup. Duplicated client inherits lazyConnect, so do not claim an opened-socket leak from the unconnected duplicate assertion. |
| `packages/queue/test/redis-telemetry.test.ts` | TEST WQ-015, WQ-017 | Add failure identity/classifier adversaries and inspect actual recorded attribute arguments; stringifying objects containing mock functions is a vacuous privacy check. |
| `packages/queue/test/run-event-notifications.test.ts` | KEEP | Encoding/channel tests have a clear scope; class-level coverage may live in API adapter tests and is not assumed absent. |
| `packages/queue/package.json` | KEEP | Pinned dependencies, server-only root export, separate integration command and existing build system are consistent. |
| `packages/queue/tsconfig.json` | KEEP | Explicit NodeNext/server target, declaration output and source boundary; preserve repository configuration. |
| `packages/queue/tsconfig.test.json` | KEEP | Extends production types while including tests/configs without emit. |
| `packages/queue/vitest.config.ts` | KEEP | Node environment and generated-output exclusions; script excludes integrations. |
| `packages/queue/vitest.coverage.config.ts` | KEEP | Source-scoped coverage, explicit integration exclusion and thresholds; percentages do not establish branch correctness. |
| `packages/queue/vitest.integration.config.ts` | KEEP | Serial forked integration scope; no automatic dependency startup or credentials. |

## WQ-014 — P2: readiness can succeed after close wins

**Files/symbols:** `src/producer.ts`, `performWaitUntilReady`, final
`await this.withTimeout(Promise.all(...queue.waitUntilReady()))`;
`test/producer.test.ts`.

The Redis polling loop checks lifecycle, but the subsequent BullMQ readiness
await has no final check. A controlled current-source probe used an object with
the real producer prototype and a deferred queue readiness promise, moved
lifecycle to closed while waiting, then released readiness. Result:
`{"waitResolved":true,"isReady":false}`. This establishes the state-machine
race with controlled collaborators, not a reproduced production Redis outage.

Add `if (!this.isReady()) throw new QueueNotReadyError()` after the await.
Preserve timeout duration and rejection identity. Test through the existing
constructor mock seam: Redis initially ready, one queue readiness deferred,
close fully settles, release queue readiness, and expect rejection. Also test
Redis close/error during that second phase and ordinary successful readiness.
The existing “lets close win” test only enters the Redis polling phase.

## WQ-015 — P2: make error classification unable to change operation outcome

**Files/symbols:** `src/redis-telemetry-contracts.ts:93`,
`classifyRedisOperationError`, `observeRedisOperation` and
`instrumentRedisCommands`; `test/redis-telemetry.test.ts`.

Current code reads `error.name` and `error.message` after `instanceof Error`
outside a protective classification boundary. A current-source probe rejected
an Error with a throwing `name` getter. Instead of the original failure, the
wrapper rejected `classification getter failed`, even with no observer.
Confirmed result: `preserved: false`. Normal ioredis errors are not claimed to
have hostile getters; this violates the helper's explicit isolation guarantee
for unknown failures and injected collaborators.

Keep a small local classifier, but contain all inspection (including
`instanceof`) in a try/catch with `internal` fallback. Retain classification
precedence and fixed labels. Never serialize the original object. Exercise
ordinary timeout/abort/connection/not-ready/internal errors, primitives,
throwing name/message accessors, and a proxy whose prototype inspection
throws. Assert the wrapper rejects the exact original value, command calls
retain their original return promise/result, and instrumentation creates no
unhandled rejection. This needs no new shared error framework.

## WQ-016 — P2: observe every fallback disconnect rejection

**Files/symbols:** `src/producer.ts`, `performClose` catch block;
`test/producer.test.ts`.

Current fallback uses:

```ts
for (const queue of Object.values(this.queues)) void queue.disconnect();
this.redis.disconnect();
throw error;
```

The pinned BullMQ implementation returns the backend disconnect promise;
RedisConnection.disconnect awaits its client and rejects if the connection
emits an error while disconnecting. `void` does not consume a rejection.
This is a source/dependency-supported failure path; no live connection failure
was induced. Existing tests configure disconnect to resolve only.

Start each fallback independently, protect synchronous invocation, attach a
rejection handler immediately, and preserve the primary close error. If
waiting for fallback completion, use a single explicit bounded cleanup budget,
not an unbounded allSettled after the original deadline. Always attempt the
owned Redis disconnect even when another fallback fails. Regression cases:
one rejecting disconnect, one synchronous throwing fake, one never-settling
disconnect, and multiple close callers. All owners attempted once, original
failure retained, lifecycle terminal, and no unhandled rejection are required.
Do not manufacture a shared resource framework for this short owner list.

## WQ-017 — P2: remove misleading and order-dependent test evidence

**Exact changes:**

1. In `test/producer.test.ts`, reset the listener map and fresh default mock
   implementations per case. `vi.clearAllMocks()` clears call history, not
   configured implementations; the shared Redis listener map is never cleared.
   Prefer fresh per-client listener state so two clients in one test remain
   independent. In `test/consumer.test.ts`, likewise restore shared Redis quit
   and disconnect implementations; retain its existing listener-map clear.
2. Use fake timers with finally restoration for timeout/drain and late
   publication cases. Attach rejection expectations before advancing timers.
   Do not turn a behavioral test into sleeps or assert only a helper call.
3. In `test/redis-telemetry.test.ts`, replace
   `JSON.stringify([...instruments.values()])` privacy evidence (functions are
   omitted) with assertions on `add.mock.calls` and `record.mock.calls`, exact
   allowed attribute keys, and representative sensitive sentinels.
4. In `test/contracts.test.ts`, add replay to the supported-job table and assert
   its names equal `Object.values(JOB_NAME)`. Keep compatibility fixtures as an
   independent wire oracle instead of generating them from the schema.
5. Add a consumer test where the handler settles after timeout and a following
   delivery proceeds. Assert no second finish event or business completion is
   attributed to the timed-out delivery; preserve the documented requirement
   for handlers to honor cancellation and durable fencing.

Run focused tests individually, in shuffled order, and the full package suite.
Acceptance: stable isolation, meaningful privacy assertions, and unchanged
wire/public exports. Implement WQ-014 and WQ-016 as separate focused behavior
fixes, WQ-015 with its telemetry regressions, then remaining WQ-017 cleanup.
