# Worker schedule integration and benchmark fixture review

Date: 2026-09-12. Primary reviewer fully read the 1,125-line inventory file.
No integration or benchmark ran. A fully injected runtime probe reproduced the
test gate's shutdown dependency cycle; the gate was then released and runtime
fully closed. All database/queue/telemetry dependencies were injected.

## Individual file judgment

| File | Disposition | Specific judgment |
| --- | --- | --- |
| `apps/worker/test/schedule-trigger.integration.test.ts` | KEEP; FIX/TEST WQ-125; REFACTOR WQ-126; WQ-123 extension | Strong published Schedule → reconciliation → occurrence → run.started proof, duplicate occurrence contention, workspace saturation/fairness, lease recovery and no-new-scan after close. Benchmark gate can deadlock shutdown; skipped-suite Queue construction, partial owner registration, fixed namespace collision, readiness/removal race and weak checksum assertion need improvement. |

## WQ-125 — release the benchmark scan gate before runtime drain

P2 FIX/TEST. `schedule-trigger.integration.test.ts:564–598,704–747` and
`src/triggers/trigger-runtime.ts:236–246`.
With PERTEXO_Q11_OPERATION_TIMING=1, scanDue awaits benchmarkScanRelease.promise
without observing input.signal. The scanner wrapper's close resolves that gate,
but trigger runtime close first aborts and awaits scannerLoop, and only then
calls scanner.close. If an assertion or setup step fails before the normal gate
release, afterAll cannot reach the operation that releases its awaited scan.

Injected production-runtime probe with the same scanner gate/close pattern:
after 25 ms, **closed=false, scannerCloses=0**. Manually resolving the gate let
close finish. This proves the dependency cycle locally, not a measured service
shutdown duration.

Plan: the test owns its benchmark gate independently of the scanner adapter.
Release it in an outer finally before awaiting runtime shutdown, and make the
gate wait honor the scan's abort signal with listener cleanup. After release,
check cancellation before invoking the real SQL scanner. Never rely on
scanner.close to unblock a task that must finish before scanner.close is called.
Coordinate production ownership work under WQ-102, but fix this fixture even if
runtime close gains a deadline; timeout is not a substitute for releasing owned
test work. Keep timing start immediately before releasing the verified due
schedule, excluding earlier graph creation/migration/compatibility setup.

Acceptance: fail before publication, after materialization, after due-state
verification and during scan; gate always released/disposed, scanner.close
reached, no post-abort SQL invocation, no open task or unhandled rejection.
Timing-disabled path still runs without gate delay; timing-enabled path emits
exactly one sample for the named successful operation with the declared polling
boundary. Use fake scanner/barrier tests before running any service benchmark.

## WQ-123 extension — schedule suite ownership and isolation

- Queue is created at suite declaration (`:228–250`), so disabled collection
  still constructs an active Redis owner. Move to enabled setup with immediate
  teardown registration. Register pools and nested adapter constructions even
  when a later constructor throws.
- resources.push(identity, authoring) happens only after both construction and
  authoringOptions. runtimeScanner also exists before createTriggerRuntime.
  Two direct scanners and each dispatcher similarly have earlier owners before
  registration. Record each acquisition individually. afterAll discards all
  close failures and queue.close rejection can skip database drop.
- duplicateProducer (`:655–670`) has no try/finally or resource registration.
  Ensure readiness/publish failure still closes it. Multiple runtimes remain
  registered when explicitly closed unless removed; make ownership transfer and
  one shared close result explicit, without indexOf=-1 accidental splice.
- Redis DB 13 is also the preview suite's namespace. Clearing triggerLifecycle
  alone leaves coordinator jobs created by this test. Own and remove all exact
  test jobs or a positively verified disposable namespace; serial file execution
  does not isolate independent benchmark/integration invocations.
- In runner-owned mode the database is deliberately not dropped here. Preserve
  that ownership transfer. Cross-read of benchmark runner shows it generates
  pertexo_q11_<UUID> and owns cleanup; do not call the generated normal path a
  SQL injection vulnerability. Validate externally supplied runner mode/name and
  actual endpoint ownership before migration/fixture writes, and continue to
  leave final database deletion to the runner.
- Reuse the inspected disposable-database helper for the generated non-runner
  database rather than another 500-poll drop loop. Keep quoted identifiers,
  no forced client termination and visible residual-connection failure.

## WQ-126 — separate schedule fixture mechanics from scenario evidence

P2 REFACTOR/TEST; no arbitrary line-count target.

1. Keep the broad scenario: it proves a real cross-layer sequence, not redundant
   micro-tests. Move authoringOptions, compatibility activation and owned role
   queries into an explicit Schedule fixture module. The fixture should own
   setup/cleanup and return meaningful operations/identities; assertions about
   occurrence identity, durable counts, saturation and fairness remain visible.
   Reuse existing compatibility fixture mechanisms after checking exact release
   history and current/target readiness semantics. Don't duplicate production
   catalog filtering in yet another place or replace retained release behavior.
2. `authoringOptions:102–195` has legitimate distinctions: deprecated definitions
   may be supported for existing nodes but not placement; executors must be
   active and exact-pinned. If shared with API fixture assembly, name this
   policy or reuse the existing catalog constructor; preserve both catalogs.
   A boolean placement flag is tolerable privately, but don't propagate boolean
   configuration throughout callers.
3. Reconciliation materialization is observed before queue.remove at roughly
   line 655, but durable materialization can precede Bull acknowledgement. Wait
   for the exact original job's terminal completed state before removing it,
   fail immediately on failed, assert removal/absence, then republish and await
   new completion. Keep existing completed inbox count. Otherwise a locked job
   can make this supposedly deterministic redelivery test flaky.
4. Competing scanner assertions prove one combined claim and unchanged existing
   run/event/checkpoint/outbox counts. Retain them. If the plan needs an explicit
   SKIP LOCKED-held-row proof, add a held-lock barrier at the database seam; two
   Promise.all calls alone do not prove actual overlap. Name the current test
   as contention/uniqueness evidence without overclaiming lock timing.
5. The final canonicalOutboxPayloadChecksum(...).toMatch(hex regex) only checks
   a checksum function's output shape, not stored transport integrity. Select
   the event's persisted payload_checksum and compare against the canonical
   checksum of its exact payload. Do not add a second hash implementation.
6. Benchmark records a specific release-to-durable-run.started interval with
   25 ms polling. Retain that honest boundary; it is not pure scanner execution
   latency or end-to-end node completion. Detailed scanErrors/scanResults arrays
   should be bounded if retained for long runs and report safe diagnostic facts.
   Formatting the long emitted JSON over multiple lines is a local readability
   improvement with unchanged output schema, not a separate commit unit.
7. Direct SQL due-time/entitlement/lease changes are intentional fixture setup.
   Keep them scoped and named, not hidden behind a general arbitrary mutation
   helper. Distinguish graceful runtime reconstruction plus expired lease
   seeding from an actual process crash. Existing negative scan observation
   follows runtime.close and four 25 ms polling periods; preserve the target
   count/due/lease assertions while adding controlled scan-entry evidence in
   unit tests, rather than relying on wall time for all lifecycle coverage.

Order: gate deadlock and ownership/isolation, exact job/checksum evidence, then
fixture locality and benchmark formatting. No implementation, service execution,
commit or push occurred.
