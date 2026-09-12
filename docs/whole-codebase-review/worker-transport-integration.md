# Worker transport integration and service-control review

Date: 2026-09-12. Primary reviewer fully read these six inventory files.
The service-controller unit file passed both tests. A fully injected controller
probe ran without Docker and demonstrated a start command after its deadline.
The database/Redis/service-loss suites were inspected, not executed: they mutate
shared services, clear queues and can claim unrelated local outbox rows.

## Individual file judgments

| File | Disposition | Specific judgment |
| --- | --- | --- |
| `apps/worker/test/support/compose-service-control.ts` | FIX/TEST WQ-114 | Keeps exact-container identity checks, narrow service allowlist and bounded clean-exit retry. Whole recovery deadline is only checked inside polling; another start can happen after expiry and each subprocess receives the full timeout. |
| `apps/worker/test/compose-service-control.test.ts` | KEEP; TEST WQ-114 | Fake monotonic clock makes clean-exit retry deterministic; unhealthy state fails explicitly. Missing identity replacement, exhausted budget, start rejection, abnormal exit and malformed inspection cases. Long positional mock sequences obscure which transition each response models. |
| `apps/worker/test/support/transport.integration.support.ts` | FIX/REFACTOR WQ-115 | Centralizes proof workspace, checksums, allowlist and exact owned Bull job removal. Import-time pools, checkout-before-try and pre-cleanup discovery mean a failed close phase can leave all original pools open. Shared workspace and cross-workspace dispatch require a private test environment. |
| `apps/worker/test/transport.integration.test.ts` | KEEP; TEST/REFACTOR WQ-115–WQ-116 | Valuable real inbox, tenant isolation, provider idempotency and balanced-metric assertions. First test title overstates SKIP LOCKED proof; provider/consumer acquisition precedes protected cleanup, and provider close is skipped when preceding Promise.all rejects. |
| `apps/worker/test/transport-part-2.integration.test.ts` | KEEP; TEST/REFACTOR WQ-115–WQ-116 | Concurrent receipt/checksum checks and unsafe no-retry observation are useful distinct boundaries. Rollback retry proves receipt recovery but not absence of the rolled-back domain row. Duplicated consumeProof includes unused provider trace support; neutral part number hides purpose. |
| `apps/worker/test/transport.resilience.integration.test.ts` | FIX/TEST WQ-115; KEEP scenario sequence | Real queue loss, Redis stop, PostgreSQL stop and forced drain form a coherent recovery story. Loopback URL validation does not establish Compose ownership; global claims can touch unrelated work. Restore-first teardown can skip every resource close and ignores settled cleanup failures. |

## WQ-114 — make the service recovery deadline an actual admission boundary

P2 FIX/TEST. `support/compose-service-control.ts:94–140,146–195`.
After a clean exited state, wait() can cross the deadline; the outer for loop
still calls assertSameContainer and compose(start) on its second attempt.
Injected probe: deadline=10, poll=20, always clean-exited, fake clock advanced by
wait; result was **two start calls, elapsed=20**, followed by deadline rejection.
No real services were touched. A currently executing ps/inspect/start can also
use operationTimeoutMillis independently of the remaining recovery budget.

Plan: compute remaining time from the existing monotonic clock before admitting
each recovery command and retry. Pass the remaining budget to the concrete
command adapter or establish a clearly named per-command timeout and an explicit
overall bound. Do not call a promise race cancellation if the subprocess remains
active; own/terminate and await the child according to the established test
runner contract. Preserve exact-container matching before restart, the maximum
two clean-exit attempts, immediate unhealthy/abnormal-exit failure and original
start-command error when recovery is not qualified. Do not replace this with an
unconditional docker compose up, which could recreate the target.

Suggested readable shape (conceptual, not a new generic framework):

```ts
for (let attempt = 1; attempt <= MAX_CLEAN_EXIT_START_ATTEMPTS; attempt += 1) {
  assertRecoveryBudgetRemaining();
  await startOriginalContainerWithinRemainingBudget(stopped);
  const outcome = await observeOriginalContainerUntilDeadline(stopped);
  if (outcome === 'healthy') return elapsedMillis();
  // Only a qualified clean exit permits the next iteration.
}
```

Keep the small existing controller if introducing these names would only scatter
the transition rules. Tests: expiry before command, expiry during retry wait,
identity change, zero/multiple IDs, start reject plus clean/unhealthy/abnormal
state, no healthy state by deadline, bounded command timeout and exact command
count. Prefer state-named fake responses over nine unexplained positional strings.
Acceptance: no new command after expiry, no container replacement or unbounded
live subprocess, preserved recovery/error semantics.

## WQ-115 — own and isolate integration resources through failed teardown

P1/P2 FIX/TEST, extending WQ-084/WQ-088 fixture ownership. Exact sites:

