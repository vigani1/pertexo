# Worker platform, configuration and process lifecycle review

Date: 2026-09-12. Scope: 34 frozen files read in full by the primary reviewer.
Worker build passed; seven selected unit files / 52 tests passed. Bootstrap and
compiled lifecycle tests were read, not run in this batch: their default
readiness marker targets shared `/tmp` filenames, and process fixtures invoke
real application lifecycle. Probes below injected readiness markers, signals
and dependencies; no real signal, database, Redis or provider operation ran.

## Individual file judgments

| File | Disposition | Specific judgment |
| --- | --- | --- |
| `apps/worker/package.json` | KEEP; TEST WQ-095 | Pinned dependencies and compiled production entrypoint match project architecture. Separate main/lifecycle coverage reports are intentional. Test commands that spawn dist-based children need an explicit build prerequisite/evidence story, not implicit stale dist. |
| `apps/worker/src/app.ts` | FIX WQ-057 extension/WQ-092; PF-03 | Creates distinct worker/dispatcher database runtimes and gates dispatch on compatibility/readiness. Acquisitions before try and cleanup failure paths have incomplete ownership; a throwing fallback logger can turn a metric failure into startup failure. |
| `apps/worker/src/config/worker-config.ts` | FIX WQ-094; TEST/REFACTOR WQ-095 | Explicit limits, capability allowlist, heartbeat-before-lease, production telemetry and deployed HTTPS are purposeful conditions. Resource sampling lacks timer maximum. Large destructuring is configuration projection, not a god service; focus on nested section locality and cross-field tests. |
| `apps/worker/src/main.ts` | FIX existing PF-02/PF-03 | Correctly starts telemetry before dynamic application imports. Raw error-name classification, unguarded failure logging and discarded shutdown owner remain the already documented entrypoint issues; do not invent duplicate WQ work. |
| `apps/worker/src/platform/database/database.module.ts` | FIX WQ-091; WQ-057 extension | Checks configured worker role and shares release readiness policy. withWorkspace wrapper drops its third options argument, contradicting the assigned WorkspaceDatabase method contract. Lifecycle registration needs complete app-level failure isolation. |
| `apps/worker/src/platform/observability/observability.module.ts` | KEEP; WQ-057 integration/PF-03 | Delegates Nest registration to shared observability implementation with explicit tokens. Keep telemetry lifecycle behavior at that implementation and actual process composition seam. |
| `apps/worker/src/runtime/abortable-delay.ts` | KEEP; TEST WQ-095 | One internal delay implementation intentionally distinguishes abort-rejecting work from abort-resolving supervisor waits. Clears timers/listeners and rechecks abort registration race. Two descriptive public functions are clearer than boolean arguments at callers. |
| `apps/worker/src/runtime/artifact-metrics.ts` | KEEP; TEST/CONDITIONAL WQ-095 | Two database observations have distinct schemas and no shared transaction requirement. Sequential writes can stop later observations if a sink throws; caller isolation and close ownership must be verified in outbox review. Do not assume a telemetry query is free or cancelable. |
| `apps/worker/src/runtime/background-task-deadline.ts` | KEEP local mechanism; TEST WQ-095 | Clears timer on task settlement, observes late rejection and preserves unknown failure. Unref avoids retaining the process; timeout only bounds waiting and does not cancel the task. Evaluate each supervisor's ownership separately. |
| `apps/worker/src/runtime/worker-drain-state.ts` | KEEP | Monotonic admission flag is the right small state representation. No reopen transition exists; do not add a generic status enum to this two-state responsibility. |
| `apps/worker/src/runtime/worker-process-keepalive.ts` | KEEP; TEST WQ-095 | Lifecycle-owned ref timer intentionally keeps a disabled-consumer worker alive; maximum signed timer value avoids overflow. Bootstrap/close are idempotent. |
| `apps/worker/src/runtime/worker-process-shutdown.ts` | FIX existing PF-03 | Existing plan already owns partial install rollback, sync/async close caching, diagnostic isolation and startup close without signal. Preserve two real OS signal names and one close owner. |
| `apps/worker/src/runtime/worker-readiness-monitor.ts` | FIX WQ-092/WQ-093 | Tagged checking/stopping state, coalesced checks and final revocation after pending marker writes prevent ordinary resurrection. Logging precedes required revocation; unbounded in-flight check blocks stop while old ready marker stays valid. |
| `apps/worker/src/runtime/worker-readiness.ts` | KEEP; TEST WQ-093/WQ-095 | Checks drain both before and after async probes—correctly handles the race identified in API readiness. Optional trigger/node readiness reflects real optional consumers. Probe completion still needs a bounded owner at monitor/application scope. |
| `apps/worker/src/runtime/worker-resource-monitor.ts` | FIX WQ-092; TEST WQ-094/WQ-095 | Consecutive unhealthy samples reset on recovery and emit one drain signal. Logger throw skips signaling permanently after drainStarted=true. Histogram and interval are lifecycle resources; repeated bootstrap and shutdown tests are absent. |
| `apps/worker/src/testing.ts` | KEEP | Explicit application testing exports prevent sibling-private imports without exporting unrelated transport internals. Do not turn this into a catch-all barrel to satisfy tests. |
| `apps/worker/src/worker.module.ts` | KEEP composition; WQ-057 extension | Explicit optional runtime providers and separate runtime shutdown registration expose ownership. Repeated conditional spreads are verbose but type-checked. Only simplify by named groups if exact optional-dependency meaning and one shared instance survive. |
| `apps/worker/test/abortable-delay.test.ts` | KEEP; TEST WQ-095 | Proves supervisor elapsed/abort cleanup and operational abort rejection. Add already-aborted, elapsed operational and abort-during-registration cases with exact timer/listener counts. |
| `apps/worker/test/lifecycle-coverage-config.test.ts` | KEEP limited guard; TEST WQ-095 | Protects explicit owner inventory/report path/thresholds. Static config equality is not evidence that measured files exercised every lifecycle contract. |
| `apps/worker/test/worker-bootstrap.test.ts` | TEST/REFACTOR WQ-091/WQ-092/WQ-095; WQ-057/PF-03 | Real Nest wiring, role checks and consumer capability gates are valuable. Only successful cleanup is covered, several assertions occur before finally, shared logger mocks accumulate, and marker path is global. Add actual sibling-failure ordering and wrapper-options proof. |
| `apps/worker/test/worker-config.test.ts` | TEST/REFACTOR WQ-094/WQ-095 | Defaults and bounded cohort/job/lease checks are useful. Two large almost-identical expected defaults obscure meaningful overrides. Production insecure-KMS row omits required OTLP, so it fails before reaching the KMS protocol check. |
| `apps/worker/test/worker-process-keepalive.test.ts` | KEEP; TEST WQ-095 | Checks one owned timer and removal with fake clock. Add double bootstrap, close-before-bootstrap and repeated shutdown without changing process-retention contract. |
| `apps/worker/test/worker-process-lifecycle.fixture.mjs` | KEEP scope; TEST WQ-095/PF-03 | Imports compiled app and real shutdown owner, supplies network-free adapters. This is app-context/process-lifecycle evidence, not execution of main.ts. Historical migration-head literals and independently duplicated config should not masquerade as compatibility qualification. |
| `apps/worker/test/worker-process-lifecycle.test.ts` | KEEP core proof; TEST WQ-095/PF-03 | Both signals with active/disabled consumers and bootstrap failure have bounded waits and force cleanup. Missing child error handling/output caps and swallowed force-kill wait failures weaken harness reliability. Entry-point orchestration still requires PF-03's separate real-main tests. |
| `apps/worker/test/worker-process-shutdown.test.ts` | KEEP; existing PF-03 | Verifies coalescing/listener removal and rejected close exit status. Existing plan supplies missing partial-install/sync-close/throwing-logger matrix. Avoid duplicating that task here. |
| `apps/worker/test/worker-readiness-lifecycle.test.ts` | KEEP; TEST WQ-092/WQ-093 | Strong deferred probe/marker-write races, coalescing and failed-revocation assertions. Promise.all([monitor shutdown, siblingClose]) does not prove actual Nest sibling hooks still execute. No never-settling probe or throwing logger case. |
| `apps/worker/test/worker-resource-monitor.test.ts` | KEEP; TEST WQ-092/WQ-095 | Mixed samples prove consecutive counting/reset and single signal. Add equality boundary, each metric independently, lifecycle timer cleanup and diagnostic failure. Do not infer deployed memory behavior from an injected 800-byte threshold. |
| `apps/worker/tsconfig.json` | KEEP | Explicit NodeNext/composite/references and dist maps support existing workspace build; no native type stripping or new compiler setup. |
| `apps/worker/tsconfig.test.json` | KEEP | No-emit test/config coverage inherits production resolution while widening rootDir appropriately. |
| `apps/worker/vitest.config.ts` | KEEP; TEST WQ-095 | Node tests, source queue alias and four-worker cap are explicit. Integration suffix exclusion keeps destructive suites out of normal tests. Dist-backed process fixture still requires current build. |
| `apps/worker/vitest.coverage.config.ts` | KEEP cohorts; REFACTOR WQ-095 | Explicit critical-runtime inventory and measured thresholds are honest. Duplicates base resolution/exclusion but omits its four-worker cap, although it also runs process lifecycle tests. Share relevant base runner options without merging coverage ownership. |
| `apps/worker/vitest.integration.config.ts` | KEEP | Separate include/exclude patterns, serial execution and finite hook/test deadlines are appropriate. Timeout does not automatically clean child processes or external resources; fixture ownership remains required. |
| `apps/worker/vitest.lifecycle-coverage.config.ts` | KEEP cohorts; REFACTOR WQ-095 | File-specific lifecycle thresholds avoid declaring all worker files covered. Lacks base alias/worker cap; reconcile intentionally so normal/coverage execution tests equivalent code under comparable concurrency. |
| `apps/worker/vitest.resilience.config.ts` | KEEP | One worker and explicitly selected resilience files are appropriate for service disruption. Suite config is not authorization or proof the target services are disposable. |

