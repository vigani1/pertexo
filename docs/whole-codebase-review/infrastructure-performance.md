# Benchmark tooling review

Scope: all eight files under `infrastructure/performance/`, personally read in
full. Criteria J01–J14; PostgreSQL observations are inspected source contracts,
not an executed database benchmark. No service, migration, load run or fixture
population was started. The two Node test files passed **50 tests**, including
six nested output-ownership tests. Synthetic children and fake database clients
are not PostgreSQL performance qualification.

## File-by-file disposition

| File | Judgment | Specific reason / follow-up |
| --- | --- | --- |
| `infrastructure/performance/compare-local-benchmark.mjs` | FIX / KEEP | WQ-230. Raw/summary recomputation, database-scope branching and matching configurations are valuable distinct checks. Keep named validators; do not compress them into one boolean or replace evidence with a p95-only number. |
| `infrastructure/performance/compare-local-benchmark.test.mjs` | TEST / KEEP | WQ-230. Concrete corruption matrices cover absent measurements, mismatch, overlap and aggregation on both sides; add zero-observed-process/null-plan and acquisition-lineage cases. Synthetic fixture timestamps and hashes deliberately are not production attestations. |
| `infrastructure/performance/fixtures/benchmark-operation-fixture.mjs` | KEEP | Bounded 120ms synthetic child, fixed seed guard and two declared markers exercise separation from launcher cost. The second end is intentionally synthetic (`now + 7.5`); never use this fixture to claim real operation performance. |
| `infrastructure/performance/fixtures/overlap-workload-fixture.mjs` | KEEP / TEST | WQ-229–WQ-230. Exclusive readiness file and common release barrier are appropriate for owned test participants. Its polling lifetime is owned by the parent; test parent deadline/failure and reject unsupported duplicate participants before spawning. |
| `infrastructure/performance/local-benchmark-manifest.json` | DATA / KEEP | Eight explicit scenarios, real test entry points, population/count/boundary contracts and three database scopes. Current overlap concurrency is one and valid. Retention/foreground timing correctly does not claim row-lock contention. Preserve fixture/manifest identity when comparing results. |
| `infrastructure/performance/postgres-evidence.mjs` | FIX / TEST | WQ-228–WQ-230. Parameters protect generated fixture values; plans run as maintenance after owner-only setup. Pool timing, plan collection, release order and evidence validation have distinct responsibilities worth retaining. |
| `infrastructure/performance/run-local-benchmark.mjs` | FIX / REFACTOR | WQ-228–WQ-230; shared WQ-220/WQ-223/WQ-225. Existing process supervisor, explicit database ownership and primary/cleanup error aggregation are good. Finish those boundaries rather than adding another generic lifecycle framework. |
| `infrastructure/performance/run-local-benchmark.test.mjs` | TEST / KEEP | WQ-229–WQ-230. Public ownership helpers preserve undefined rejection and simultaneous failures; child tests protect unrelated processes and inherited output pipes. Extend immediate waiter rejection, startup failure, barrier failure and manifest coherence. Put cleanup ownership immediately after allocation and bound `once(runner,'close')`; current signal tests lack a per-wait deadline. |

## WQ-228 — Bind benchmark evidence to the measured source and measurement scope

**P2 FIX / REFACTOR / TEST.** Locations:
`run-local-benchmark.mjs:357` (`sourceIdentity`), `:393`
(`serviceConfigurationSha256`), `:1089` (`beginScenario`/`endScenario`),
`:1153–1176` (SQL collection around warmup/reset/measured rounds), `:1203–1316`
(scenario report assembly), `:1384` (source captured after work), and `:1443`
(benchmark before output creation). Also `postgres-evidence.mjs:322–409`
(`capturePlans`) and both benchmark test files.

Observed sequence:

```js
await databaseSampler.beginScenario?.();
// target tracker also starts here
for (/* warmups */) { await reset?.(); await executeRound(...); }
for (/* measured */) { await reset?.(); rounds.push(await executeRound(...)); }
// SQL totals include both groups, reset/setup/teardown and other activity
// ... later ...
source: await sourceIdentity()
```

