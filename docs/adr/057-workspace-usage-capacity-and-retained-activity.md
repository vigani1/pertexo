# ADR 057: Workspace capacity and retained activity without billing

- **Status:** accepted — first F12 slice authorized by the product owner
- **Date:** 2026-10-01
- **Related:** ADR 012, ADR 035, ADR 044

## Decision and metric dictionary

The read-only Usage page separates current operational capacity from retained
run activity. Neither is a billing or consumed-operation meter. No preview,
attempt, lifetime, calendar-period, pricing or warning measure is introduced.

| Measure | Unit and authoritative source | Meaning |
| --- | --- | --- |
| Active runs | Runs in `running` or `waiting`, irrespective of creation time | Current execution, not attempts |
| Reserved active slots | Current `workflow_run_active_admissions` rows | Dispatcher reservations also consume active capacity; these runs remain queued |
| Active capacity consumed | Active runs plus reserved active slots | Same occupancy considered by admission; not a distinct run total |
| Queued runs | Runs in `queued`, including reserved runs | Accepted work awaiting execution; excludes unaccepted trigger backlog |
| Configured active/queued limits | Current entitlement pointer and immutable version | Current new-acceptance policy, not a promise for already accepted runs |
| Charged artifact bytes/count | `workspace_artifact_capacity` totals | Pending, available and deleting artifacts remain charged until physical deletion completes |
| Artifact capacity | The same capacity row's byte/count limits | Operational storage limits, not billing or object-store inventory |
| Retained run activity | Unchanged ADR044 statistics in `1h`, `6h`, `24h` or `7d` | Runs created in `[asOf-window, asOf)`, grouped by current status, not status transitions |

Retries remain in their existing run; replay creates a new run. Canceled runs
belong to activity when created inside the window, but consume no current slot.
Subworkflow runs are counted only as the authoritative run source represents
them; no inferred child, operation or attempt accounting is added.

## Effective limits and exact representation

Do not infer execution defaults when the current entitlement is absent. Missing
pointer/version or counter authority is unavailable and admission fails closed.
Report configured limits separately from whether the current entitlement is
active, suspended, not yet effective or expired, evaluated at the snapshot.
Provisioned defaults remain 5 active and 100 queued. Already accepted runs retain
their pinned entitlement version; their eventual admission is not guaranteed by
the displayed current limits. Reporting never changes acceptance or dispatch.

Artifact capacity is lazily created for a new workspace by its first reservation.
An absent row in an authorized active workspace therefore reports the existing
writer defaults (1 GiB/1,000 artifacts, zero charged), explicitly marked as
default rather than stored. Existing rows, including zero limits and charges
above a lowered limit, are reported exactly. Byte totals and limits travel as
canonical nonnegative decimal strings, preserving PostgreSQL bigint precision.

## Authorization, snapshot and cost

`GET /v1/workspaces/:workspaceId/usage-capacity` requires both existing
`run:read` and `artifact:read` capabilities and an active workspace. This
conservative intersection creates no broader reporting permission. Session,
active membership, non-disclosing denials and ordinary `authenticated_read`
rate limiting precede persistence. It returns no artifact or capacity data for
suspended, pending-deletion or inaccessible workspaces. The page independently
uses the existing run-statistics endpoint, whose run-read state rules and
workflow-name disclosure remain unchanged; it may still show retained activity
where capacity is unavailable. No owner-only quota editor is introduced.

Capacity is one repeatable-read, read-only RLS-scoped transaction with a
2-second statement timeout and microsecond `asOf`. Read current entitlement and
counter/capacity rows by workspace key, plus indexed nonterminal run counts and
indexed reservation counts. Existing counters do not include reservations and
must not be presented alone as consumed active capacity. Add only the missing
reservation workspace index and a scoped scalar read function, with its reviewed
body, owner, grants and search path checked at startup: API runtime gets
the count of its installed workspace, not direct reservation-row access or any
mutation authority. No locks for admission, queue I/O, object-store I/O,
historical scan, speculative rollup or persistent reporting state is added.

Activity remains its own ADR044 snapshot, with its own `asOf`, exact server
window bounds and at most 50 workflow groups. A drilldown passes both server
window bounds and status/workflow filters to the existing run list. Browser
history paging is not aggregation. The maximum 7-day window is within 90-day run
summary retention; attempts' 30-day retention is irrelevant to these measures.
Coverage means retained rows in this fixed window, never reconstructed deleted
history. Late inserted runs appear in a later snapshot when their creation time
belongs to that snapshot's window. Fixed durations have no DST/calendar reset.

## Freshness, rollout and deferred slices

Capacity and activity refresh independently at 30 seconds while the page is
visible and support manual Refresh. Display each successful snapshot's `asOf`;
preserve prior figures with stale/error feedback on transient failure. Permission
or workspace-state loss must not keep forbidden capacity visible from cache.
Unavailable is not zero and a zero stored limit is not unlimited. No API cache
or promise of remaining admission slots is introduced: the figures can change
before a user submits a run or upload.

Deploy the additive migration before readers; establish migration/readiness,
cross-tenant, permission/state, exact limits, reservation, charging, query-plan
and integrated browser evidence before claiming the first slice complete.
Rollback hides reporting and removes readers without changing existing
enforcement or writers; the additive read function/index may safely remain.
The existing exact migration-head startup gate still applies: a rollback reader
build must retain head 0126 compatibility rather than redeploy an older image
that expects head 0125. This is not a new promise of mixed-head rolling startup.
There is no production rollout authorization here. F12 warnings, trends,
timezone settings, quota editing and billing remain deferred and the full F12
tracker must not imply their completion.
