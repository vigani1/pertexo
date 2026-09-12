# Worker production node execution and capabilities review

Date: 2026-09-12. Primary reviewer fully read all 16 inventory files below.
Worker build passed; three engine/handler unit files / 41 tests passed, plus
three selected ownership tests in node-attempt-runtime (22 other cases skipped
for that invocation). Capability tests were fully inspected, not executed as
a whole here. Local probes used injected adapters; artifact probes created
temporary spool files and closed/removed their own resources. No service ran.

## Individual file judgments

| File | Disposition | Specific judgment |
| --- | --- | --- |
| `apps/worker/src/execution/node-artifact-policy.ts` | KEEP; TEST WQ-108/WQ-110 | Byte bound, minimum expiry and exact metadata comparison are small useful policies. Explicit OR chain identifies every identity field. Add invalid clock/overflow evidence before broadening Date validation; do not infer production invalid clocks from injected values. |
| `apps/worker/src/execution/node-attempt-engine.ts` | KEEP scope semantics; REFACTOR/TEST WQ-110 | Recursively locates graph scope, validates iteration ancestry and branch reachability, pins invocation identity and derives ordered upstreams. Conditions are necessary; prepareNode mixes several named responsibilities and repeats graph scans. |
| `apps/worker/src/execution/node-attempt-execution-environment.ts` | FIX WQ-107; KEEP seam | Shared capabilities remain independent of production handler. Wraps legacy versus executor-controlled dispatch correctly, but boolean becomes true only after awaited marker, allowing concurrent duplicate calls. |
| `apps/worker/src/execution/node-attempt-handler-state-error.ts` | KEEP; P3 WQ-110 | Small common error type breaks an undesirable handler import dependency. Consider closed known-code union only if all callers remain expressible; do not merge it back merely because it has six lines. |
| `apps/worker/src/execution/node-attempt-handler.ts` | FIX WQ-106; TEST/REFACTOR WQ-110/WQ-030 | Coherent claim/verify/load/control/execute/complete workflow; preserves historical provider uncertainty and typed outcomes. Heartbeat starts before unprotected capability construction; stop awaits raw heartbeat; outer catch spans both execution and persistence. |
| `apps/worker/src/execution/node-attempt-runtime.ts` | FIX WQ-106; KEEP ownership model | Explicit transferred/borrowed resources and drain/release phases improve depth. map(close()) still invokes synchronously before allSettled; readiness has no terminal fence. Optional preview capabilities expression is unnecessarily nested. |
| `apps/worker/src/execution/node-execution-capabilities.ts` | KEEP | Neutral per-attempt context and two factories are meaningful shared contracts. Preview retention/identity fields remain optional because production and preview differ. No factory interface expansion solely for mocking. |
| `apps/worker/src/execution/node-execution-runtime-fields.ts` | KEEP behavior; REFACTOR WQ-110 | Preserves optional dispatch/connection/artifact fields; unresolved is true-only by source contract. Partial<NodeExecutionRuntime> is broader than fields this helper can return; narrow its return type to actual optional fields. |
| `apps/worker/src/execution/node-runtime-capabilities.ts` | FIX WQ-106/WQ-108; TEST/REFACTOR WQ-110 | Owns JIT dependencies and a real spool/hash/pending/upload/finalize lifecycle. Cleanup aggregation is useful but eager owner closes, unowned upload stream, overflow byte retention and stalled source cancellation remain. |
| `apps/worker/src/execution/provider-connection-runtime.ts` | FIX/TEST WQ-109; WQ-030 integration | Tenant/purpose identity, rate admission, auth checks and post-decrypt clearing are useful. Cancellation is checked before rate limit and after decryption, not before an intervening database lookup; store interface lacks signal propagation. |
| `apps/worker/test/node-attempt-engine.test.ts` | KEEP; TEST WQ-110 | Real compiler and registries validate Manual, parent branch scope, For Each ordinal upstreams and release overlap. Missing Switch/Parallel/Merge and malformed ancestry/pin matrix; one valid graph does not prove every scope case. |
| `apps/worker/test/node-attempt-handler.test.ts` | KEEP; TEST/REFACTOR WQ-106/WQ-107/WQ-110 | Exact dispatch ordering/capabilities/identity and no-op paths are useful. Duplicate dispatch test is sequential only. Several large repeated fixture objects obscure the one changed scenario. |
| `apps/worker/test/node-attempt-handler-part-2.test.ts` | KEEP; TEST/REFACTOR WQ-110 | Valuable history-preserving cancellation and real HTTP registration outage test. File name is pagination rather than behavior; move to descriptive outcome/control grouping without dropping independent assertions. Undefined-rejection test does not cover hostile object inspection. |
| `apps/worker/test/node-attempt-runtime.test.ts` | KEEP; TEST WQ-106/WQ-110 | Three selected ownership tests passed, including rejected consumer drain ordering and aggregate errors. They omit synchronous closer failures. Activation table is valuable; one composition case leaves real Redis publisher construction enabled and should inject it explicitly. |
| `apps/worker/test/node-runtime-capabilities.test.ts` | FIX fixture/TEST WQ-108–WQ-110 | Real spool files, zero-progress write, combined cleanup and identity matrix are good. Early-return store fake does not consume/destroy supplied file stream; prototype close override restores only after assertion; secret ownership/overflow/blocked source cases incomplete. |
| `apps/worker/test/support/node-attempt-handler.fixture.ts` | KEEP; TEST/REFACTOR WQ-110 | Central lease/delivery/prepared registry adapter is useful. Default heartbeat is vi.fn() returning undefined, making slow tests fail for unrelated reasons; provide a valid idle heartbeat default and override failure explicitly. |