The source hash is valid for the end snapshot, not evidence that all measured
children ran that source. `dist` imports also need a build/source relationship;
an unchanged checkout alone cannot prove generated output freshness. SQL
`sum(calls)` is a count of tracked statement executions, not a general proof of
wire round trips: preserve the current coarse observation but label it honestly.
Whole-scenario SQL and operation-only latency have different scopes. Do not
attribute their ratio to one operation. `EXPLAIN ... SELECT function(...)`
can describe an outer function/result node without exposing internal statement
plans; keep this distinction when discussing index or lock improvements.

Implementation sequence:

1. Reuse the source-stability/producer qualification work in WQ-227 and explicit
   Git environment isolation from WQ-223. Capture source before build/work and
   after completion, with build identity where compiled imports are used. A
   changed source/build yields partial/unqualified evidence, not `complete`.
   Exclude only explicitly owned outputs from the input inventory. Preserve
   historical reports; introduce a schema version rather than laundering them.
2. Name SQL scope explicitly (`scenarioIncludingWarmupAndFixtures`) and keep its
   raw totals. If operation SQL is needed, add counters at the already-declared
   operation boundary and retain separate per-round results; resetting once
   after warmup does **not** exclude fixture resets or teardown. Keep resets
   confined to the disposable, runner-owned database OID. No shared-service
   statistics reset is authorized by this review.
3. Record actual PostgreSQL/extension/configuration and service/image identity
   needed for comparison, not just selected environment strings. URL
   normalization currently omits port and query parameters, and environment
   hashes do not establish the running database version or settings. Normalize
   incidental ephemeral addresses explicitly while retaining behavior-affecting
   settings; never persist passwords, credential-bearing URLs or secret query
   parameters.
4. Retain representative fixture row counts and effective role evidence with
   plans. Distinguish outer-function plans from internal-statement plans. Require
   a separately authorized disposable run before claiming a query improvement.
5. As part of this schema change, extract one private `summarizeScenario` from
   the report-building block. It accepts validated rounds plus explicit SQL and
   target evidence, groups samples by operation once, and returns the existing
   nearest-rank/population statistics. The orchestration then reads as acquire,
   warm up, measure, close, summarize. Keep acquisition and cleanup in their
   owner; do not create a new public benchmark abstraction or arbitrary files.
6. Apply WQ-220's exclusive output reservation before expensive work. Preserve
   the good `wx` no-overwrite and incomplete-output cleanup behavior; a
   pre-existing output must fail before starting services/workloads.

Acceptance: mutate source/build identity during an injected run and reject
qualification; identical stable runs still compare; distinguish two service
configurations with different relevant settings; separate synthetic warmup,
fixture and measured SQL counters; preserve existing summary values exactly;
no output clobber or benchmark against an unowned database. Re-run all 50 tests
plus new scope/identity tests before any authorized real benchmark. Dependencies:
WQ-223/WQ-227 first, WQ-229 ownership before long-running qualification.

## WQ-229 — Observe rejection immediately and close every acquired benchmark resource

**P2 FIX / TEST.** `postgres-evidence.mjs:112–128` creates a rejecting waiter
before awaiting a 60ms hold, with no rejection observer until after the hold:

```js
const owner = await pool.connect();
const waiting = pool.connect();
await wait();
owner.release();
const client = await waiting;
```

A direct fake-pool probe with a 20ms hold emitted **one `unhandledRejection`**
before the eventual catch. Existing tests replace the hold with an immediately
resolved promise, so they do not exercise that event-loop gap. An actual
connection rejection can precede the hold; this is not a claim that the normal
healthy contention fixture fails.

The same observation gap exists at `run-local-benchmark.mjs:785–849`: each
`execution.promise = run(...).finally(...)` is left without a rejection handler
while `waitForOverlapBarrier` polls. Attach settled-result handlers at creation,
then let the barrier and aggregate collection inspect the same outcome. Do not
swallow failure or convert it to a successful timing. Preserve undefined
rejection explicitly. Register ownership before an operation that can throw.

