# API executions, workflow runs and workflow runtime review

Date: 2026-09-12. Scope: 32 frozen inventory files read in full by the primary
reviewer. API build passed; 10 unit files / 83 tests passed. Three real-service
integration files were inspected, not executed. In particular, the Redis-loss
test intentionally stops a Docker Compose service; this review did not run it.
The SSE authorization requirements in ADR-004 were checked. Database internals
remain a separate review, not implicitly certified by this adapter ledger.

## Individual file judgments

| File | Disposition | Specific judgment |
| --- | --- | --- |
| `apps/api/src/executions/index.ts` | KEEP | Exposes reconstruction, reader and publisher interfaces without inventing a second event model. Initial checkpoint wildcard currently exports a small intentional surface. |
| `apps/api/src/executions/initial-workflow-checkpoint.ts` | KEEP; TEST/REFACTOR WQ-089 | Verifies immutable executable/checksum and both admission/current releases before constructing a checkpoint. V1 versus V2 is deliberate; the inline function-selection expression and duplicated structured-definition policy deserve a narrow locality check, not a new generic scheduler. |
| `apps/api/src/executions/postgres-run-event-reader.ts` | KEEP; TEST WQ-089 | Forwards workspace, run, limit and signal into the RLS transaction, suppresses canceled results before/after I/O, and preserves ordinary failures. Small isAborted helper defeats stale TypeScript narrowing across awaits; do not delete it as meaningless indirection. |
| `apps/api/src/executions/redis-run-event-publisher.ts` | KEEP | Compatibility re-export delegates actual implementation to queue package; preserve the aliases and avoid moving publication behavior back into API. |
| `apps/api/src/executions/redis-run-event-source.ts` | KEEP core queue; TEST/REFACTOR WQ-089 | Opaque channel, 512-byte hints, bounded/coalesced queue, subscribe-before-success and explicit disconnect ownership are sound. Reconnect flags describe actual phases. Message-text classification of aborted versus timed-out operations is a small avoidable coupling; timeout/abort/reconnect failure coverage is incomplete. |
| `apps/api/src/executions/run-event-stream.ts` | FIX WQ-085/WQ-087; KEEP reconstruction | Subscribe first, enforce contiguous persisted sequences, ignore cross-run/duplicate hints, and backfill bounded pages. Unknown rejection normalization can leave the promise permanently pending; subscription-to-iterator acquisition and cleanup must be covered by ownership. |
| `apps/api/src/workflow-runs/controllers.ts` | FIX WQ-087/WQ-090; REFACTOR WQ-089 | Explicit route guards/statuses/idempotency and backpressure-aware writes are useful. Transport ownership is mixed with route projection, iterator acquisition precedes cleanup protection, cleanup can block destination closure, and metrics can terminate delivery. |
| `apps/api/src/workflow-runs/errors.ts` | KEEP; TEST WQ-089/WQ-055 | Specific application errors preserve non-disclosure and conflict semantics. Broad TypeError/Zod classification should not swallow adapter/programming failures merely because they share an input-error class; distinguish request parsing from runtime failure in tests before narrowing mappings. |
| `apps/api/src/workflow-runs/event-streamer.ts` | KEEP; TEST WQ-089 | Positive payload-key allowlist removes actor/reason/internal content before public validation. JSON round trips separate existing transport seams; do not remove validation without retaining equivalent trust checks. Hoist the invariant raw-event schema rather than reconstructing it per event. |
| `apps/api/src/workflow-runs/guards.ts` | KEEP | Read/cancel remain allowed in suspended and pending-deletion workspaces; start/replay require active workspace. Four distinct capabilities are readable and must not collapse into a generic mutation guard. |
| `apps/api/src/workflow-runs/index.ts` | KEEP | Public feature surface remains stable. If extracting transport internals, do not automatically export every helper through this barrel. |
| `apps/api/src/workflow-runs/module.ts` | KEEP; TEST WQ-089 | Explicit dependencies and use-value use cases avoid hidden resource ownership. ApiLifecycleModule is shared. Reflection-only tests are registration evidence, not complete Nest resolution. |
| `apps/api/src/workflow-runs/ports.ts` | KEEP | Separate start/replay/cancel commands preserve idempotency scope and semantics. Event visibility path is finite. Persistence records are internal read models rather than public JSON DTOs; avoid replacing nullable Dates with wire strings here. |
| `apps/api/src/workflow-runs/postgres-persistence.ts` | KEEP; TEST WQ-089 | Shares checkpoint factory, maps known persistence errors and publishes only post-commit hints; failures of hints do not undo acceptance. The workflowId discriminant is understandable for the two internal command forms. Injected database close ownership must be documented/tested, not silently changed. |
| `apps/api/src/workflow-runs/sse-authorization-lifetime.ts` | FIX WQ-086; TEST WQ-087 | Fresh session identity/expiry and workspace authorization are checked; concurrent refresh coalesces, deadline is independent of backpressure, and abort observers are removed. Near-expiry successful refresh repeatedly schedules already-past refresh times. Keep tagged outcomes and explicit deadline logic. |
| `apps/api/src/workflow-runs/stream-cleanup.ts` | KEEP error aggregation; FIX integration WQ-087 | Thunks catch synchronous failures and failed:boolean correctly preserves undefined rejection. Sequential awaits still let one nonsettling cleanup block all later owners. Single-error instanceof also needs WQ-055-style unknown containment where hostile errors are supported. |
| `apps/api/src/workflow-runs/tokens.ts` | KEEP | Stable named symbol consistently connects guards to the registered authorization dependency. |
| `apps/api/src/workflow-runs/use-cases.ts` | KEEP command separation; FIX WQ-087; REFACTOR/TEST WQ-089 | Distinct permissions and hashes include actor/workspace/source identity. Fresh authorization before each frame is required, not wasteful duplication. Eager watchdog lifetime is returned behind a lazy generator whose cleanup may never start. Cancel duplicates the same requestIdentifiers projection already used by start/replay. |
| `apps/api/src/platform/workflow/workflow-runtime.module.ts` | FIX WQ-065 extension; KEEP release projection | Supported versus placeable definitions and readiness support versus execution history encode different contracts. Runtime creates several owners before returning; close evaluates methods before allSettled can catch sync throws. Narrow projection helpers are cohesive; avoid arbitrary file splitting by line count. |
| `apps/api/test/executions/postgres-run-event-reader.test.ts` | KEEP; TEST WQ-089 | Correctly checks signal forwarding and abort behavior. Test title claims workspace/RLS mapping but assertion checks signal and count, not exact workspace/run/limit; this fake is not live RLS proof. Add ordinary rejection and post-resolution abort rows. |
| `apps/api/test/executions/redis-run-event-publisher.test.ts` | KEEP | Public API aliases exercise bounded reference shape, opaque channel, late timeout settlement, repeated close, invalid options and throwing metrics. Detailed implementation findings remain in queue ledger; no second publisher implementation is needed. |
| `apps/api/test/executions/redis-run-event-source.test.ts` | KEEP; TEST WQ-089 | Positive reconnect, coalesced overflow, malformed JSON, resync and abort are useful. Add bounded subscribe/ping timeout, rejection, late result, already-aborted input, wrong channel and oversize hints, closed-source listener behavior and rejected resubscribe. |
| `apps/api/test/executions/run-event-stream.integration.test.ts` | TEST/FIX WQ-088 | Real persistence replay and publication-to-stream timing are meaningful. Setup can leave partially assigned owners, teardown dereferences redis before remaining closes, and iterator has no finally on assertion failure. It is not an HTTP transport or real authorization test. |
| `apps/api/test/executions/run-event-stream.resilience.integration.test.ts` | FIX WQ-088; KEEP recovery story | Genuine lost-hint/restart/backfill sequence. Iterator return precedes service restoration in finally, so failure can leave Redis stopped. Fixed shared Compose project and configured Redis URL require explicit target-consistency/disposable-environment checks. |
| `apps/api/test/executions/run-event-stream.test.ts` | TEST/FIX WQ-085/WQ-087/WQ-088/WQ-089 | Covers subscribe/read race, paging, duplicate/gap repair and multi-error cleanup. Timeout helper never clears its timer and one polling loop has no local deadline. Missing malformed persisted-page and hostile iterator rejection cases are specific, not a generic coverage percentage complaint. |
| `apps/api/test/workflow-runs/controllers.test.ts` | KEEP; TEST WQ-089/WQ-090 | Exact wire frame, actor context precedence and metadata projection assertions are useful. Mocked use cases do not prove guards, auth freshness or HTTP error mapping. Add sink-failure continuity, malformed headers, response-preparation failure and listener cleanup. |
| `apps/api/test/workflow-runs/event-streamer.test.ts` | KEEP; TEST WQ-089 | Explicit removal of secret operator note/actor is good allowlist evidence. Add every allowed field, rejected malformed allowed fields, unknown persisted event behavior and cleanup after projection failure. |
| `apps/api/test/workflow-runs/module.test.ts` | KEEP limited smoke test; TEST WQ-089 | Checks two providers/controller only. Either name as partial registration smoke coverage or add full module resolution using the existing platform fixture, not another huge copied dependency graph. |
| `apps/api/test/workflow-runs/postgres-persistence.test.ts` | KEEP; TEST/REFACTOR WQ-089 | Real compiler-generated fixtures prove release pinning and V1/Condition/Switch/For Each checkpoint selection. Keep authentic graph structure; add Parallel versions and negative identity paths. Large graph fixtures dominate a file that also tests adapter mapping; organize by behavior, not arbitrary size. |
| `apps/api/test/workflow-runs/sse-transport.test.ts` | KEEP; TEST WQ-086/WQ-087/WQ-090 | Strong 10,000-frame listener-removal and 1,000-frame backpressure assertions, session mismatch and abort tests. Noncooperative cleanup and same-expiry repeated refresh are absent. Several fake-timer finally blocks restore timers only after awaited cleanup and can skip restoration on rejection. |
| `apps/api/test/workflow-runs/use-cases.test.ts` | KEEP; TEST/FIX WQ-088/WQ-089 | Capabilities, workspace lifecycle, metadata, expiry and stalled refresh are usefully separated. Canonicalization tests only assert hex shape; a stream test consumes one frame without return/abort and leaves the watchdog running. Fix lifecycle hygiene and strengthen exact behavior assertions. |
| `apps/api/test/platform/compatibility-rollout.integration.test.ts` | KEEP scenario; TEST/FIX WQ-088 | Complete predecessor/target approval and retained-publication story correctly remains ordered inside one test. Fifteen initial owners and later probe pairs are acquired before try; partial acquisition lacks rollback. Parallel close rejects before all owners settle, potentially racing database drop. Static roles conflict with configurable role inputs. |

