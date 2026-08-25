# ADR 014: Schedule timezone, DST, and misfire semantics

- **Status:** accepted
- **Date:** 2026-08-25

## Context

A persisted UTC cron loses the user's local-time intent, while process timers
and BullMQ repeat state cannot authoritatively recover missed occurrences.
Daylight-saving transitions also make some local times occur twice or not at
all, so parser version and occurrence identity are compatibility decisions.

## Decision

V1 supports a strict five-field local cron expression or a bounded positive
fixed-duration interval serialized as an integer number of minutes from one
through 43,200 inclusive. Cron schedules require a strict IANA timezone name;
aliases, fixed-offset pseudo-zones, seconds fields, year fields, calendars, and
arbitrary recurrence rules are excluded. At implementation, `cron-parser`
version `5.10.0` is pinned as a direct dependency rather than inherited
transitively.

PostgreSQL `next_fire_at` and `last_fire_at`, trigger identity, and database
clock are authoritative. Each logical occurrence is uniquely identified by
trigger ID and its UTC scheduled timestamp. Interval schedules use elapsed-time
semantics independent of timezone. Materialization persists an immutable
database-time `anchor_at`; occurrence `n` is `anchor_at + n * interval`, with
the first occurrence one interval after the anchor. It advances from the
persisted scheduled instant rather than worker completion time. Disable retains
`next_fire_at`; re-enable applies the configured misfire policy before accepting
another occurrence. A changed published schedule creates new materialized
configuration and never rewrites an occurrence accepted under the old one.

A local cron time repeated by a backward DST transition fires once at the
earlier UTC instant. A nonexistent local cron time during a forward transition
fires once at the first valid instant after the gap. Persisted occurrence
identity prevents a restart or rescan from producing the second ambiguous
instant or duplicating the adjusted nonexistent occurrence.

The default misfire policy is `catch_up_once`: when multiple occurrences were
missed, create only the latest missed occurrence, then advance `next_fire_at`
past database now. V1 also supports `skip`, which advances without creating a
missed run. It never enumerates an unbounded catch-up backlog.

An occurrence is due when its resolved UTC timestamp is less than or equal to
the transaction's PostgreSQL `clock_timestamp()`. `catch_up_once` chooses the
greatest due timestamp, including a DST-adjusted cron occurrence, and persists
the next timestamp strictly greater than that same database-time observation.
`skip` creates no run and also advances strictly beyond it.

Multiple schedule scanners claim due rows with bounded PostgreSQL leases and
`FOR UPDATE SKIP LOCKED`. Reconciliation repairs expired claims from persisted
state. Acceptance and outbox publication remain idempotent by occurrence
identity. BullMQ repeatable or delayed schedules and process wall clocks are not
schedule authority.

## Consequences

Schedules retain local intent and recover deterministically across DST, process
loss, and transport loss. Fixed parser identity prevents dependency drift from
changing future fire times. The trade-off is explicit persisted schedule state
and database scanning rather than delegating recurrence to BullMQ.

## Rejected alternatives

- Storing only UTC cron expressions.
- Six- or seven-field cron, calendars, or general recurrence rules in V1.
- Floating `cron-parser` through a transitive dependency.
- Running both instants of an ambiguous local time or dropping a nonexistent
  local time.
- Replaying every missed occurrence.
- Worker time, process timers, or BullMQ repeat state as schedule authority.
