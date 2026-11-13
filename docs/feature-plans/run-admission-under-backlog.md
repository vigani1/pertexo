# Run admission under a backlog

Status: **built** (option B plus an ordered-start wake; batch J8). Finding:
architecture-07 (batch J7). Related: ADR 012, ADR 058, ADR 070 (slot lending
stays), [F29](29-workflow-concurrency-controls.md).

## Measurement (2026-11-12, main at `8dd36b6c4`)

**Method.** The same opt-in harness as [pure-step cost](step-transaction-cost.md)
(batch J7 evidence) runs one worker with production dispatcher and queue
defaults. Every workflow is Manual → 3 pure steps → Terminate. Workspace active
limit is 20 (the default). Four quiet workflows each start one run every 2 s
for 20 s (40 runs). The noisy workflow starts 200 runs, eight at a time, 0.5 s
before the quiet load. Queue wait is the time from run creation to start.
Function times come from `pg_stat_user_functions` (`track_functions=all`) and
include lock waits. Machine load was 4–13 from other work.

| Scenario                                                | Quiet wait p50 / p99 | Noisy drain | Postgres CPU |
| ------------------------------------------------------- | -------------------: | ----------: | -----------: |
| Quiet workflows alone                                   |      0.12 s / 0.17 s |           — |        5.6 s |
| Noisy workflow, same workspace                          |        18.3 s / 33 s |        41 s |         66 s |
| Same, noisy workflow limited to 5 (F29 queue mode)      |      0.14 s / 0.23 s |   **821 s** |    **192 s** |
| Noisy workflow in a second workspace                    |      0.86 s / 1.3 s  |        60 s |         88 s |

Admission cost behind those numbers:

- **Per-workflow limit:** 704,000 calls each to
  `workflow_run_active_admission_eligible`, `workflow_concurrency_admissible`
  and `workflow_run_slot_counts`, for 240 runs. 5,923 of 8,422 claims (70%)
  found nothing to publish. The 200 limited runs should drain in about 30 s
  (200 runs × ~0.65 s ÷ 5); they took 13.7 minutes.
- **Workspace backlog (no workflow limit):** 28,800 eligibility checks and
  31,000 slot counts for 240 runs. Claims took p50 63 ms (5 ms when idle).
- **Run starts wait on the workspace admission lock:**
  `lock_workspace_admission` spent 17–87 s in total across about 240 starts.
  In the pure-step burst at limit 20, a start took p50 1.3 s and p99 10.5 s
  (0.25 s at limit 200). With all 200 starts in flight at once, the 8-connection
  start pool timed out.
- **Same workspace, 200 one-step runs at limit 20:** 167 s, against 24 s at
  limit 200 (see the pure-step plan).

Lending was not exercised. The owner keeps it, and nothing here argues
against it.

## Problem in plain words

The machinery's goals are right, and two of its parts earn their place in a
one-customer instance:

- Round-robin between workspaces kept a quiet team's runs starting in under
  a second while another workspace had 200 queued.
- The per-workflow limit fully protected quiet workflows.

What doesn't hold up is the cost. Admission is decided by polling: every
claim re-checks every queued run, and each check counts runs with `count(*)`.
Work grows with the square of the backlog. A workflow limited to 5 drains 25
times slower than it should, and starts wait behind the claim that holds the
workspace lock. Inside one workspace, admission is first come, first served
across workflows. That matches n8n's queue mode, and the per-workflow limit
already addresses it.

## Options

| Option | What | Cost |
| ------ | ---- | ---- |
| A | Remove workspace fairness and slot accounting, keeping only a per-instance cap. | L, and wrong: the measurement shows fairness between workspaces helps, and the per-workflow limit and lending need the slot accounting. |
| B | **Check only the head of each queue.** In the claim, consider for each workflow with a limit only its lowest-ticket queued run, and only as many workspace-queued runs as there are free slots. Read occupancy from the maintained `workspace_execution_admission_counters` (plus one indexed per-workflow count) instead of `workflow_run_slot_counts` for every candidate. Starts and claims then hold the workspace lock briefly. | M–L: SQL functions in a forward migration and the claim query. No new state or role, no change to lending. |
| C | **Admit on release.** When a slot frees (a run ends, a Wait starts, a loan returns), the same transaction admits the next ticket and marks its event ready. The claim never evaluates eligibility. | L: rewrites the admission protocol (ADR 058/070 amendment), every slot-freeing path, and recovery. |
| D | Add fairness between workflows inside a workspace. | M, and not needed: F29's limit already protects quiet workflows, and n8n, Zapier and Make don't do it either. |

## Recommendation: option B

