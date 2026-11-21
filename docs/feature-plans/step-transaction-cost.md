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