## WQ-085 — settle iterator failures without executing rejection values

Priority P2; FIX. `executions/run-event-stream.ts:153–167` attaches `.then`
handlers to the producer promise but does not observe the promise returned by
that `.then`. The rejection handler first removes the abort listener and then
does this:

```ts
reject(error instanceof Error ? error : new Error(String(error)));
```

An ordinary null-prototype object cannot be converted using String; proxies
can also throw during instanceof. The handler throws, its returned promise is
unobserved, and the outer promise never settles. The abort listener is already
removed, so subsequent cancellation does not rescue the stream.

Local current-build probe: an injected subscription rejected with
`Object.create(null)`; captured one unhandled TypeError, observed unsettled
read/zero subscription closes before and after explicit abort. The probe used
two bounded 40 ms observations and no network service. This is a defensive
adapter failure, not a claim that Redis wire JSON can construct such an object.

Plan: reject the original unknown value without inspecting it; outer stream
cleanup already tracks unknown failures explicitly. Move listener removal into
a guaranteed settlement/finally path that also covers synchronous iterator.next
throws. Ensure every invoked promise has an attached rejection observer even
when abort wins. Do not convert arbitrary objects into public/log text here.

Acceptance: Error, string, undefined, null-prototype object, throwing coercion
and hostile getPrototypeOf rejection each settle once, preserve the original
failure, invoke subscription close/iterator return as applicable, remove abort
listeners, and produce zero unhandled rejections. Also test synchronous next
throw, pending-next abort and late success/rejection after abort. Implement
before the broader cleanup changes so the regression has an independent cause.