## WQ-106 — protect heartbeat acquisition and finish runtime ownership

Priority P1/P2 FIX. Locations: `node-attempt-handler.ts:146–196,373–401`,
`node-attempt-runtime.ts:130–165,340–443`, and
`node-runtime-capabilities.ts:377–403,470–481`. Integrate WQ-102/PF-02/PF-03.

Current handler starts heartbeat, constructs environment, then enters try:

```ts
const heartbeat = startNodeAttemptHeartbeat(...);
const environment = createNodeExecutionEnvironment(...); // may throw
try { return await executePreparedNodeAttempt(...); }
finally { await heartbeat.stop(); }
```

Injected connection factory threw; after handle rejected, three new heartbeat
calls occurred in 35 ms at interval=10. Probe aborted the queue signal afterward
to stop its own loop. Move environment construction inside heartbeat ownership
protection (or construct it before starting heartbeat if that preserves required
signal semantics). Test both factory failures and no residual timer/renewal.

Runtime drain/release helper does `resources.map(({ close }) => close())` before
allSettled. Synchronous consumer close probe yielded zero preview store/invoker
closes and readiness still resolved. Use deferred invocation per independent
owner, retaining drain-before-release and cached close identity. Do not regress
the already-good aggregate of primary/asynchronous cleanup errors. Capability
runtime repeats eager close calls, and its startup catch discards cleanup errors;
use the same narrow owner discipline and preserve both causes. Its borrowed
dependency overrides must remain borrowed, not accidentally closed.

Heartbeat stop awaits a raw database heartbeat promise. Apply WQ-104's explicit
settlement/owner contract to cancellation-ignoring heartbeat work; do not report
a drained attempt merely because its abort was requested. Test queue shutdown,
late heartbeat completion/failure and no renewal after release. Keep durable
cancel/deadline reason separate from transport shutdown and heartbeat outage.
Existing discriminated HeartbeatFailure correctly represents rejection with
undefined; preserve it while making unknown-value classification non-throwing.

Acceptance: all startup phases protected; synchronous and async failure at each
closer; every sibling attempted exactly once; original/cleanup aggregate intact;
same close promise for concurrent calls; readiness fails terminally; no residual
heartbeat after failed construction; actual in-flight work settled or explicitly
reported unresolved before its owners are released. Do not weaken final database
fences, lease expiration or completion authority to simplify shutdown.

## WQ-107 — reserve the per-attempt dispatch marker before awaiting

