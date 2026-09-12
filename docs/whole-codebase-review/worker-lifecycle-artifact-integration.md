# Worker lifecycle, trigger and artifact integration review

Date: 2026-09-12. Primary reviewer fully read four inventory files. These tests
were inspected, not executed: they connect to configured SQL/Redis/object stores,
delete objects and/or forcibly clear queues. No runtime qualification is claimed.

## Individual file judgments

| File | Disposition | Specific judgment |
| --- | --- | --- |
| `apps/worker/test/artifact-reference.integration.test.ts` | KEEP; FIX/TEST WQ-123–WQ-124 | Verifies corrupt-upload refusal, finalized metadata, ID-only queue payload, capacity metrics and streamed output/zeroing. Shared maintenance consumer acknowledges unrelated deliveries; object deletion leaves database metadata, and the completed queue job is not removed. Multiple acquisitions precede cleanup. |
| `apps/worker/test/trigger-consumer.integration.test.ts` | KEEP; FIX/TEST WQ-123–WQ-124 | Real Bull retry invokes reconciliation twice and records one failure using injected database/reader/scanner. It does not prove a real SQL commit despite its title. Queue is created in suite declaration, even when describe.skip still collects the callback; cleanup failure can skip close. |
| `apps/worker/test/support/workflow-lifecycle.integration.support.ts` | KEEP; FIX/REFACTOR WQ-123–WQ-124 | Explicit fixture instance, role-scoped transactions, nonempty multi-status snapshots and resource registry are useful. Registry misses partial construction and uses concurrent reverse-order closes, not ordered drain. Redis DB 15 ownership comment overlooks transport resilience use of the same DB. |
| `apps/worker/test/workflow-lifecycle.integration.test.ts` | KEEP; TEST/REFACTOR WQ-124 | Archive/restore, fresh runtime, exact redelivery and reordered archive all compare durable projections and unchanged run snapshots. Lifecycle revision parameter does not select event; fake readiness used while worker stopped is intentional fault injection, not production readiness qualification. |

## WQ-123 — keep integration consumers and cleanup inside private ownership

P1/P2 FIX/TEST; consolidate with WQ-115/WQ-118/WQ-121 during implementation.

`artifact-reference.integration.test.ts:40–53,79–101,256–336,346–420`:
the first test uses the configured maintenance queue (default Redis DB 0). Its
handler only records a matching expireArtifacts job but returns success for
every other delivery. If unrelated maintenance work exists, this consumer can
acknowledge it without doing its work. A random workspace/artifact ID does not
isolate a shared queue. Require a disposable Redis namespace and database/object
prefix before this test runs; do not "fix" it by throwing on unrelated jobs and
thereby exhausting their retries. Private ownership is the required precondition.

Both artifact tests physically delete objects in finally but leave pending/
available/deleted metadata in configured PostgreSQL; the first also leaves its
retained Bull job. Track and clean every owned record through a disposable test
database or an explicit reviewed fixture teardown, preserving production artifact
ledger invariants. Don't describe physically deleted but still available metadata
as a clean test environment. Capture ambiguous uploads separately from successful
references so cleanup does not invent an object identity.

Store/database/runtime/verifier constructors occur before the protected scopes.
Register each successful acquisition immediately, and make sibling cleanup
independent of the first close failure. Preserve upload checksum corruption as
an S3Mock-specific fixture; no permission to tamper with real signed provider
requests. Bound fetch requests and consume/cancel their responses; test timeout
alone does not cancel an in-flight upload. The local bounded() timer is cleaned
up correctly, but its raced underlying work still needs an owner.

`trigger-consumer.integration.test.ts:38–52,91–141`: acquire the real Queue in
enabled beforeAll, not while declaring the suite. A skipped test should not
start a Redis client merely from collection. afterAll must close the queue even
when obliteration rejects. Close runtime if producer creation/close fails.
Fixed DB 14 needs the same namespace proof as other worker integration suites.

`workflow-lifecycle.integration.support.ts:506–584,800–882`:

- Its explicit environment object is better than hidden global hooks; retain
  it. Still register owner/api/worker pools, identity, authoring and queue from
  the first constructor, so a later constructor throw doesn't lose earlier ones.
- initialize sets initialized=true before queue.obliterate. A failed queue reset
  then makes a retry skip unfinished initialization. Move successful completion
  after all required stages and use one initializing promise if concurrent calls
  are supported. Track database-created separately from fully initialized.
