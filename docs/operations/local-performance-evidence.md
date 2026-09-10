# Local performance evidence

The Q11 benchmark runner measures repeatable existing consumer and integration
workloads. It does not create a new service-level objective and does not turn a
passing laptop run into production capacity, availability, RPO or RTO evidence.
ADR 015 remains authoritative for those objectives.

## Candidate and environment identity

Each evidence file records the base commit plus a SHA-256 digest over the path
and bytes of every tracked and untracked, non-ignored source file. A dirty-file
count makes it explicit that the base commit alone is not the candidate. The
record also includes OS release, architecture, CPU model/count, total memory,
Node and pnpm versions, the declared harness seed, warmup rounds, measured
rounds, named operation contracts, fixture populations and concurrency. Each
fixture emits a versioned JSON marker with its operation name, population,
human-readable boundary and absolute monotonic start/end timestamps.
Shared-database markers additionally record the observed database, actual role
and application name. The runner rejects missing, extra, malformed,
boundary-mismatched or population-mismatched markers. The seed is supplied to
every child command as `PERTEXO_BENCHMARK_SEED`; disposable fixture identities
therefore do not imply byte-identical row values. A secret-free service digest
normalizes ephemeral loopback ports while retaining semantic configuration.

The runner requires `PERTEXO_Q11_ISOLATED=1`. Set that flag only inside the
Q02-owned local-quality service lifecycle, so a performance run cannot silently
reuse a developer's PostgreSQL, Redis or object-store state. Evidence output is
opened exclusively and cannot overwrite a prior run.

The complete local qualification runs the checked-in manifest after it starts
and migrates its owned services, writing the evidence beside that run's
manifest:

```sh
pnpm quality:local
```

The lower-level command is available inside an already-owned Q02 service
lifecycle:

```sh
node infrastructure/performance/run-local-benchmark.mjs \
  infrastructure/performance/local-benchmark-manifest.json \
  evidence/local-performance.json
```

Use `--validate` as the third argument to check a manifest without starting any
workload or requiring services.

Compare two retained complete artifacts without executing workloads:

```sh
pnpm performance:local:compare evidence/baseline.json evidence/candidate.json
```

The comparator rejects stale/partial artifacts and incompatible evidence schema,
manifest, operation boundaries, populations, host/runtime or service
configuration. A source fingerprint change is reported, not rejected. It
compares latency variability, operation-specific and scenario throughput,
process RSS/CPU trends, and available SQL/pool/database evidence; launcher time
remains diagnostic only.

## Workload coverage

The manifest uses public package test commands and existing composed seams:

| Scenario | Measured boundary and population |
| --- | --- |
| Authoring/publication | One workflow create, initial publish and executable-change publish, each bounded by its public database call |
| Webhook admission | One 23-byte authenticated request through durable workflow-run acceptance and the 202 response |
| Schedule-to-start | After setup verifies one due schedule, release the gated real scanner, then scan/accept, dispatch its outbox and observe durable `run.started`; the interval includes the declared 25 ms polling delay |
| Event visibility | One live event from append/publish through iterator visibility after three PostgreSQL-backfilled events |
| Bounded loop | Load and commit of a checkpoint carrying a 128-item collection and its first active ordinal |
| Artifact streaming | Two concurrent begin requests plus a 1 MiB signed upload, dual-region finalize, metadata read and complete 1 MiB download |
| Foreground alone | A 32-acceptance batch on the runner-owned disposable-database setup used by the contention variant |
| Retention versus foreground | Six retention callers over 26 workspaces and a 32-acceptance batch, released by a barrier on one runner-owned database |

Every scenario has one warmup and five measured rounds. Operation latency is
`endedAtUnixMs - startedAtUnixMs`. Throughput is the number of declared domain
operations divided by the measured interval from the earliest operation start
to the latest operation end; it does not sum durations or assume concurrency.
The original seven scenarios retain their operations and populations; the
foreground-only control is an eighth comparison variant. The contention
scenario fails unless both intervals intersect and both markers report the same
runner-owned database. The processes use `pertexo_maintenance` and
`pertexo_api`, with distinct application names. Transport-owned rows are
deferred from retention selection and its reset truncates only transport probe
tables, so neither participant changes or destroys the other's declared fixture.
The evidence retains intervals, identities, overlap duration, every raw marker,
launcher elapsed time, and
nearest-rank p50/p95/p99, mean, standard deviation and coefficient of variation.
Launcher cost is never reported as domain latency.

