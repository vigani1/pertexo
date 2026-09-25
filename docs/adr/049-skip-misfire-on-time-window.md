# ADR 049: On-time window for skip misfire policy

- **Status:** accepted
- **Date:** 2026-09-25
- **Requested by:** the product owner
- **Amends:** ADR 014 (schedule timezone, DST and misfire), which it also
  clarifies, and ADR 048 (schedule fire history and next runs)

## Context

ADR 014 makes `catch_up_once` the default misfire policy, creating only the
latest missed occurrence, and says V1 "also supports `skip`, which advances
without creating a missed run". `skip` therefore drops only occurrences that
were missed, for example while no scanner was running. A later sentence of the
same record, "`skip` creates no run and also advances strictly beyond it", was
implemented literally: the scanner recorded every occurrence of a `skip`
schedule as `skipped`, including one it observed seconds after it was due, so
a `skip` schedule never ran. The product copy, ADR 048's run history and the
schedule builder's missed-run wording, says such a schedule runs on time and
skips the runs it missed.

The scanner never observes an occurrence at exactly its scheduled instant.
Polling, the per-workspace claim order, batch limits and lease recovery all add
delay, so "on time" needs an explicit tolerance.

## Decision

The scanner still makes one database-time observation per claimed schedule, the
`clock_timestamp()` of the claim, and resolves from it the greatest due
occurrence and the next occurrence strictly after the observation (ADR 014).
The misfire policy decides only what happens to that greatest due occurrence:

- `catch_up_once` admits it as a run. This is unchanged.
- `skip` admits it exactly as `catch_up_once` does when it is on time: the
  observation minus its scheduled instant is at most the on-time window.
  Otherwise the scanner records it `skipped` and creates no run.
- Under either policy the schedule then advances strictly beyond the
  observation. Earlier missed occurrences are never enumerated or recorded.

The scheduled instant is the resolved UTC occurrence identity, including ADR
014's DST adjustments. Lateness is measured from the first valid instant after
a spring-forward gap, and from the earlier instant of a repeated local time, so
a scan that sees the repeated wall-clock time an hour later finds the
occurrence late.

An admitted `skip` occurrence goes through the same code path as a
`catch_up_once` one: the eligibility check under the claim lease, the published
version and the compatibility-release lock, deterministic identity (trigger ID
and scheduled instant), idempotent acceptance with its outbox event, and the
same `accepted` occurrence row that keeps its run. Leases, fencing,
reconciliation, deferral on workspace run capacity and failure retirement are
unchanged. The scanner computes the disposition once, from the claimed row and
its observation, so the persisted occurrence, the scan result and the
`pertexo.schedule.occurrence.count` metric always agree.

The window is the worker setting `TRIGGER_SCHEDULE_ON_TIME_WINDOW_SECONDS`, an
integer from 60 through 3,600 seconds with a default of 300. It may not be
shorter than `TRIGGER_SCHEDULE_POLL_MILLIS`. The scanner receives it with its
other scan settings and checks the same bounds before it claims anything.
Lateness uses only the database-time observation, never a worker clock, and a
lateness equal to the window counts as on time.

Turning a `skip` schedule back on still advances it beyond database time
without admitting anything (ADR 014). An occurrence that fell due while the
schedule was off was not missed by the scheduler, so the window does not bring
it back.

ADR 048's history needs no new outcome. An on-time occurrence of a `skip`
schedule is recorded `accepted` with its run and shows as a run. `skipped` now
means only that the `skip` policy passed over a late occurrence. No migration
is needed, because the claim-completion function already accepts either
disposition under either policy.

## Consequences

A `skip` schedule runs on time and passes over only the occurrences it could
not start within the window, which matches the product copy. The window limits
how late a run may start, not how long the scheduler was down. When a schedule
repeats at least as often as the window, its latest due occurrence is always
within it, so after an outage `skip` admits that one occurrence just as
`catch_up_once` would, and still never replays the rest.

Delay that pushes a claim past the window turns an otherwise on-time occurrence
into a skipped one. That can happen when workspace run capacity defers the
claim, or when a crashed scanner's lease must expire first and the lease plus
the poll interval exceed the window. The defaults (a 30-second lease, a
250-millisecond poll and a 5-minute window) leave room for lease recovery.
Operators who lengthen the lease should keep the window above it.

Occurrences that an earlier scanner recorded `skipped` although they were on
time are not rewritten.

## Rejected alternatives

- Keeping the literal reading, under which `skip` schedules never run.
- Measuring lateness from the persisted `next_fire_at` instead of the
  occurrence being decided.
- Enumerating each missed occurrence to record it skipped, which ADR 014
  rejects as an unbounded backlog.
- A per-schedule or per-workspace window in V1, which would change published
  configuration and its fingerprint.
- Comparing against a worker's wall clock.
- A separate acceptance branch for `skip`.