Priority P2 FIX. `node-attempt-execution-environment.ts:55–83` tests dispatched
then awaits markDispatched before setting it. Two concurrent beforeDispatch calls
both observed false. Injected probe: markerCalls=2, both promises fulfilled.
The real persistence implementation (`node-attempt-run-store-dispatch.ts:107–143`)
uses coalesce(dispatch_marked_at, clock_timestamp()) and accepts an already marked
running attempt under the same valid lease, so it is intentionally idempotent;
it is not an implicit once-only gate. No real double provider call was made.

Use explicit local state (not_started/marking/marked, with the failure behavior
specified) so another caller cannot acquire dispatch permission while the first
marker is pending. Preserve sequential duplicate_dispatch error, wasDispatched
meaning and uncertain-marker-failure behavior. Do not make all callers await the
same marker and then each send bytes; that would still grant multiple dispatches.
Do not change the database idempotent marker to a non-idempotent write without
the recovery protocol analysis. Current trusted executors generally call once;
this fixes the promised defensive execution seam, not a demonstrated incident.

Acceptance: two simultaneous calls, first marker deferred/succeeds/rejects,
same/different connection fence and binding, queue abort during marker, legacy
before_execute and executor_controlled paths. At most one invocation receives
dispatch permission, and no executor success is accepted without durable evidence.
Keep original mapped connection/binding errors and mark uncertainty truthful.

## WQ-108 — close artifact streams and clear every owned chunk

Priority P2 FIX. `node-runtime-capabilities.ts:165–207,221–290`.

- Overflow check and abort check occur before chunk.fill(0)'s finally. Probe
  with three-byte chunk and maxBytes=2 left the chunk unchanged. Put per-chunk
  cleanup around all processing once ownership has transferred, including
  canceled/oversized chunks. Preserve the documented source-buffer ownership;
  do not mutate buffers beyond the received view.
- Upload body is created inline as createReadStream(spoolPath). Store rejection
  before consuming does not close it. Probe waited for that stream to open,
  threw from put, and observed destroyed=false/closed=false after write rejected.
  The probe then explicitly destroyed and awaited its close. Hold the stream
  locally, observe its errors and close/await it on every exit before removing
  the spool directory. Preserve primary plus cleanup errors and exact pending
  metadata/upload/finalize ordering. A caller-created ReadStream is a real owned
  resource even when the callee is expected to consume it.
- for-await can block in body.next with no cancellation reaction. Deferred source
  probe stayed pending 25 ms after abort until next was released. Specify and
  enforce source ownership/abort through existing stream mechanisms where
  applicable; a generic AsyncIterable may not cooperate with return. Track late
  settlement and keep cleanup safe; do not merely race next and abandon it.
  Coordinate actual runtime drainage with WQ-106 and the HTTP response owner.

Acceptance: zero/exact/over-limit bytes; already-aborted and abort while waiting
for chunk/write/sync/upload/finalize; partial writes and zero progress; source
reject/return failure; store sync throw/rejection before first read and mid-read;
metadata mismatch; pending/finalize failure; file close/directory remove errors
alone and combined. Every acquired file descriptor closes, every consumed chunk
clears including overflow, no upload/finalize after cancellation, and no orphan
temporary directory unless cleanup failure is explicitly surfaced. Preserve
preview retention deadline and database cleanup/recovery for pending artifacts.

## WQ-109 — stop connection work at cancellation boundaries

Priority P2 FIX/TEST. `provider-connection-runtime.ts:41–87,94–120`.
Probe deferred rate-limit admission, aborted request, then allowed admission:
resolveConnectionSecret still began (one lookup). No provider call occurred.
Add cancellation recheck after admission and before decryption. Do not return a
rate-limit classification instead of cancellation merely because admission
finished late unless that precedence is intentional and documented.

ConnectionResolutionDatabase's resolve/assert commands currently do not expose
a signal; complete that narrow cross-package propagation with its database
owner if needed to meet the actual operation bound. The rate limiter likewise
needs an explicit bounded work contract; adding an unsupported extra property
to calls does nothing. Keep post-decrypt zeroization and final currency fence,
provider/auth/workspace identity validation, safe unavailable-credential mapping
and opaque rate-limit dimensions. A queued abort is not authority to send bytes.
Add late resolution/encryption tests and preserve original unknown errors under
WQ-030 rather than replacing them through unsafe instanceof inspection.