## WQ-091 — forward workspace transaction options through Nest adapter

Priority P2; FIX. `platform/database/database.module.ts:33–36` assigns the full
WorkspaceDatabase method type but only forwards two arguments:

```ts
public withWorkspace: WorkspaceDatabase['withWorkspace'] = (
  workspaceId, operation,
) => this.database.withWorkspace(workspaceId, operation);
```

The third options argument carries cancellation. Local compiled adapter probe
passed `{ signal }` and observed only two arguments at the underlying adapter.
Current direct users of this Nest token are readiness/application artifact
metrics; the latter currently does not pass a signal. This proves a method
contract defect, not that every worker execution transaction loses cancellation
(those runtimes construct their own database adapters).

Plan: forward the complete typed method argument tuple or explicitly forward
options unchanged. No new repository abstraction is needed. Add wrapper-level
tests for exact identity of workspace/operation/options, preserved fulfillment
and rejection, and already-aborted signal. Then carry the existing cancellation
contract into any artifact-metric observation that is made part of bounded
dispatcher shutdown. Keep worker role/readiness checks unchanged.

Acceptance: every optional transaction setting reaches the underlying adapter,
no additional transaction is created, and abort semantics match the actual
WorkspaceDatabase implementation. Include this narrow fix independently of
larger runtime cleanup work.