- `support/transport.integration.support.ts:23–47,69–104,226–320`: construct
  pools during fixture setup rather than module import; register each acquired
  resource immediately. Wrap pool.connect in the pool's ownership scope. In
  close(), querying outbox IDs currently occurs before the finally that closes
  apiDatabase/workerDatabase; any discovery/connection error skips them. Queue
  construction similarly occurs before its protected try. Make best-effort
  owned-ID cleanup and unconditional handle closure separately observable.
- Both transport tests create providers and multiple queue/database owners
  before the main try. In each provider case, final Promise.all failure skips
  provider.close. Register provider closure after creation, include listen error
  handling, bound pending requests and close siblings despite rejection. The
  deferred helper needs an explicit dispose/reject path: a failure before the
  test awaits its promise can leave a later unhandled timeout rejection.
- `transport.resilience.integration.test.ts:94–124,142–171,219–246,443–749`:
  loopback-only URLs are useful but do not prove that clients target the Docker
  Compose services being stopped/flushed. A different local port/database can
  still pass. Provision or positively verify one disposable Compose project,
  PostgreSQL database and reserved Redis namespace before destructive actions.
  The dispatcher is deliberately cross-workspace: availableAt=1900 prioritizes
  the proof row but does not prevent the remaining batch slots from claiming
  other work. An isolated database is the acceptance boundary, not merely a
  unique workspace or timestamp. Do not weaken production claim semantics to
  accommodate a test.
- Resilience finally first awaits restoreServices; rejection prevents all
  closes. Later allSettled results are discarded, and flush failure skips SQL
  cleanup. Attempt independent cleanup stages, retain their errors alongside
  the original test failure, and report incomplete restoration as failure.
  Metrics emitted in finally are partial measurements, not successful
  qualification; include explicit completed/failure status when consumed as
  evidence. Never print connection credentials or raw subprocess environments.
- `waitForJob:377–389` races an infinite polling task against withDeadline but
  never stops the polling task when the wrapper times out. Give the loop a
  shared stop/deadline and retain ownership through its settlement. A bounded
  outer wait alone is not sufficient when getJob remains pending.

The integration configuration explicitly sets fileParallelism=false; therefore
do **not** claim the two transport files race under the supported single-suite
command. That does not isolate separate invocations or unrelated local clients.
Likewise, inspect-before-drop and exact proof job removal are worth retaining;
do not substitute force-drop/flush-everything to make teardown pass.

Acceptance: fault injection at every acquisition and teardown stage, including
checkout rejection, listen error, failed restore and failed queue close; all
acquired handles attempted exactly once, outstanding work observed, primary
failure preserved, cleanup failures visible, no unrelated data touched. Unit
tests for fixture ownership must use injected boundaries, not stop developer
services. Real service-loss qualification runs only in the proven disposable
environment with authorization.

## WQ-116 — make proof names and assertions match what was exercised

P2 TEST/REFACTOR. Preserve these integration tests; do not replace durable
behavior evidence with mocks or coverage counters.

1. `transport.integration.test.ts:232–261`: concurrent dispatch plus four
   existing Bull jobs proves delivery under concurrency, not that a lock was
   held while the other claimant used SKIP LOCKED. Bull's deterministic job ID
   can deduplicate repeated publish attempts. Rename the test to the property
   actually asserted, or add an explicit held-row barrier and disjoint claimed
   identities at the database contract. Assert each target row's attempt/mark
   evidence if the name promises once-per-outbox publication. Retain production
   at-least-once semantics; never promise exactly-once transport globally.
2. `transport-part-2.integration.test.ts:158–209`: retain the generated ID of
   the row inserted before the injected rollback and assert it is absent after
   failure, alongside the successful retry. Current regenerated anonymous ID
   plus receipt retry does not prove that domain insertion rolled back.
3. Both files duplicate consumeProof and dispatchFairRounds. Move the genuinely
   identical proof operation into the existing support module, preserving
   consumer names, transaction boundary, checksum and logical idempotency key.
   Leave scenario expectations local. Remove unsupported/unused optional input
   branches only after searching callers; no giant parameterized test engine.
   Rename part-2 by its receipt-atomicity/unsafe-delivery responsibility.
4. Keep real lease/retry-window waits where PostgreSQL/Bull clocks are the
   subject. Improve stage diagnostics and deadline bounds rather than replacing
   them with fake timers that cannot advance the external clocks. Await exact
   target state before negative no-retry observation; preserve the explicit
   provider request/effect counts and terminal job evidence.

Order: isolate the harness before running destructive evidence; repair fixture
ownership and service deadlines; strengthen assertion/name fidelity; consolidate
only identical setup. Review only: source/tests unchanged, no services, commit,
push or deployment.