- createRuntime constructs reader/reconciliation before awaiting runtime and
  registry insertion. Protect partial startup; existing push-before-readiness
  does correctly retain a runtime whose later readiness fails.
- resources.reverse().map(close) inside allSettled starts all closes together.
  It does not guarantee reversed dependency order. Stop dispatch/admission,
  drain consumers, then release their dependencies. Keep close failure evidence;
  don't discard it. queue.close rejection must not skip all PostgreSQL pools.
  Cache one close result if the registry can be drained by more than one caller.
- Redis DB 15 is also used by transport.resilience.integration.test.ts, whose
  proof calls FLUSHDB. Correct the exclusive-ownership comment and isolate
  independent runs; ordinary serial integration config alone does not serialize
  all commands across the repository.

Acceptance: collecting disabled suites makes zero Redis connections; unrelated
job/data cannot be reached by the isolated fixture; every acquired owner closes
on constructor/initialize/test/cleanup failure; no residual metadata/job/object
after success; no false successful cleanup after rejection. Run these ownership
tests with injected adapters first, then a qualified private integration stack.

## WQ-124 — state exactly what each integration scenario proves

P2 TEST/REFACTOR, preserving valuable existing assertions.

1. Trigger consumer test title says "commits it once", but reconciliation is a
   mock that rejects once and resolves an empty array. Rename to transient
   reconciliation retry through BullMQ, then assert the target job reaches
   completed and its attempts/handler call evidence. Real transactional inbox
   and trigger convergence belong to the lifecycle/database suites. Do not
   count mock success as a SQL commit.
2. Artifact invalidJob adds bytes, graph and secret simultaneously and checks
   any rejection. This is sufficient to reject that whole malformed payload;
   it does not prove independent rejection of each forbidden field. Use one
   extra-field case per property and assert the stable queue validation error
   before enqueue, then inspect the private queue to prove no invalid job was
   admitted. Keep the explicit ID-only successful delivery and real checksum
   corruption negative case.
3. Capture successful artifact reference as a narrowed local constant in SQL
   callbacks instead of reference?.artifactId ?? 'missing'. Keep the optional
   outer reference only for partial cleanup. Use descriptive context/builders
   for node-output metadata, with valid limits; retain byte-for-byte download
   and caller-buffer zeroing assertions. Do not replace real streaming evidence
   with buffered fake assertions.
4. Lifecycle fixture seeds intentionally opaque run/event/checkpoint documents
   to prove archive/restore preserves unrelated state. Its empty executable and
   noOpScanner do not qualify scheduling or full executable loading. Label the
   scope explicitly and keep nonempty snapshots; do not require running an
   entire production workflow just to prove this non-mutation property.
5. `workflow-lifecycle.integration.test.ts:247–269` eventForTransition accepts a
   lifecycleRevision but only uses it in an error message. It selects the latest
   workflow event. Current private sequential transitions make that workable;
   no present concurrency bug is asserted. Prefer the returned transition's
   exact event identity if available, or compare an owned before/after event
   set and validate the expected payload. Otherwise rename it latestEventFor-
   Workflow and remove the implication that it filters revision.
6. The stopped-worker dispatcher uses readyCapabilities() returning true on
   purpose, to enqueue durable work before a new consumer starts. Mark this as
   controlled test injection and retain a separate real readiness test; don't
   weaken production readiness requirements based on this fixture.
7. poll() preserves last error as cause, which aids diagnosis. Add terminal
   failed-job detection to waitForQueueJob so a permanent handler failure is
   reported immediately with bounded reason rather than spending ten seconds
   repeatedly asserting completed. Bound each I/O operation and observe its
   cancellation; wall-clock loop conditions alone don't bound a hung query.
8. Baseline catalog is extracted at import via regex from migration 0017 and a
   hardcoded fingerprint. This deliberately tests retained baseline compatibility.
   Validate the extracted identity against the existing compatibility parser;
   do not substitute today's catalog. Avoid importing library symbols through
   the fixture merely to reexport them. Split fixture seeding/projection code
   only where it removes unrelated knowledge; length alone is not grounds to
   fragment the cohesive archive/restore test.

Order: private resources and failure-safe ownership; faithful test names and
missing completion/error evidence; then local narrowing/import improvements.
No source edits, service runs, commits or pushes occurred.