`startDatabaseSampler:990–1005` closes only clients whose `connect()` fulfilled.
A fake second-client connect failure produced close attempts **`[true,false]`**.
This proves a missed cleanup attempt, not a measured socket leak in `pg`.
`capturePlans:329–340,400–403` uses the same fulfilled-connect flags. Close every
constructed/attempted resource according to the pinned client's safe lifecycle,
including partial connect, and retain cleanup failures without skipping peers.
The existing `runWithOwnedDatabaseClient` establishes the local error contract.

Additional ownership edges in this same implementation unit:

- `benchmark:1125–1134` enables its event-loop monitor before sampler acquisition,
  outside the cleanup scope. Disable it even when sampler startup rejects.
- `capturePostgresEvidence:428` uses fail-fast `Promise.all` for independently
  owned collectors. Drain both results/cleanup before returning a failure, so
  the caller cannot tear down their database while the sibling is still active.
- `executeRound` allocates the barrier directory and constructs commands before
  its guarded round scope. Cover failures in command-environment construction,
  startup, early exit and barrier release under one owner.
- Ordinary commands and database queries have no overall benchmark deadline.
  A signal kills supervised children but does not cancel an in-flight database
  query or its `stop()` await. Use explicit bounded operations with supported
  query cancellation/connection disposal and wait for the outcome. Keep the
  existing process-tree supervisor; extend WQ-225's checked timeout and bounded
  output policy rather than using a bare race or global process killing.

Test order: delayed hold with immediate waiter rejection (assert no unhandled
event in an isolated child), synchronous acquisition/release failure, partial
first/second connect, monitor acquisition failure, one collector failing while
the other remains pending, workload failure before readiness, stuck query and
deadline cleanup. Assert all acquired resources are attempted exactly once,
primary plus cleanup errors survive, and unrelated processes/databases remain
untouched. Only then run the existing owned-child tests; real-service cancellation
needs a disposable authorized fixture. No runtime source was changed here.

## WQ-230 — Align accepted manifests and evidence with what the runner can prove

**P2 FIX / TEST.** `compare-local-benchmark.mjs:322–370`
(`assertRoundProcessEvidence`), `:660–701` (`assertEvidence`),
`postgres-evidence.mjs:28–72` (`validatePostgresEvidence`), and
`run-local-benchmark.mjs:231–354` (`validateManifest`).

Synthetic probes using the existing comparison fixture showed:

- Every process sample can report zero processes/RSS/CPU, with consistent zero
  summaries, and validation accepts it. That proves no observed workload
  resource usage, not a zero-cost workload. Require at least one actual workload
  observation; zero terminal samples are still legal and CPU can genuinely be
  zero. Retain sampling limitations instead of manufacturing a positive value.
- `instrumentedSqlRoundTrips: 0` and all six `plan.Plan: null` values pass the
  PostgreSQL validator. Require the generator's actual positive sample/query
  count contract and a structured plan node; validate exact unique required
  names, role and relevant nonnegative metrics. Do not demand an index node
  merely because an index exists, or claim a JSON label authenticates execution.
- The checked-in overlap scenario changed to `concurrency: 2` still passes
  `validateManifest`. Each clone writes the same `<participant>.ready` with
  `wx`, so the runner's barrier protocol cannot support that accepted shape.
  Reject it early (simplest current contract) or design distinct execution-level
  participants and corresponding aggregation before enabling it.

Make the manifest validator produce one normalized coherent configuration:
safe integer round/concurrency bounds, strings in argv, positive integer fixture
populations, explicit database scope, required participant identity and shared
operation scope for shared databases even without `requireOverlap`. Validate
configuration consistency before launching processes or creating databases;
do not rely on the final evidence writer to reject an impossible manifest after
the run. Current checked-in manifests remain valid. Scenario/name keys remain
data (use own-property-safe maps when assembling results).

Preserve the current raw-to-summary recomputation and comparison strictness.
Add table cases for each new input invariant, zero-observation versus terminal
zero samples, missing/null/wrong-shaped plan, duplicated required plan names,
wrong scope and concurrency/barrier conflicts. Extend generator-to-validator
tests, not only hand-authored report fixtures. Evidence remains source/test
proof until an authorized runtime measurement is collected. Depends on WQ-228
for versioned measurement scope and WQ-229 for safe failing-run behavior.
