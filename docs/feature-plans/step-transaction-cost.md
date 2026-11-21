# Cost of a pure step

Status: built (option B, batch J9). Finding: performance-07 (batch J7).
Results are under [Measured after B](#measured-after-b).

## Measurement (2026-11-12, main at `8dd36b6c4`)

**Method.** An opt-in harness (kept in the batch J7 evidence, built on
`apps/worker/test/runs/consumer/latency.integration.test.ts`) hosts the compiled
coordinator, node-attempt runtime and outbox dispatcher in one process. It uses
the production defaults: dispatcher batch 25, 1 s idle and 25 ms active polling,
coordinator concurrency 16, attempt concurrency 32, 32 admissions. Postgres 18
and Redis 8.2 run in Docker on an Apple M4 laptop.

Two published workflows run: Manual → N pure steps (cycling Set, Condition and
Text) → Terminate, with N = 1 and N = 10. 200 runs start through the real run
start path, eight at a time. The marginal cost of one pure step is
(10-step − 1-step) ÷ 9 per run.

Sources: transactions from `pg_stat_database` (the observer's own queries and
the idle rate removed), statements from `pg_stat_statements`, Redis from
`INFO commandstats`, CPU from the Postgres container's cgroup and the worker
process. Machine load was 4–13 from other work, so treat wall times as ±30%.
Counts don't depend on load.

**Marginal cost of one pure step** (active limit 200, so admission is not the
bottleneck):

| Per step                              |  Cost |
| ------------------------------------- | ----: |
| Queue hops                            |     2 |
| Database transactions                 |  26.8 |
| Client statements (round trips)       |   112 |
| — tenant context checks and set-up    |    35 |
| — begin, commit                       |    15 |
| Redis commands                        |    94 |
| WAL                                   | 26 KB |
| Postgres CPU                          | 34 ms |
| Worker CPU                            | 34 ms |

The 35 tenant-context statements per step break down as follows:

- 8 `verifyTenantContext` read-backs. Each one reads `pg_settings` and costs
  ~0.86 ms, for 6.9 ms of Postgres time per step (20% of the step's Postgres
  CPU).
- 16 `assertNoTenantContext` checks, before and after every transaction.
- 10.5 `set_config` calls, including the separate statement-timeout one.

All of these sit in `packages/database/src/tenant-access/transactions/run.ts`
and `transactions/scope.ts`.

**Bursts of 200 runs:**

| Active limit | Workflow    | Wall  | Node runs/s | Run p50 |
| -----------: | ----------- | ----: | ----------: | ------: |
|          200 | 1 pure step |  24 s |          25 |    16 s |
|          200 | 10 pure     |  78 s |          31 |    71 s |
|   20 (default) | 1 pure step | 167 s |         3.6 |    92 s |
|   20 (default) | 10 pure     | 137 s |          18 |    74 s |

At limit 200 the single worker is CPU-bound at about 31 steps/s, with both the
worker and Postgres near one core. The slow limit-20 rows are an admission cost
under backlog, not a step cost. They are covered in
[run admission under backlog](run-admission-under-backlog.md).

**One run alone:** 1-step p50 0.65 s and 10-step p50 0.93 s at low load (about
30 ms per step), rising to 1.85 s and 4.5 s at load 12. A 22-step run measured
1.8 s (about 80 ms per step).

The audit's original numbers were 137 round trips, 45 commits and 212 Redis
commands per step. Today's are lower (112, 27 and 94), because the outbox claim
and dispatcher were fixed since then. The shape hasn't changed.

## Problem in plain words

Every step, even "set a value", goes through two queue hops and about 27 small
transactions. About a third of the round trips check that a pooled connection
carries no leftover workspace context and read that context back.
Those checks are transaction-local by construction. One of them scans
`pg_settings` every time. On one server this caps a burst at about 30 steps
per second.

## Options

| Option | What | Cost | Expected effect |
| ------ | ---- | ---- | --------------- |
| A | Leave as is. | none | 31 steps/s per worker; 5,000-item pure loops take minutes. |
| B | **Lean transaction ceremony.** Set workspace, actor and statement timeout in one `set_config` statement, and use its returned values as the verification. Read the timeout with `current_setting`, not `pg_settings`. Drop the before and after `assertNoTenantContext` checks, because every setting is transaction-local (`set_config(..., true)`). A static check forbids session-level `set_config(..., false)` and `SET` without `LOCAL` on pooled clients. | M; no migration, no ADR | About −27 of 112 statements per step (−24%) and −7 ms of 34 ms Postgres CPU (−20%). Every step type benefits, not only pure ones. Estimated +15–25% burst throughput. |
| C | **Run pure steps inline.** Inside one coordinator advance, execute a chain of `safe`, pure, in-process steps (Set, Condition, Switch, transforms) and write their node-run records in the same transaction, with no attempt job and no second hop. | L; changes the execution boundary, so it needs an ADR | A 10-pure-step run would cost about what a 1-step run costs: per run, ~90 transactions instead of ~330 (−73%) and ~360 Redis commands instead of ~1,200 (−70%). The 200-run 10-step burst would drop from 78 s to an estimated 25–30 s, close to the 1-step burst. |

## Recommendation: option B now; not option C yet

B removes most of the overhead every step pays, with a small and testable
change, and keeps the per-step durable records and the two-hop model. C is the
bigger win for long pure chains and loops. But it fails the two-question test
today: adding it later is no harder than now, and no real workload yet hits 30
steps/s on a single-customer server. It also changes which code may execute a
step, recovery and the attempt records people inspect, so it needs its own ADR.
Reconsider C when a real workflow's loop time or a burst backlog becomes a
complaint. Re-run this harness after B to set its baseline.

Because B touches workspace isolation, the owner must agree to it. The
argument for B: the dropped checks guard against session-level settings, which
a static check can forbid at the source. The transaction-local setting and the
returned-value check still stand.

## What it would change (B)

- `packages/database/src/tenant-access/transactions/run.ts` and `scope.ts`:
  one scope-and-timeout statement, verification from its result, and no
  `pg_settings` read. Also the organization path in `transactions.ts`.
- `infrastructure/checks/`: a check that forbids session-level `set_config` or
  `SET` outside migrations. As built, it also refuses connection startup
  settings (`options`, `-c`, `PGOPTIONS`, a connection string's options)
  other than `statement_timeout`.
- As built, after review: each pool refuses to start when a fresh connection
  already carries an `app.*` setting, which covers the sources code can't
  show (deployment `PGOPTIONS`, role and database defaults). One query per
  pool, once.
- No schema, contract or behavior change for users.

## Tests that would prove it

- Existing workspace-isolation and row-security integration tests pass
  unchanged. One new test shows that a client released after a transaction,
  including after a rollback or an aborted operation, carries no workspace,
  actor or discovery setting into the next transaction.
- A wrong or mismatched scope still fails before the operation runs.
- The check fails on a sample session-level `set_config(..., false)`.
- The J7 harness, re-run: statements per step at or below 90, and the
  `pg_settings` statement absent from `pg_stat_statements`.

## Measured after B

The J7 harness ran again on 2026-11-13 at active limit 200, twice with B and
twice with main's transaction code, swapping only the three transaction
files. Everything else was the same commit and stack. Machine load was 3–12.

| Per step                        |   Before |    After |
| ------------------------------- | -------: | -------: |
| Client statements (round trips) | 112, 113 |   86, 86 |
| Database transactions           |  27, 27  |   10, 10 |
| Postgres CPU                    | 55, 64 ms | 32, 24 ms |
| Worker CPU                      | 38, 51 ms | 34, 32 ms |
| Redis commands                  |   92, 91 |   88, 88 |

- Statements per step fell by 26 (−23%), under the 90 target. Transactions
  fell by 16 because the absent-context checks each ran as their own
  autocommit transaction outside BEGIN.
- The `pg_settings` read-back is gone from `pg_stat_statements`. The single
  context statement that replaces it took 163 ms over 17,203 calls in a
  10-step burst; the read-back took 15.9 s over the same number.
- The 10-step burst of 200 runs took 82 s and 122 s before and 80 s and 66 s
  after (25–36 node runs/s after, 20–29 before). At this load the wall
  times overlap too much to quote a gain, but every per-step cost fell.

## Measured after C

J7 ran on a GitHub-hosted Ubuntu 24.04 runner with PostgreSQL 18 and Redis
8.10 in Docker at `92e62820849513edc229e2f5da055f8e1fdf75dc`.
Each mode used the same published pins for Manual → 1 or 10 pure steps →
Terminate. The body cycled Set, Condition and Text. Three paired repetitions
alternated which mode went first. Each burst started 200 runs, eight at a
time, with an active limit of 200. All 2,400 measured runs succeeded.
[J7 job and raw report](https://github.com/vigani1/pertexo/actions/runs/44898908274/job/136830392083)

Counters subtract observer-only transactions and the idle rate. The
statement count uses top-level client statements from non-superuser roles.
Queue hops count durable coordinator and attempt delivery intents. Marginal
cost is (10-step per run − 1-step per run) ÷ 9 for each pair. Each cell lists
the three repetitions in order.

| Cost | 1 pure step, off | 1 pure step, on | 10 pure steps, off | 10 pure steps, on | Marginal step, off | Marginal step, on |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Transactions per run | 35.03, 34.61, 34.55 | 24.16, 24.28, 24.35 | 126.79, 126.01, 125.47 | 25.12, 24.61, 25.64 | 10.20, 10.16, 10.10 | 0.11, 0.04, 0.14 |
| Client statements per run | 327.73, 328.13, 326.66 | 242.70, 244.16, 244.68 | 1,093.11, 1,092.35, 1,091.91 | 262.56, 261.84, 262.47 | 85.04, 84.91, 85.03 | 2.21, 1.96, 1.98 |
| Redis commands per run | 344.94, 356.27, 346.03 | 238.14, 246.24, 253.91 | 1,216.54, 1,205.85, 1,210.55 | 254.76, 245.80, 254.26 | 96.85, 94.40, 96.06 | 1.85, −0.05, 0.04 |
| Queue hops per run | 7, 7, 7 | 5, 5, 5 | 25, 25, 25 | 5, 5, 5 | 2, 2, 2 | 0, 0, 0 |
| Attempt deliveries per run | 3, 3, 3 | 2, 2, 2 | 12, 12, 12 | 2, 2, 2 | 1, 1, 1 | 0, 0, 0 |
| PostgreSQL CPU (ms/run) | 124.72, 110.80, 113.72 | 88.91, 83.44, 87.02 | 406.04, 379.12, 369.05 | 106.32, 104.07, 110.14 | 31.26, 29.81, 28.37 | 1.94, 2.29, 2.57 |
| Worker CPU (ms/run) | 161.38, 148.44, 144.27 | 116.49, 110.21, 107.72 | 510.81, 506.72, 487.37 | 124.30, 121.49, 120.06 | 38.83, 39.81, 38.12 | 0.87, 1.25, 1.37 |

| Burst wall time (200 runs) | Inline off | Inline on |
| --- | ---: | ---: |
| 1 pure step | 31.38, 29.09, 29.01 s | 23.10, 21.98, 21.78 s |
| 10 pure steps | 102.58, 96.65, 94.77 s | 24.66, 24.33, 24.12 s |

The 10-step medians came in under the targets of about 90 transactions,
360 Redis commands and 25–30 seconds. The fresh post-B baseline averaged
about 10.15 marginal transactions per step. The 330-transaction estimate
predates B. The small negative Redis marginal in one inline pair is within
the idle-correction noise.

### Load qualification

The steady and worker-memory scenarios each ran for 60 minutes. The
overload scenario increased traffic through the existing staged ramp.
All six jobs used the 4 GiB, 2 vCPU sizing at the same commit as J7. The
steady workload published its Set steps with v2 pins in both modes.
[Inline-on runs](https://github.com/vigani1/pertexo/actions/runs/44898908274),
[matched inline-off runs](https://github.com/vigani1/pertexo/actions/runs/44898961824),
[historical S5](https://github.com/vigani1/pertexo/actions/runs/44643610658),
[historical S10](https://github.com/vigani1/pertexo/actions/runs/44773678244)

| Scenario and metric | S5 or S10 | Inline off | Inline on |
| --- | ---: | ---: | ---: |
| Steady runs stored | 1,991 | 2,009 | 1,994 |
| Steady run start p95 | 683 ms | 608 ms | 619 ms |
| Steady drain | 13.78 s | 14.99 s | 24.88 s |
| Steady host memory peak | 1,847 MiB | 1,778 MiB | 1,745 MiB |
| Steady host CPU peak | unavailable | 154.8% | 169.4% |
| Overload runs stored | 5,866 | 7,823 | 6,869 |
| Overload slow admission begins | 20 requests/s | 20 requests/s | 10 requests/s |
| Overload first impact on other workspace | 40 requests/s | 40 requests/s | 40 requests/s |
| Overload recovery start p95 | 475 ms | 859 ms | 890 ms |
| Overload drain | 273.63 s | 503.78 s | 557.85 s |
| Overload host memory peak | 1,746 MiB | 1,751 MiB | 1,697 MiB |
| Overload host CPU peak | unavailable | 200.8% | 201.0% |
| Worker-memory runs stored | 10,969 | 11,020 | 10,999 |
| Worker-memory drain | 9.17 s | 11.39 s | 7.91 s |
| Worker-memory host memory peak | 2,607 MiB | 2,654 MiB | 2,673 MiB |
| Worker-memory host CPU peak | unavailable | 200.1% | 199.4% |
| Worker RSS peak | 457.2 MiB | 472.8 MiB | 519.4 MiB |
| Worker container memory growth | 21.1 MiB/h | 23.3 MiB/h | 63.5 MiB/h |

Host CPU percentages use 100% for one core. All six jobs recorded zero
lost, duplicated or stranded runs, zero container restarts and zero host
OOM kills. Both steady and overload jobs passed their assertions. Inline-on
steady drained 9.89 seconds slower than the matched baseline. Inline-on
overload slowed admission at an earlier stage and drained 54.08 seconds
slower. The inline-on worker-memory job exceeded the 30 MiB/h growth limit
and recorded one failed provider call. These load comparisons use one run
per mode on separate hosted runners. **The load gate failed, so inline
execution stays off by default.**

### Follow-up diagnostics

The original overload flood used a v1 Set step. The worker-memory
traffic used only Webhook, HTTP and Code steps. In both scenarios, the
coordinator setting could vary without the hot path executing an inline
kernel. The steady mix did exercise versioned Set steps. The revised
load fixtures pin the flood's Set to v2 and add the same Set after
both fetch-and-Code workflows. Every load job checks the attempt fence
tokens after drain to confirm which execution path actually ran.

The original worker-memory report shows a step change in glibc arena RSS
from 148 MiB at minute 45 to 197 MiB at minute 50. The arena count stayed
at 13 and the V8 heap-used trend was 0.5 MiB/h. With the setting off,
arena RSS stayed near 147–148 MiB from minute 5 onward. The arena
measurements locate the growth in native memory. They do not distinguish
live allocations from freed memory held by the allocator. The one failed
provider call was a retry exhaustion in the intentionally flaky HTTP
scenario. [Original inline-on report](https://github.com/vigani1/pertexo/actions/runs/44898908274)
and [original inline-off report](https://github.com/vigani1/pertexo/actions/runs/44898961824).

PostgreSQL takes `FOR SHARE` on the workspace and entitlement rows for
both admission and coordinator advances. In the coordinator crash test,
the store accepted another run in the same workspace while the child was
paused inside its second inline invocation. The load report now includes
sampled PostgreSQL lock waits and coordinator queue depth to track
contention outside that direct shared-lock interaction.

Approval resumption did hold a different lock during inline execution.
The coordinator acquired the workspace capacity counter exclusively to
reclaim the active slot, then kept it while running the pure chain. Run
inserts need that same counter. The fix commits the resumed slot and an
inline continuation before computing the chain. The integration test
pauses the next advance within the chain and accepts a second run in
the workspace while the first advance is paused.

### Repeating the original load

Three more pairs ran at `92e62820849513edc229e2f5da055f8e1fdf75dc`
with the original fixtures and the 4 GiB, 2 vCPU host limit. Dispatch
order alternated across the pairs. GitHub scheduled jobs on separate
hosted runners. The table gives the median and [minimum–maximum].

| Metric | Inline off | Inline on |
| --- | ---: | ---: |
| Steady run start p95 | 610 [556–628] ms | 739 [674–778] ms |
| Steady drain | 12.18 [10.77–16.28] s | 15.44 [10.39–22.06] s |
| Overload slow admission begins | 10 [10–20] requests/s | 10 [10–20] requests/s |
| Overload drain | 538.71 [407.16–574.29] s | 540.18 [460.74–567.64] s |
| Worker-memory drain | 10.84 [9.91–39.95] s | 53.96 [52.55–69.56] s |
| Worker container memory growth | 37.3 [8.7–94.6] MiB/h | 15.4 [10.5–16.9] MiB/h |
| Worker growth outside V8 heap and external buffers | 28.6 [−0.1–84.5] MiB/h | 7.1 [7–9.2] MiB/h |
| Worker RSS peak | 504.5 [471.9–506.8] MiB | 470.4 [463.9–470.5] MiB |

The overload drain and admission differences from the original pair
landed within this spread. All six overload jobs accounted for every
accepted run exactly once and drained. One on-mode job recorded an API
restart and a host OOM kill, with 1,658 flood requests getting 502
responses during the 80 requests/s stage. Steady run start p95 was
consistently higher with the setting on. The two worker-memory failures
were both off and exceeded the container growth limit. One of them
recorded a near-identical jump in glibc arena RSS, from 136.1 MiB at minute
25 to 185.7 MiB at minute 30. All 18 jobs reported zero lost, duplicated
or stranded runs.

Off reports [1](https://github.com/vigani1/pertexo/actions/runs/44905624590),
[2](https://github.com/vigani1/pertexo/actions/runs/44906416649),
[3](https://github.com/vigani1/pertexo/actions/runs/44906419074).
On reports [1](https://github.com/vigani1/pertexo/actions/runs/44905626906),
[2](https://github.com/vigani1/pertexo/actions/runs/44906379069),
[3](https://github.com/vigani1/pertexo/actions/runs/44906421842).

### Qualification with versioned Set in every scenario

Before the capacity-lock fix, a matched pair at
`505713d5eb25588056324ff29cce355c2c422bd6` used the revised workload.
Both modes slowed admission at 20 requests/s. The on-mode overload
job executed 7,320 Sets inline and drained in 147.38 seconds, versus
483.46 seconds off. PostgreSQL sampled waits for active capacity,
run updates and transaction locks. It sampled zero waits at the shared
workspace fence. The worker-memory jobs grew 50.4 MiB/h off and
2.4 MiB/h on. The on-mode job executed 5,530 Sets inline.
[Corrected fixture, inline off](https://github.com/vigani1/pertexo/actions/runs/44906519056) ·
[Corrected fixture, inline on](https://github.com/vigani1/pertexo/actions/runs/44906493339).

The capacity-lock fix was measured at
`73e7b3030c6864c0b01d17abfdd161e8c2288bbe`. The 10-step J7 burst had no
failed runs across the three pairs. The table gives medians and
[minimum–maximum]. [J7 report](https://github.com/vigani1/pertexo/actions/runs/44907637955).

| Metric | Inline off | Inline on |
| --- | ---: | ---: |
| Transactions per run | 125.70 [124.86–127.19] | 25.01 [24.46–25.36] |
| Client statements per run | 1,090.91 [1,089.98–1,093.89] | 263.08 [261.07–263.26] |
| Redis commands per run | 1,196.92 [1,151.43–1,227.68] | 254.63 [249.18–257.42] |
| Queue hops per run | 25 | 5 |
| PostgreSQL CPU per run | 390.26 [359.99–391.03] ms | 106.33 [100.59–110.88] ms |
| Worker CPU per run | 515.85 [490.94–518.98] ms | 119.86 [117.33–125.75] ms |
| Wall time, 200 runs | 100.41 [96.07–101.00] s | 24.71 [23.31–24.90] s |

The one-step burst took 30.16 [29.57–30.47] seconds off and
22.10 [21.61–22.15] seconds on. Marginal cost estimates use the difference
between the 10-step and one-step results from each repetition, divided by
nine. Slightly negative values reflect the precision of the idle correction.

| Marginal cost per pure step | Inline off | Inline on |
| --- | ---: | ---: |
| Transactions | 10.11 [10.09–10.34] | −0.01 [−0.01–0.15] |
| Client statements | 85.00 [84.98–85.08] | 1.97 [1.94–2.19] |
| Redis commands | 96.27 [92.00–96.31] | 0.15 [−0.29–1.90] |
| Queue hops | 2 | 0 |
| PostgreSQL CPU | 30.23 [27.09–30.80] ms | 2.01 [1.91–2.90] ms |
| Worker CPU | 40.42 [37.35–41.20] ms | 1.26 [0.61–1.87] ms |

### Fixed-build matched load results

Three matched pairs used the same build as J7, the revised pins and the
4 GiB, 2 vCPU host limit. Steady and worker-memory ran for 60 minutes
each. The overload jobs ran the full staged ramp. The table gives
medians and [minimum–maximum].

| Metric | Inline off | Inline on |
| --- | ---: | ---: |
| Steady run start p95 | 655 [630–655] ms | 638 [638–691] ms |
| Steady Code webhook request p95 | 144 [113–147] ms | 139 [130–162] ms |
| Steady HTTP webhook request p95 | 144 [138–145] ms | 138 [137–142] ms |
| Steady burst webhook request p95 | 3,408 [3,106–3,638] ms | 3,381 [2,805–3,605] ms |
| Steady drain | 12.43 [3.67–17.47] s | 8.47 [7.91–22.04] s |
| Overload slow admission begins | 20 [10–20] requests/s | 20 [20–20] requests/s |
| Overload first impact on the other workspace | 40 [40–40] requests/s | 40 [40–40] requests/s |
| Overload drain | 487.36 [466.20–501.31] s | 149.10 [143.66–178.13] s |
| Worker-memory runs stored | 7,517 [7,077–9,901] | 10,868 [10,377–10,970] |
| Worker-memory drain | 56.46 [52.59–68.73] s | 37.98 [8.20–38.66] s |
| Worker container memory growth | 13.2 [10.5–77.1] MiB/h | 128.8 [16.4–137.0] MiB/h |
| Worker growth outside V8 heap and external buffers | 7.3 [1.6–71.6] MiB/h | 117.2 [12.8–129.0] MiB/h |
| Worker glibc arena growth | 0.3 [0–67.2] MiB/h | 120.5 [0.2–129.8] MiB/h |
| Worker RSS peak | 467.9 [462.2–517.5] MiB | 567.8 [467.7–584.9] MiB |

Median host peaks off/on were 1,760/1,734 MiB for steady,
1,794/1,812 MiB for overload, and 2,291/2,715 MiB for worker-memory.
Median CPU peaks off/on were 180.1%/164.3%, 201.2%/201.5% and
200.1%/200.0% respectively, where 100% is one core. All six overload
jobs sampled zero waits at the shared workspace fence. Their busiest
coordinator wait queues held 3–7 deliveries off and 4–8 on. Active
capacity and run-update waits appeared in both modes.

The steady and overload timing targets held. **The load gate failed
and inline stays off by default.** The worker-memory check exceeded
30 MiB/h in two on-mode jobs and one off-mode job. One on-mode overload
job recorded an API restart, a host OOM kill and 712 flood requests with
502 responses at 40 requests/s. There were zero lost or duplicated
runs in all 18 jobs. Two off-mode steady checks flagged one queued
schedule run each after observing an empty queue at the end of drain.
The schedules were still active and the reports did not track those
runs' eventual disposition.

Off reports [1](https://github.com/vigani1/pertexo/actions/runs/44907735724),
[2](https://github.com/vigani1/pertexo/actions/runs/44907738174),
[3](https://github.com/vigani1/pertexo/actions/runs/44907743382).
On reports [1](https://github.com/vigani1/pertexo/actions/runs/44907637955),
[2](https://github.com/vigani1/pertexo/actions/runs/44907740698),
[3](https://github.com/vigani1/pertexo/actions/runs/44907638261).

### Worker allocator diagnosis

A separate on-mode run used the fixed build and the same worker-memory
workload. Worker container memory grew 77.7 MiB/h. After the run queue
drained, the runner called `malloc_trim(0)` in the worker. Worker RSS fell
from 550.0 to 335.8 MiB. Arena RSS fell from 228.4 to 17.1 MiB while V8's
committed heap stayed at 172.3 MiB. The allocator had freed pages that
were still resident in its arenas. The similarly sized arena spikes in
off-mode runs show that this can happen without inline execution.
[Allocator probe](https://github.com/vigani1/pertexo/actions/runs/44912691479) ·
[glibc discussion of interior free pages](https://sourceware.org/pipermail/libc-alpha/2026-April/176852.html).

A separate trial set `MALLOC_ARENA_MAX=2` for the worker. Container
memory grew 8.0 MiB/h, arena RSS grew 0.5 MiB/h, and peak worker RSS was
476.1 MiB. It stored 10,366 runs, including 4,957 successful inline Sets,
with zero lost, duplicated or stranded runs and zero restarts.
[Capped-arena trial](https://github.com/vigani1/pertexo/actions/runs/44917288966).

### Capped worker requalification

The next build used the worker cap in the single-server Compose file at
`2208f39ec3077ff2c4c62c94fdd13d543e062e50`. The Compose config test failed
without the environment setting and passed with it. The paired J7 suite
passed all 2,400 runs on this build. The 10-step burst took 95.70
[94.02–100.34] seconds off and 24.04 [23.18–24.56] seconds on.
Median transactions per run went from 125.55 to 25.27, Redis commands
from 1,212.40 to 248.13, and queue hops from 25 to 5.
[J7 report](https://github.com/vigani1/pertexo/actions/runs/44923855570/job/136905537657).

All six capped overload jobs passed the simulation assertions. Median
drain was 508.73 [501.08–511.58] seconds off and 153.21
[149.84–172.96] seconds on. Slow admission began at a median of
20 requests/s in both modes. One on-mode job reached slow admission at
10 requests/s and returned 261 HTTP 429 responses at that rate. Its
flood request p95 was 11.50 seconds at that stage, against 0.53–0.85
seconds in the capped off controls. No sample captured a wait on
the shared workspace fence. [On-mode overload outlier](https://github.com/vigani1/pertexo/actions/runs/44923855382).

All six steady jobs passed. Median run start p95 was 618 [582–996] ms
off and 618 [582–624] ms on. Median drain was 13.86 [10.61–22.88]
seconds off and 22.11 [20.93–24.31] seconds on.

| Capped worker-memory metric | Inline off | Inline on |
| --- | ---: | ---: |
| Container growth | 35.3 [12.8–72.6] MiB/h | 68.9 [54.3–118.6] MiB/h |
| Growth outside V8 heap and external buffers | 28.7 [2.4–66.3] MiB/h | 61.3 [51.8–113.4] MiB/h |
| glibc main heap growth | 3.9 [1.0–65.7] MiB/h | 55.3 [45.5–133.6] MiB/h |

The cap failed the memory bound in all three on-mode jobs and two
off-mode jobs. In the on-mode failures, growth moved into glibc's main
heap. The cap remains an experiment. **The rollout gate failed and
inline stays off by default.** The API restart and 502 responses from
the uncapped build did not recur in the capped overload jobs.
All 18 capped jobs recorded zero lost, duplicated or stranded runs.
The two failed provider calls were both from the intentionally flaky
HTTP fixture.

Off reports [1](https://github.com/vigani1/pertexo/actions/runs/44923893536),
[2](https://github.com/vigani1/pertexo/actions/runs/44923897378),
[3](https://github.com/vigani1/pertexo/actions/runs/44923902647).
On reports [1](https://github.com/vigani1/pertexo/actions/runs/44923855382),
[2](https://github.com/vigani1/pertexo/actions/runs/44923900262),
[3](https://github.com/vigani1/pertexo/actions/runs/44923855570).