## WQ-092 — diagnostics cannot prevent readiness revocation or drain signaling

Priority P2; FIX. `worker-readiness-monitor.ts:116–125,147–153` invokes warn/error
before marker revocation/failClosed. `worker-resource-monitor.ts:86–92` sets
drainStarted and begins drain, then logs before signaling shutdown. A throwing
logger bypasses required work; subsequent resource samples return immediately.

Local injected probes:

- Readiness dependency failed with an existing ready state; throwing warn
  produced zero marker revocations and left ready=true.
- One unhealthy sample with throwing warn set admission=false but produced
  zero signals; a second sample still produced zero signals.

`app.ts:80–84` also catches process-start metric failure only to call an
unguarded warning logger. Main and signal-owner diagnostics are already PF-02/
PF-03; this finding extends the same rule to these distinct operational owners.

Plan: perform required safety actions independently of diagnostic success.
Contain both primary warning and secondary error logging, preserve initiating
failures, and always attempt failClosed/signal exactly according to the existing
policy. Do not recursively log a logging failure through the same failing sink.
Avoid wrapping the entire operation in a catch that reports healthy success.

Acceptance: each logger method throwing, marker failure plus logger failure,
metric failure plus logger failure, and repeated resource samples. Assert exact
revocation/signaling counts, drained admission, original error preservation and
zero unhandled promise/callback failures. Add tests through monitor/resource
interfaces plus actual application bootstrap for the startup-metric case.

