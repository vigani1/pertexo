# F29 — Per-workflow concurrency controls

Status: first queue-only slice qualified and merged; skip overflow deferred.
Created: 2026-09-29. Parent: [product roadmap](../product-roadmap.md).
Scope: Extends run admission. Relative size: **M–L**, not a calendar estimate.

## Outcome

A workflow can say how many of its runs may be active at once, and what
happens to the rest: wait their turn or be skipped. Schedules no longer overlap
themselves and webhook bursts no longer race on the same records.

## Current implementation and evidence

Runs are admitted against workspace-wide queued and active limits with fair
backpressure ([ADR 012](../adr/012-fair-admission-backpressure-entitlements.md)).
A schedule's misfire policy decides whether late occurrences run
([ADR 049](../adr/049-skip-misfire-on-time-window.md)). The local ADR058 slice
adds a current, optional per-workflow cap across published versions, queue-only
overflow, durable acceptance tickets, settings commands/UI, and timestamped
queued-run blockers. This first slice is qualified and merged in PR138; skip
overflow and independent queue settings remain deferred.

Inspected anchors (paths may move):

- [docs/adr/012-fair-admission-backpressure-entitlements.md](../adr/012-fair-admission-backpressure-entitlements.md)
- [docs/adr/049-skip-misfire-on-time-window.md](../adr/049-skip-misfire-on-time-window.md)

## Dependencies and planning gate

F12 so limits and queue depth are visible. Independent of subworkflows; F08
must decide whether child runs count against their own workflow's limit.

Resolve in an ADR before code:

- **Limit** per published workflow (recommended: unset by default, or 1 for
  in-order processing), versioned with publication or a workflow setting.
- **Overflow**: queue in arrival order up to a bound, or skip with a recorded
  reason; schedules default to skip-if-running, webhooks to queue.
- **Admission point**: enforced in the same admission transaction as the
  workspace limits, without a hot row per workflow on every run.
- **Interactions**: replay and manual runs, cancellation freeing a slot,
  deadlines while queued, and F26 pausing a queued backlog.

### Reviewed first-slice resolution

[ADR058](../adr/058-workflow-concurrency-queue-admission.md) governs the first
slice. It selects a current operational workflow cap, unset by default,
queue-only overflow bounded by the existing workspace queue limit, and durable
acceptance-order tickets with ordered start transitions. Already committed
reservations are grandfathered when a cap is enabled or lowered. Workspace
limits remain authoritative; no second scheduler is introduced.

The interaction question above is resolved by preserving ADR056: trigger pause
does **not** pause already accepted backlog. Cancellation/deadline terminal
processing remains deliverable even at full capacity. Skip overflow, per-trigger
defaults and separate queue-length settings in the broader recommendations below
are deferred, not part of this first slice. No enabled placeholder controls ship.

The manager owns this plan and ADR review; the implementation chat owns code and
verification. Implementation starts only after the decision is recorded, with a
lock-order and mixed-version rollout check before enforcement changes.

## User-configurable settings

Recommended values, confirmed in this feature's ADR. The server enforces every
range; the control states its consequence.

| Setting | Default | Range | Who changes it | Consequence shown |
| --- | --- | --- | --- | --- |
| Runs at once | Unlimited within workspace limits | 1 to the workspace active-run limit | Workflow editors | “At most N runs of this workflow run at the same time” |
| When the limit is reached | Schedules skip; webhooks and manual runs queue | Queue or skip, per trigger | Workflow editors | “Extra runs wait their turn” or “are skipped and recorded” |
| Queue length | 100 | 1–1,000, capped by the workspace | Workflow editors | “Runs beyond this are refused with a clear reason” |

## Ownership and structure

Database admission and queue order; worker coordinator start; contracts;
web workflow settings and run history.

Follow the [shared implementation rules](../product-roadmap.md#shared-implementation-rules).

## Frontend work

A concurrency setting with its overflow choice; queued-by-limit and
skipped-by-limit states in run history with the reason.

## Backend work

Per-workflow admission and ordered promotion when a run finishes, bounded
queue depth, skip records for schedules, metrics for queued time.

## Delivery slices

1. ADR for limit, overflow and admission semantics.
2. Admission, ordered promotion and skip records with real-database race tests.
3. Settings and run-history UI.

Each slice ends in a usable, tested behavior; do not ship enabled placeholder
controls backed by invented responses.

## Acceptance evidence

Concurrent starts never exceed the limit; queued runs start in arrival order
exactly once when a slot frees; skips are recorded; cancellation and deadlines
free slots; workspace limits still apply; no deadlock across workflows.

## Non-goals

Business-event deduplication or debouncing (F25), rate limits toward a
provider's API.

## Rollout and rollback

Unset by default, so existing workflows behave as today; removing a limit
admits queued runs under workspace limits.

No production rollout, paid provisioning or real external calls are authorized
by this plan.

## Competitor context

Make can process a scenario's data in order, finishing each run before the next
starts ([scenario settings](https://help.make.com/scenario-settings)).

Research checked 2026-09-29; product editions and availability can change.
This context informs the outcome, not Pertexo's implementation.

## Delivery tracker

- [x] First-slice baseline reconciled against current code and accepted decisions.
- [x] First-slice product choices resolved; ADR058 accepted. Broader skip and
  independent queue-setting choices remain deferred.
- [x] Contracts and concurrency model reviewed.
- [x] Backend behavior implemented and independently verified where needed.
- [x] Frontend behavior implemented and independently verified where needed.
- [x] Real integrated acceptance evidence recorded.
- [x] Rollout/rollback and limitations documented.
- [x] Scoped PR merged with required checks; natural postmerge result inspected.

Evidence log:

- 2026-10-01: independent specification and standards rereviews closed all
  findings. [PR138](https://github.com/vigani1/pertexo/pull/138) merged exact
  reviewed head `7561e822` as `02750811c0bbb8545042f96f9f6f53784c9ff5d2`.
  Exact-head [CI36810146630](https://github.com/vigani1/pertexo/actions/runs/36810146630)
  and [CodeQL36810146584](https://github.com/vigani1/pertexo/actions/runs/36810146584)
  passed. Natural postmerge [CI36811514908](https://github.com/vigani1/pertexo/actions/runs/36811514908)
  and [CodeQL36811514931](https://github.com/vigani1/pertexo/actions/runs/36811514931)
  succeeded on that exact merge head. The main-push dependency-review skip is
  expected. First-slice qualification is complete; Phase 7 remains open and no
  production deployment or activation is claimed.

- 2026-10-01: local implementation has 22 real PostgreSQL concurrency proofs,
  a final full database suite of 103 files / 741 tests, three real HTTP cases,
  and a real API/worker/browser cap-setting, queued-blocker, runtime-restart, and removal
  proof. Ordered starts do not promise completion or external-effect ordering.
  Receipt reaping is executed; tenant-purge inventory is verified without
  claiming actual purge execution. [The enforcement note](../operations/workflow-concurrency-enforcement.md)
  records lock order, readiness/role boundaries, old-writer rejection, quiesced
  rollout and rollback. Manager implementation review, full release gates,
  scoped merge, and natural postmerge checks remain open. See the
  delivery tracker.
- 2026-10-01: manager reviewed the F29 proposal against ADR012/056, current
  reservation and coordinator capacity paths, and dispatcher ordering. Outbox
  `available_at,id` ordering does not establish acceptance FIFO; reservations
  consume active capacity. ADR058 records queue-only scope, ordered promotion,
  control-path liveness, authorization and rollout proof obligations. No code,
  race-test, browser, CI or release completion is claimed by this planning entry.