## WQ-110 — readability and test plan for production attempts

Priority P2 REFACTOR/TEST, P3 local typing/naming. Implement only after behavioral
regressions above, keeping cross-package invariants with the primary owner.

1. `node-attempt-engine.ts:145–249`: split private named phases for locating
   executable scope, validating lease ancestry/identity and deriving upstream
   references. Preserve branch traversal stopping at Merge, parent-scope removal
   only for the introducing source port, ordinal ordering/deduplication and
   iteration paths. Keep direct input/output executable verification. Use existing
   typed edge port fields rather than Reflect.get solely because the local graph
   type omitted port. Return ordinary types; no generic graph framework.
2. Repeated graph.edges filter/node.find per traversal is an optimization
   candidate, not a measured latency bug. If benchmarks at supported graph/body
   bounds show meaningful cost, build immutable per-verified-projection indexes
   for nodes and incoming/outgoing edges. Define lifetime and invalidation; do
   not process-cache mutable workflow projections or cross release fingerprints.
   KEEP linear scans if complexity reduction/performance is not demonstrated.
3. Handler completion currently nests output-invalid retry inside a broad catch
   that also classifies execution failures. Name the outcome-conversion and
   persistence phases so a reader can tell which error originated where. Keep
   DB completion rejection distinct from executor outcome; maintain exactly the
   permitted second completion on NodeAttemptOutputInvalidError. Preserve durable
   control precedence and original heartbeat failures; no generic error router.
4. In runtime preview setup calculate selectedCapabilities once using explicit
   override/fallback semantics, then one optional spread. Keep transferred preview
   store/invoker ownership on invalid options and borrowed capability overrides.
   Keep drain/release distinction, not one flat disposer list.
5. Narrow nodeExecutionOptionalFields return type to exactly its actual fields,
   not arbitrary Partial<NodeExecutionRuntime>. Do not invent false for the
   true-only unresolved marker. A closed state-error code union is optional if
   it genuinely catches mistyped known codes without casts at every caller.
6. Organize handler tests by admission/control/dispatch/outcome behaviors instead
   of part-2 pagination. Reuse a valid fully injected fixture and override only
   scenario-relevant fields; don't spread one close spy across independent owners
   when testing close counts. Default heartbeat returns a valid idle result;
   fail fast if a supposedly unused dependency is called.
7. Engine matrix: missing node/projection identity, forged invocation, wrong
   side-effect, wrong loop ancestor/depth, branch order/duplicate/omitted path,
   non-reaching output, Switch/Parallel/Merge versions and nested body scopes;
   exact upstream keys and deterministic ordering. Not every synthetic lease is
   reachable through persistence, so distinguish defensive rejection from a
   production authorization defect. Test legacy/current release verification and
   already-aborted prepared execution using actual compiler-produced fixtures.
8. Handler/runtime matrix: capability constructor failure, environment dispatch
   contention, heartbeat failure while work succeeds/rejects, terminal output
   fallback failure, duplicate completion no notification, rejected resync,
   exact queue signal for persistence versus combined signal for execution.
   Current instanceof-only assertions don't prove exact signal ownership.
9. Capability tests: retain actual private-file mode and zeroization assertions;
   add short-write success, empty stream, all metadata mismatch fields, invalid
   injected clock and retained deadline boundaries. Zero returned test secrets
   when the test becomes their caller/owner. Use try/finally for runtime/spies
   and nesting to restore fake timers even if close rejects. Prototype Redis close
   override must be restored on failed assertion and the real lazy client must
   still be disposed. Explicitly inject real-service adapters in unit fixtures;
   a lazy constructor is not the same as a permanently isolated fixture.

Acceptance: narrower code preserves every admission/dispatch/uncertainty/lease
contract; public-interface tests survive private helper extraction; no new
framework, no source changes or integration-service mutations in this review.