The isolated PostgreSQL service preloads `pg_stat_statements`. At each scenario
boundary the harness resolves the measured database OID, resets only that OID's
statistics, and filters the aggregate SQL calls and server execution time by the
same `dbid`, without retaining statement text. This prevents the base and
runner-owned shared databases from contaminating one another. Counts include
the warmup and five measured commands and describe the scenario process tree,
not one domain operation.

The runner samples every owned workload process group at 100 ms, including
descendants after their launcher exits. Each round retains timestamped RSS,
process-count and `ps`-reported CPU-percent samples, peak values, and first/last
RSS delta so a trend can be inspected rather than inferred from one peak.
Per-process Node heap and event-loop lag remain unavailable across the pnpm and
Vitest process trees without intrusive runtime hooks. That limitation is stored
in the evidence. Separately named orchestrator diagnostics are retained only to
diagnose the harness and are explicitly not substituted for workload metrics.

During an isolated service run, a privileged read-only sampler records
PostgreSQL database size, connection count, active task count and lock waits
every 250 ms without retaining a connection string. Repository-owned pools also
emit a bounded checkout-duration histogram. The evidence fixture uses that
production seam against the real maintenance role and records three deliberately
contended acquisitions; SQL round trips observed by that instrumented client
are retained as a count. Every runner-owned scenario gets a sampler connected
to the actual target database; it stops before database teardown and retains
target-specific activity and `pg_stat_statements` totals. Runner-owned fixture
databases retain the extension and sampler while the runner resets only their
disposable application schemas before each warmup or measured command. This
preserves each fixture's pristine-database contract without losing target-wide
workload evidence.

## Historical schema-v2 baseline

Complete qualification run
`2026-09-09t20-27-02-938z-25703-bc910c0c` measured the schema-v2 harness from
`HEAD` `9a09ccec09fa97215f54ed46a687cb00805dd4f6`. Its runner start/end fingerprint
was `8e8ecaeadd290b4134be004e5d269f3428b81aa643b8b8082496f30dae6c7039`;
the benchmark independently hashed 1,507 tracked/untracked files as
`3507b4e0c7f2a2bb1edc44e64a659866843174bc19db945e13dc0b07c9fb3222`, and
the manifest SHA-256 was
`a1a91c56381dc13046de2828fb68ed16ed3678968618424ac26d640dc0a2cb7f`.
The environment was Apple M4/10 logical CPUs/24 GiB, macOS 25.6.0 arm64,
Node 24.15.0 and pnpm 11.22.0.

| Named operation | Population | p95 ms | Investigation band ms |
| --- | ---: | ---: | ---: |
| Workflow create | 1 | 11.38 | 15 |
| Initial publish | 1 | 14.10 | 20 |
| Executable-change publish | 1 | 20.46 | 55 |
| Webhook admission | 1 | 42.88 | 60 |
| Due schedule to durable `run.started` | 1 | 174.51 | 325 |
| Live event visibility | 1 | 8.99 | 20 |
| Loop state load | 128 items | 14.91 | 20 |
| Loop plan commit | 128 items | 18.58 | 25 |
| Artifact begin | 2 requests | 34.22 | 50 |
| Artifact upload | 1 MiB | 19.87 | 30 |
| Artifact finalize | 1 | 52.96 | 65 |
| Artifact metadata | 1 | 5.11 | 10 |
| Artifact download | 1 MiB | 912.85 | 1,100 |
| Retention scheduling | 26 workspaces | 21.18 | 30 |
| Foreground acceptance | 32 acceptances | 83.19 | 95 |

The lowest round throughput in manifest order was 46.14, 23.32, 5.73, 111.25,
48.58, 4.44 and 24.04 named operations per second. Retention/foreground overlap
was proven in all five measured rounds, with 17.90–21.17 ms interval
intersection. Workload process-tree peak RSS maxima were 646, 862, 835, 707,
670, 1,265 and 1,148 MB; the raw RSS/CPU/process-count series and deltas remain
in the artifact. PostgreSQL peaked at 15,333,055 bytes, 14 connections, one
active task and zero sampled lock waits. Three contended checkout observations
were 60.5–61.7 ms and all six maintenance-role plans remained available.