## WQ-093 — bound readiness lifetime and revoke before waiting on stalled checks

Priority P2; FIX/TEST. `worker-readiness-monitor.ts:135–146` waits for currentCheck
before removing readiness. Neither its probe nor marker I/O has a deadline.
The health command in `infrastructure/ecs/workloads.json` only checks the ready
file, absence of revocation file and PID liveness; it does not expire old facts.
An indefinitely stalled dependency can therefore retain old readiness, coalesce
all later checks, and block shutdown at BeforeApplicationShutdown.

Local probe completed one successful check, began a deferred second check,
then started shutdown. Before resolving the deferred dependency, ready remained
true and stop remained pending. The probe subsequently resolved the dependency
and awaited normal cleanup; it did not leak work or write marker files.

Plan: make stopping/readiness expiry fail closed immediately, while preserving
the existing no-resurrection guarantee for late ready writes. Introduce a
bounded check owner with cancellation/deadline propagation where the underlying
probe supports it. Do not start overlapping unbounded probes on each interval.
Use a terminal generation/state check for late success, and ensure a delayed
ready write cannot erase the newer revocation marker. A simple race around
currentCheck is insufficient because the losing operation can still write.
Retain late-operation observation and report incomplete cleanup rather than
claiming the dependency stopped. Coordinate the deadline with application drain
budget, not an independent arbitrary constant in each class.

Acceptance: hung probe, hung ready write, hung revocation write, late success,
late failure, failure before first readiness and shutdown during each stage.
Assert health is revoked within the chosen budget, no later resurrection,
bounded shutdown outcome, no overlapping checks, and exact cleanup diagnostics.
Use injectable markers in unit tests; use a disposable private marker directory
for file/process qualification. Retain existing deferred-write ordering tests.

## WQ-094 — reject resource-sampling delays that overflow Node timers