## WQ-086 — do not spin authorization refresh against an unchanged expiry

Priority P2; FIX. `sse-authorization-lifetime.ts:64–75,125–141` computes the
next idle refresh as `authorizationDeadline - 1_000`. A successful refresh
whose session expiry remains less than one second away cannot move that
deadline. The watchdog repeatedly schedules a zero-delay wait and reads
session/workspace again until expiry.

Local current-build probe used a valid fixed expiry 400 ms away, interval
5,000 ms and immediately resolving access adapters. In 150 ms it performed
113 session reads and 113 workspace reads, without revocation. The exact count
is machine-dependent; the repeated past-due scheduling is the defect, not a
claimed production throughput benchmark.

Plan: represent the next idle refresh attempt separately from the immutable
session-expiry ceiling. After refreshing inside the final lookup-budget window
without extending that ceiling, wait for expiry/stop instead of retrying the
already-past refresh threshold. Recompute only when an actually newer verified
deadline warrants another idle refresh. Do not weaken ADR-004: every visible
frame still gets fresh authorization; no cache may replace that check; neither
slow refresh nor scheduling can extend session expiry or the five-second cap.

Acceptance: fake-clock matrix at >5 s, 1 s, 999 ms, exact expiry and changed
expiry; assert bounded idle lookup counts, exact revocation, no post-expiry
frames, concurrent-refresh coalescing, and clean shutdown. Include successful
fixed-expiry lookup (existing stall/rejection tests do not expose this loop).

