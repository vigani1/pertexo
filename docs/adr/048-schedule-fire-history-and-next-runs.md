# ADR 048: Schedule fire history and next runs

- **Status:** accepted
- **Date:** 2026-09-25
- **Related:** ADR 013 (retention), ADR 014 (schedule timezone, DST and
  misfire), ADR 045 (webhook delivery log)

## Context

ADR 014 makes PostgreSQL the schedule authority. The scanner records one
`app.trigger_schedule_occurrences` row for every occurrence it completes, with
the disposition `accepted` (a run was admitted, and its identifier is kept) or
`skipped` (the `skip` misfire policy advanced past it). ADR 013 keeps those rows
as 90-day trigger-summary metadata. No public read exposes them, and the only
forward-looking fact is the single persisted `next_fire_at`.

People cannot see what a schedule did recently, which run each occurrence
started, or whether a rule they are drafting will run when they expect,
particularly across daylight-saving changes. The web Triggers tab and the
editor's Schedule step need those answers without inventing a second
recurrence implementation in the browser.

## Decision

### Occurrence history

`GET /v1/workspaces/:workspaceId/workflows/:workflowId/triggers/:triggerId/schedule/occurrences`
returns `{ items, nextCursor }`, newest first by `(scheduled_at desc, id asc)`,
with `limit` 1–100 (default 25) and an opaque `after` cursor bound to the
trigger. The existing `(workspace_id, trigger_id, scheduled_at desc, id)` index
serves the order, so no migration is needed.

Each item is metadata only: the occurrence id, `scheduledAt`, `recordedAt` (when
the scanner completed the claim, which for an admitted run is the admission
transaction), `outcome` in the scanner's own terms (`accepted` or `skipped`) and
`runId` for `accepted` only. Occurrences whose `scheduled_at` is past ADR 013's
90-day cutoff are never served, even before the bounded retention stage removes
them; legal hold and workspace purge are unchanged.

Deferred admission (workspace run capacity), expired leases and failed claims
do not create an occurrence: the scanner releases or defers the claim and
reports it through trigger health (`schedule.admission_throttled`,
`schedule.scan_failed`). The history therefore never claims a failure it did not
record, and the product shows those states from trigger health instead. Adding
failure rows would change what the scanner persists and is out of scope.

### Next fire times

`GET …/triggers/:triggerId/schedule/next-runs?count=` returns
`{ observedAt, items: [{ scheduledAt }] }` with `count` 1–10 (default 3). The
first item is the persisted `next_fire_at`, even while it waits for a scanner.
Each later item is exactly the `nextAt` the scanner persists when it observes
the previous one (or database time, if that is later), computed by the same
`resolveScheduleObservation` engine, parser version, timezone and DST rules
(`projectScheduleOccurrences`). A schedule the scanner would not claim (turned
off, superseded, archived or inactive) returns no items. `observedAt` is the
database clock the projection used.

### Draft preview

`POST …/triggers/schedules/preview` takes `{ config, count? }`, where `config`
is the Schedule step's own setup shape. The contract checks its structure
strictly; the scheduler's `parseScheduleRecurrence` then checks the rule in its
timezone, and anything it would reject at publication is a `400
request.invalid`. The misfire policy is accepted but ignored, because it never
changes when a schedule fires. The result is projected as if the rule were
published at database time: the anchor is `clock_timestamp()`, as in
materialization.

The preview writes nothing. It runs in a read-only tenant transaction that only
authorizes the reader and reads the clock, and all projection happens after the
transaction ends. It still requires the CSRF proof of a `POST`.

### Authority and rate classes

All three reads use the schedule trigger reads' authority: the `workflow:read`
route guard and the database check that admits every active member of an active
workspace. A trigger that is not a schedule, belongs to another workflow or is
not visible returns the non-disclosing `404`. History and next runs use
`authenticated_read`; the preview uses `workflow_compile`, the class of draft
validation, because each request computes a projection.

Projection cost is bounded by `count` ≤ 10 and the engine's existing cursor
bound. Its per-timezone `Intl.DateTimeFormat` is now cached (a bounded map keyed
by canonical IANA names), which removes most of the cost of the minute-by-minute
DST scans without changing any result; the existing DST suite and the new
projection tests pin the behaviour.

## Consequences

Builders can see what a schedule did, open the run each occurrence admitted,
and read the next runs of both published and draft rules in the schedule's
timezone, with the scheduler's DST behaviour. Nothing new is stored. The
trade-off is that throttled or failed attempts appear only as trigger health,
not as history rows.

## Rejected alternatives

- A browser-side cron implementation, which would drift from the pinned parser
  and ADR 014's DST identity rules.
- Recording deferred or failed claims as occurrences in this slice, which would
  change scheduler persistence and occurrence identity.
- Serving the full remaining backlog or an unbounded horizon of fire times.
- Anchoring a draft preview on the browser's clock.