Priority P2; FIX. `worker-config.ts:208–212` validates only minimum sampling
interval. Current parse probe accepts WORKER_RESOURCE_SAMPLE_MILLIS=2147483648.
`worker-resource-monitor.ts:59–61` passes it directly to setInterval. Node uses
a 1 ms delay above 2,147,483,647 rather than waiting that duration.
[Node timer documentation](https://nodejs.org/api/timers.html#setintervalcallback-delay-args)
documents this runtime constraint; do not apply it to unrelated byte limits.

Plan: choose a documented operational maximum no greater than the runtime
timer limit and enforce it during config parsing. Test exact valid/invalid
edges, decimals, nonfinite values and numeric/string input as already supported.
Review connection/idle timeout inputs against their downstream database parser
separately; do not assume identical limits or rewrite all numeric settings.
The keepalive timer deliberately uses the exact supported maximum and stays.

Acceptance: invalid interval fails before any monitor starts, no
TimeoutOverflowWarning, valid defaults unchanged, and resource monitoring
continues to require configured consecutive unhealthy samples.

## WQ-095 — improve platform test truth and focused readability

Priority P2 for test isolation/evidence; P3 for local readability.

- `worker-config.test.ts`: give the insecure-production-KMS case a valid OTLP
  endpoint and assert the KMS-specific cause; currently missing required OTLP
  invalidates the outer schema first. Add deployed artifact HTTPS and partial
  recovery storage, scalar normalization, allowed/duplicate/unsupported jobs,
  valid heartbeat edge and resource bounds. Keep one full defaults assertion;
  assert meaningful overrides separately instead of copying the entire object.
- `worker-config.ts`: keep declarative schema/projection, but optionally group
  database/dispatch/attempt/resource transformation into private named sections
  if that reduces scrolling without hiding cross-field constraints. Document
  and test whether returned resourceSafety is immutable like the other nested
  config groups; outer Object.freeze does not freeze it. No generic config DSL.
- `worker-bootstrap.test.ts`: acquire app into try/finally before any assertion;
  reset fixture logger state; expose/inject a private readiness marker seam so
  parallel suites do not share global /tmp readiness state. Add the WQ-091
  forwarding assertion and WQ-057 sibling-error matrix, not just successful
  close call counts. Preserve all five consumer-capability gates.
- `worker-readiness-lifecycle.test.ts`: a separately invoked siblingClose in
  Promise.all cannot prove Nest's actual lifecycle progression. Add a real
  small module/app test with failures in before/after shutdown hooks, asserting
  transport, database, telemetry and keepalive cleanup in dependency-safe order.
- `worker-resource-monitor.test.ts`: test equality versus greater-than limits,
  reset after healthy sample, independent RSS/event-loop triggers, repeated
  lifecycle calls and histogram/timer release. Monitor constructor currently
  creates a histogram even with injected sample; ensure tests close lifecycle
  resources and do not infer actual event-loop performance from fake samples.
- `abortable-delay.test.ts` / background deadline helper: add already-aborted,
  operational elapsed, listener registration race, late task success/rejection
  after timeout and rejection with undefined. Assert settled promises, removed
  timers/listeners and no unhandled rejection. A timed-out task remains owned
  by its caller; do not name this helper test a successful task cancellation.
- `worker-process-lifecycle.test.ts`: install error/exit observers immediately
  after spawn, cap output, preserve force-kill timeout errors and remove owners
  only once exit/reaping is established. Ensure current dist build, private
  readiness files and test-local resources. Keep existing active/disabled and
  SIGINT/SIGTERM matrix; PF-03 adds actual main-entrypoint testing separately.
- Coverage configs: share non-coverage runner settings such as queue resolution
  and maxWorkers=4 with base config. The base comment explains the cap protects
  process-start timing under workspace concurrency; coverage currently omits it.
  Keep report directories, per-file thresholds and disjoint inventories intact.
  Run config inventory checks and validate resolved options for every runner.

Acceptance: no false-positive security config test, no leaked app/timer/process
or shared marker interference, correct build under the established TypeScript
configuration, and explicit coverage claims that distinguish static inventory,
unit behavior, compiled app lifecycle and deployed qualification.

## Extension of WQ-057 — worker bootstrap and application close ownership

`app.ts:30–41` creates worker then dispatcher runtimes before its try. Failure
constructing the latter leaves the former without rollback. Its Nest-creation
catch only closes database runtimes and ignores settled cleanup failures; it
cannot account for every provider successfully constructed before a later
provider rejects. Eager `.close()` calls also permit a synchronous throw before
allSettled is entered. After creation, `await application.close(); throw error`
replaces the initiating bootstrap error if close rejects.

Plan: extend the same explicit acquired-resource/ownership-transfer discipline
used for API WQ-057 to worker composition. Protect first acquisition, register
providers' successfully created owners for rollback, and preserve primary plus
cleanup failures. Verify actual Nest close progression with the worker modules,
not a synthetic sibling Promise.all. Transport lifecycle is reviewed separately
and must participate in the same final ownership decision. Keep distinct worker
and dispatcher roles/pools and telemetry-after-work shutdown order. Do not
blindly close both a shared DatabaseRuntime and every borrowed facade twice.

Tests: second runtime construction failure; module registration/provider init
failure after each owner; compatibility/readiness failure plus sync/rejecting
cleanup; throwing before-shutdown hook; transport failure with database and
telemetry still attempted; exact close identity/count after process rollback.
This is integration of an existing finding, not permission to introduce a new
generic lifecycle framework or change the documented runtime architecture.

## Order

WQ-091/WQ-092/WQ-094 are independent focused fixes with direct regressions.
Coordinate WQ-093 with WQ-057/PF-03 and later transport review. Complete WQ-095
fixture safety before process qualification. No implementation was performed.