## WQ-087 — own stream acquisition and bound cleanup without hiding live work

Priority P2; FIX/TEST. Three distinct ownership transitions need protection:

1. `run-event-stream.ts:194–200` acquires a subscription and then obtains its
   iterator before entering try. A throwing iterator factory skips close.
   Local probe confirmed `acquisitionClose = 0`.
2. `use-cases.ts:239–256,260–268` starts authorization watchdog/timer before
   returning a lazy async generator; its iterator factory is again outside
   try. Returning the generator before its first next does not execute its
   finally. A failed response preparation or adapter factory must have an
   explicit owner even if iteration never begins.
3. `stream-cleanup.ts:16–22`, `controllers.ts:315–325` and generator finally
   blocks await each cleanup without a deadline. A nonsettling iterator return
   prevents destination.end and outer drain-registration release. Local writer
   probe with next rejecting and return never settling observed aborted=true,
   one return call, ended=0 and unsettled writer after a bounded observation.

Plan: establish cleanup ownership immediately after acquisition; initialize
optional iterator inside the protected region and clean up whatever was
actually acquired. Give authorization lifetime an explicit lifecycle that
works for never-started and partially started iteration. Keep production
subscription cancellation before iterator return. Separate immediate transport
close from awaiting potentially noncooperative producer cleanup; apply the
existing API shutdown budget/failure-reporting contract rather than adding
three unrelated timeout constants. Each cleanup must be invoked safely even
if an earlier cleanup throws or stalls. Preserve primary plus secondary
failures, including rejection with undefined.

A Promise.race timeout only bounds waiting; it does not prove Redis, database
or iterator work stopped. Retain observation/ownership of late cleanup and
report incomplete release. If an owned concrete adapter cannot be force-closed,
record that fact instead of releasing bookkeeping and reporting success.