B keeps every behavior the owner wants (workspace fairness, per-workflow limits
and order, lending, row security) and removes the quadratic cost, which is the
only measured problem. It changes how admission is checked, not who may be
admitted, so the existing admission and lending tests keep proving correctness.
C is cleaner in principle, but it rewrites the hardest code in the system to
win little beyond B. Revisit it only if B's numbers fall short. A and D: no.
Close the "multi-tenant machinery doesn't fit" half of the finding with this
evidence, and keep the cost half open until B lands.

## What was built (batch J8)

B alone removed the quadratic cost but not the slow drain. The drain's real
bound was a second cause: granted runs of a limited workflow start in ticket
order, and a later run whose start landed first was deferred **5 s while holding
its slot**. A second fix removes that idle time.

- **Queue-head admission** (migration `0002_queue_head_admission.sql`,
  `claim.ts`):
  - `held_workflow_run_admission_events` is one set-based query per workspace
    in the claim's round. It lists the queued-run deliveries that can't be
    admitted in this claim: those behind their limited queue's head, and those
    beyond the free slots read from `workspace_execution_admission_counters`.
    The claim skips them and checks only the rest, each still exactly, under
    the counter lock.
  - The slot rules moved unchanged into `workflow_run_active_slots` and
    `workflow_run_reserved_slots`, which never count the queue.
  - No index was needed.
- **Ordered-start wake** (migration `0003_ordered_start_wakeup.sql`,
  `runs/wakeups/ordered-start.repository.ts`):
  - When a run starts, the coordinator's start transaction calls
    `wake_next_ordered_workflow_run_start`. It brings forward only the next
    granted run's deferred delivery, with `SKIP LOCKED`, so the wake takes no
    lock it would wait for.
  - `workflow_run_active_capacity_available` now decides an order rejection
    under the counter lock the start path already holds. The deferral then
    serializes with the start of the run ahead, and that start's wake always
    sees it.
  - The 5 s deferral stays as the fallback when the run ahead is stuck.
- **Unchanged:** who may be admitted, ticket order, workspace fairness, lending,
  and the app's fence on outbox updates.

### Measured (J7 harness, 200 noisy runs, limit 5, load 5–8)

| | Main | B | B + wake |
| --- | ---: | ---: | ---: |
| 200-run drain (wall) | 877 s | 123 s | 37 / 65 / 42 s (three runs) |
| eligibility checks | 880,401 | 5,215 | 3,408 – 3,653 |
| 5 s order deferrals | 774 | 90 | 0 / 0 / 1 |
| empty claims | 70% | 43% | 17 – 22% |
| claim p50 | 21 ms | 6.5 ms | 7 – 11 ms |
| Postgres CPU | 227 s | 46 s | 37 – 65 s |
| quiet runs' wait p50 / p99 | 0.11 / 0.58 s | 0.14 / 1.06 s | 0.15–0.32 / 0.37–0.90 s |
| start p50 / p99 | 83 / 528 ms | 307 / 779 ms | 129–245 ms / 0.40–1.09 s |

The wall time includes the 20 s quiet load that runs alongside. The machine
was shared, so the same code varied from 37 to 65 s between runs.

With a noisy workflow in a second workspace, quiet runs waited 1.36 / 4.0 s on
main and 0.43–0.69 / 0.59–1.05 s after.

Remaining cost: inside one workspace, every run status change still takes the
workspace counter row lock and holds it until commit. That lock is what bounds
an unlimited same-workspace burst (30–54 s for 240 runs) and the start
latency there. It is not admission cost, and this plan doesn't change it.

## What it planned to change

- `packages/core/src/outbox/dispatcher/claim.ts`: candidate selection takes
  only queue heads (one per limited workflow, in ticket order) and at most the
  workspace's free slot count of unlimited-workflow runs.
- A forward migration replaces `workflow_run_active_admission_eligible`,
  `workflow_concurrency_admissible` and `workflow_run_slot_counts` lookups on
  the claim path with counter reads and indexed per-workflow counts. Add a
  partial index on queued runs by workspace, workflow and admission ticket if
  `EXPLAIN` shows a need. `refresh_workflow_run_admission_counters` stays the
  repair path.
- No contract, product or lending change.

## Tests that would prove it

- The existing admission, F29 order and skip, lending and recovery integration
  suites pass unchanged.
- New, on the real database: with a backlog of 200 queued runs, one claim calls
  the eligibility path at most (limited workflows + free slots) times. Assert
  this through `pg_stat_user_functions` or an `EXPLAIN` row estimate, not wall
  time.
- Order: under a workflow limit of 5, runs start in ticket order and never more
  than 5 at once.
- Re-run the J7 fairness harness. Target: the limited 200-run drain in under
  60 s, quiet waits unchanged, and start p99 under 1 s with a 200-run backlog.