The investigation bands are not gates or SLOs. For each named operation the raw
band is `maximum × (1 + max(0.10, 5 × CV))`. It is rounded upward to a 5 ms
quantum below 100 ms, 25 ms below 1,000 ms, and 100 ms thereafter. A later
comparison is meaningful only on the same host, manifest and fixture
populations; another baseline is required before turning any band into an
automated regression budget.

## Corrected schema-v4 baseline and independent repeat

Runs `2026-09-10t10-40-37-371z-44959-9ab88dfa` and
`2026-09-10t10-43-03-584z-60827-22dc963f` independently created isolated
services and executed one warmup plus five measured rounds. Their artifacts are
retained under their respective `coverage/local-quality/` directories with
SHA-256 values `41ca366e2c8d0d53fd7707f527fa8bb9a95fe815a4f9358d15ca68a6995d90c0`
and `acb16dbed8b4b683b8a45ce399f2400eca2aec19efaa9b5939155b88fc2c394a`.
Both record source fingerprint
`64e86fd94da0af1bc83bb8f2fc719a7f04a8da566486732c9b01679d1c804a57`,
manifest SHA-256
`e1d84678a7e0a6cd458d29a1b8071d37c708cd552366aaba3be177cc260e88a7`
and service-configuration SHA-256
`1068f63063007f7dfd6db370ffb0c122c83dd93bebf7a883afcf196d1c945a16`.
The read-only comparator accepted both the first artifact against itself and
the two independent artifacts with `sourceChanged: false`.

Schema v4 makes database scope part of the evidence contract. Configured-base
scenarios require positive base-database SQL evidence and no target block.
Runner-owned fixture and shared scenarios allow the independently sampled base
to remain zero only when their target block is available and records positive
SQL work. Across the two repeats, configured-base totals were 3,192 calls for
authoring/publication, 474 for event visibility and 5,352 for artifact streaming.
Runner-owned fixture target totals were 17,700 / 17,700 for webhook admission,
20,710 / 20,704 for schedule-to-start and 12,732 / 12,732 for bounded-loop.
The shared foreground control recorded 1,836 calls in both runs and contention
recorded 2,544 in both; every one of those five runner-owned scenarios recorded
zero base-database calls and available target activity samples.

Foreground-alone p95 was 64.42 ms then 66.95 ms (CV 0.030 and 0.057).
Foreground-under-retention p95 was 99.55 ms then 130.88 ms (CV 0.108 and
0.229), or 1.55× and 1.95× the corresponding control; mean ratios were 1.34×
and 1.46×. Every contention round still used one database with observed
`pertexo_maintenance`/`pertexo_api` roles and distinct application names.
All ten measured intersections were reconstructed exactly from the retained
participant samples and ranged from 10.54 ms to 27.35 ms.
Temporal overlap is not promoted into a row-lock claim; the deterministic
legal-hold/fence lock test remains the correctness owner.

The earlier 09:53/09:56 schema-v4 repeats are superseded because they predate
the final raw-summary, overlap and lifecycle-integrity corrections. The
schema-v3 artifacts remain historical latency and overlap records, but are
also superseded for comparison because they mislabeled cluster-wide SQL totals
and did not require target evidence for fixture-owned databases. The new
repeats again show that five-round p95 is noisy, so no automated budget or
code/schema/index optimization is justified from these local samples.

## Query plans and optimization disposition

The Q02-owned PostgreSQL volume is the plan fixture and is destroyed after the
cohort. It creates 44 workspaces and 400 finalized artifacts, analyzes the
owning tables, and executes six named `EXPLAIN (ANALYZE, BUFFERS, WAL, SETTINGS,
FORMAT JSON)` calls through `pertexo_maintenance`: retention keyset discovery,
committed artifact-version listing, purge discovery, purge step claim, object
checkpoint, and `execute_workspace_tenant_rows_page`. Mutating functions touch
only fixture-owned rows. The JSON retains cardinalities, role,
planning/execution time, buffers and WAL observations. PostgreSQL exposes these
security-definer calls as Function Scan or Result roots, so the artifact does
not claim that an internal node tree was available; buffer and elapsed evidence
still covers the actual function body under its production role boundary.

The historical comparison bands in the quality plan are regression-investigation budgets,
not production SLOs. The current implementation is retained unchanged because
the stable baseline and plans did not demonstrate a candidate regression. A
later candidate may be optimized only for a measured bottleneck and must be
compared against the same manifest, environment and fixture population.