Acceptance through the actual nested streamer/use-case/writer seam: factory
throws, response preparation throws, return-before-first-next, first-read
failure, external abort, authorization loss under backpressure, never-settling
close/return, simultaneous primary/cleanup failures and late cleanup settlement.
Assert transport closure, attempted resource closers, timer/listener cleanup,
drain bookkeeping and honest incomplete-cleanup outcome. Retain ordinary
backfill/order/security tests. Coordinate with WQ-057 application shutdown and
PF-02; do not build a general-purpose lifecycle framework.

## WQ-088 — make streaming and rollout fixtures safe on failure

Priority P2; FIX/TEST. Changes are to fixtures/test infrastructure, not the
production execution model.

- `run-event-stream.resilience.integration.test.ts:305–312`: service restore
  currently follows awaited iterator return. Protect restore in its own
  failure-isolated finally and preserve both errors. Scope Docker Compose to an
  explicitly disposable project, verify configured Redis URL belongs to that
  target, and require the existing opt-in plus disposable-target evidence.
  Environment-variable presence alone is not that evidence (see WQ-060).
- Both execution integration files: acquire/register owners incrementally;
  do not dereference unassigned redis/publisher in afterAll. Abort/return the
  stream in test-local finally, bound waits, await all close settlements before
  proceeding, and retain assertion errors alongside cleanup failures.
- `run-event-stream.test.ts:108–121`: clear the timeout in finally on both
  success and failure; bound the reader.calls polling loop and release its
  iterator if the assertion times out. Prefer existing controlled/deferred
  readiness signals to real setTimeout(0) polling.
- `workflow-runs/use-cases.test.ts` test "authorizes the stream, proves the run
  exists, and delegates the cursor": retain one iterator and abort/return it
  in finally after the first frame. No live authorization watchdog may outlast
  this test. Wrap timer restoration in an outer finally in this file and
  `sse-transport.test.ts`, including when returning rejects.
- `compatibility-rollout.integration.test.ts`: retain its intentionally ordered
  rollout story, but put every successful acquisition into rollback ownership
  before acquiring the next; await all settlements before dropping its unique
  database. Use parsed configurable roles consistently in CREATE/GRANT and role
  assertions, with safe identifier quoting. Existing generated database names
  are safe; this is not a demonstrated SQL injection. Decompose large fixture
  construction into named phase helpers without hiding the approval evidence.

Acceptance: injected failure at each acquisition point still attempts only
created owners; iterator failure cannot skip Redis restoration; all local
timers/listeners end; full close settles before database drop; custom-role
configuration is either supported consistently or rejected clearly upfront.
Test cleanup logic with fakes before any authorized destructive qualification.

## WQ-089 — focused locality and behavioral test completion

Priority P2 for named missing behavioral evidence, P3 for local readability.

Changes to source should remain small and behavior-preserving:

```ts
// Cancel already has the same input facts as start/replay.
const result = await persistence.cancel({
  actorId: input.actor.actorId,
  workspaceId: input.routeWorkspaceId,
  runId: input.runId,
  ...(input.reason === undefined ? {} : { reason: input.reason }),
  ...requestIdentifiers(input),
});
```

Extract the SSE destination/encoding/drain/write implementation from
`controllers.ts:266–383` into one private transport module if doing so makes
the controller read as route parsing plus one transport call. Keep actual
transport tests at write/HTTP seams, not tests for every helper. Hoist the
raw-event schema in `event-streamer.ts:50–58`. Give the private Redis subscribe
error a finite reason instead of deriving metrics from message.includes.
For initial checkpoint selection, name `checkpointFactory` before invocation
and compare the worker's `core-definition-identities.ts` policy during worker
review; share policy only if it is genuinely the same versioned rule. Do not
remove executable verification or rewrite checkpoint versions for style.

Targeted tests:

- Stream reconstruction: over-limit pages, holes/duplicates/out-of-order rows,
  invalid event type/time/sequence, payload over 256 KiB, exact page boundary,
  abort while a page is in flight, and closed iterator. Assert failure before
  malformed data is emitted and all resources released.
- Redis source: subscribe/ping timeout/rejection, no client retained after
  either, late settlements, oversize/wrong-channel hints, resubscribe rejection
  and subsequent recovery, repeated close and listener counts. Do not infer
  these from the happy-path reconnect test.
- PostgreSQL reader: exact workspace/run/cursor/limit/signal arguments,
  unchanged ordinary failure, and no returned page after late cancellation.
- Start/replay hash tests: compare commands for reordered keys, distinct
  actor/workspace/source/version/input/deadline, absent input versus null, and
  metadata-only differences. Current tests prove only 64 lowercase hex chars,
  not canonicalization. Preserve existing stored hash domain/version bytes.
- Persistence mapping: named known errors and unchanged unknown errors on
  get/start/replay/cancel; replayed acceptance publishes zero hints; unchanged
  cancel publishes zero hints; failed hint does not turn committed work into
  rejection. Close forwarding is exactly once at its owning runtime seam.
- Checkpoint factory: unsupported release, checksum/epoch mismatch, root V1,
  Condition/Switch/For Each and supported Parallel V1/V2/V3. Generate real
  executable fixtures and assert identity, next sequence and budget, not just
  schemaVersion. Keep tests of compiler behavior in the engine package.
- Public event projection: all allowed fields plus secret/unknown removal,
  malformed allowed values and stream cleanup on schema failure. Full HTTP
  tests should assert mapped status/body and guard-before-use-case ordering;
  controller mocks alone do not prove those contracts.

Acceptance: each test has a named observable invariant and valid minimal
fixture; refactors preserve successful output, exact idempotency hashes,
authorization ordering, durable authority and supported public exports. Do
not split tests or modules solely to reach a line-count target.

## WQ-090 — visibility metrics must not terminate event delivery

Priority P2; FIX. `controllers.ts:303–308` invokes
`visibilityMetrics.recordFirstEligibleFrame` without containment. The default
adapter also calls its meter without containment. A probe with two valid frames
and a throwing metric observer wrote one frame, returned the producer and ended
the destination; the second valid frame never reached the client.

Plan: contain metric observer failure at the transport call site, as other
dependency telemetry already does. Preserve the actual write outcome and
cursor; do not retry destination.write when instrumentation throws. Keep
first-eligible-sequence cardinality and record only after accepted/drained
delivery. This complements WQ-064's telemetry isolation but is not the same
trace-callback duplication defect.

Acceptance: throwing clock/histogram/counter through the real adapter, and an
injected throwing observer, cannot change frame order/count, producer cleanup,
abort behavior or original transport failure. Existing latency/path/clock-skew
tests remain. Construction-time telemetry failure is addressed separately by
runtime ownership/default telemetry containment, not swallowed around durable
business operations.

## Extension of WQ-065 — workflow runtime partial startup and close

`platform/workflow/workflow-runtime.module.ts:262–342,370–389` acquires authoring,
publisher, run adapter and event database before later validation/telemetry can
throw. Register rollback as acquisition succeeds. Its allSettled array invokes
closers eagerly; a synchronous authoring.close throw skips all later calls.
Public factory probe with injected authoring/publisher, persistence and streamer
overrides produced zero publisher closes and a cached rejected close promise.
Keep promise identity caching but invoke each closer through a safe thunk.
Preserve owned/injected contract intentionally; do not start closing borrowed
identityRuntime or independently supplied runPersistence by accident. Add real
runtime composition tests for partial acquisition, sync and async close errors,
every-owner attempt, repeated close and late readiness completion, coordinated
with application-wide WQ-057. No provider or Redis service is needed for those
failure-injection tests.

## Implementation order

WQ-085 and WQ-086 are focused regressions/fixes. Then WQ-087 and WQ-065/WQ-057
integration, with WQ-088 before fault-injection qualification. WQ-090 can be
independent. Complete WQ-089's behavioral evidence before its optional local
extractions. Authorization, replay, retained release support and database
authority must remain unchanged across all units.
