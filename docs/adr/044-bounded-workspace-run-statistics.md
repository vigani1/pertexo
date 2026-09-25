# ADR 044: Bounded workspace run statistics

- **Status:** accepted — requested by the product owner
- **Date:** 2026-09-25
- **Related:** ADR 003, ADR 005, ADR 007, ADR 012, ADR 013 and ADR 015

## Context

The web app derives its run numbers by paging `GET /runs`. Home and Runs
headers read one 100-run page per status and show “100+” once a page overflows;
the failed-in-24-hours figure is a page count too; the Home Loom pages up to 300
runs inside a 1-, 6- or 24-hour window; and the spine's live count costs three
requests on every shell page. None of these numbers is exact once a workspace is
busy, and the Loom cannot describe a longer window honestly.

The workspace run list is a live, retained-history collection ordered by
`(createdAt, id)`. It deliberately has no total count, and the frontend plan
requires aggregates to be computed in scoped database queries with explicit
windows and `asOf` semantics rather than by downloading history. Run summaries
are retained for 90 days and attempts/events for 30 days (ADR 013).

## Decision

Add one bounded aggregate read:
`GET /v1/workspaces/:workspaceId/run-statistics?window=1h|6h|24h|7d&breakdown=workflow`.
It is a separate path so it cannot collide with `runs/:runId`. It requires
`run:read` with the run-list's non-disclosing workspace statuses (`active`,
`suspended`, `pending_deletion`) and uses the ordinary `authenticated_read`
rate class. Workflow names in a breakdown appear only when the actor also holds
`workflow:read`, exactly as on the run list.

### What is counted

- **Current counts** are exact counts of runs that are non-terminal right now:
  `queued`, `running` and `waiting`, whatever their creation time. Terminal
  statuses have no “current” count, because that would be a count of all
  retained history, which grows with retention rather than with activity.
- **Window counts** are exact counts per status, for all eight run statuses and
  their total, of runs whose `created_at` lies in `[asOf − window, asOf)`. The
  status is the run's current status, not a transition that happened inside the
  window. This is the same set the run list returns for
  `createdAtFrom`/`status`, so a figure and the list it links to agree.
- **Per-workflow breakdown** is opt-in (`breakdown=workflow`). It groups the
  same window by workflow, orders by window total descending then workflow ID,
  and returns at most 50 workflows with a `truncated` flag when more had runs.

### Windows and bounds

Windows are a fixed enum: `1h`, `6h`, `24h` (the default) and `7d`. Callers
cannot pass arbitrary ranges. The longest window is far inside the 90-day
run-summary retention, so a window count is complete retained data, not a
lifetime total; a 30-day window is excluded because it would approach the
retention edge and multiply the scanned rows by four. The breakdown is capped
at 50 workflows; the response is otherwise fixed-size.

### Consistency: one snapshot, computed live

Every section of one response is read in a single repeatable-read, read-only
workspace transaction under the existing RLS context. `asOf` is that
transaction's timestamp, returned with PostgreSQL's microsecond precision, and
the window bounds are derived from it on the server. Current counts, window
counts and the breakdown therefore describe the same snapshot and never
contradict each other. The figures are live at request time. There is no API
cache, and clients refresh by polling (the web uses 15 seconds for headers and
the spine, and 30 seconds for the Loom) and show `asOf`. PostgreSQL stays the
only authority (ADR 005). Redis and queue state play no part.

### Why not materialised

Maintained counters or hourly rollups would have to change on every run
transition in the coordinator's hot path (ADR 006/007). Retention, workspace
purge and legal hold would also have to rewrite them, restore-before-serve
would have to reconcile them (ADR 013/015), and they would need their own
invalidation and authorization rules. With fixed windows and covering indexes,
the live query reads only the index entries inside the window, so there is no
measured need for precomputation. Revisit this if the query-plan budget below
or measured p95 latency is exceeded under representative load.

### Cost budget

- Current counts read the existing
  `workflow_runs_workspace_status_created_idx (workspace_id, status, …)`
  for the three non-terminal statuses only. ADR 012 admission bounds that set
  (by default 5 active and 100 queued runs per workspace).
- Migration `0113_workflow_run_statistics_index.sql` adds
  `workflow_runs_workspace_created_statistics_idx (workspace_id, created_at)
  INCLUDE (status, workflow_id)`. Window and breakdown counts are one
  index-only range scan over the window's rows, with no heap visits for
  all-visible pages and no rows from other workspaces or outside the window.
  The breakdown adds at most 51 primary-key lookups for workflow names.
- The transaction runs with a 2-second statement timeout. A read that cannot
  finish inside it fails as a retryable server error instead of holding a pooled
  connection. The web keeps the last successful figures and offers Retry.
- The integration suite asserts the plan shape against a disposable database:
  index-only scans on the named indexes, no sequential scan, and plan row work
  bounded by the rows inside the window plus a small constant. Rows outside the
  window and in another workspace add no work.
- The new index adds one index entry per run insert and per non-HOT status
  update. Status is already indexed, so status updates were never HOT.

## Consequences

Home, Runs and the spine can show exact numbers from one request, the Loom can
label its plotted sample against the true total, and a 7-day Loom becomes
possible. The costs are one more index on `workflow_runs` and a read whose
cost grows with the number of runs in the requested window, capped by the
statement timeout. Counts describe retained, window-bounded data. They are not
lifetime totals, billing or usage figures.

## Rejected alternatives

- Adding totals to `GET /runs`: it would put a count on every page and blur a
  live paginated list with an aggregate snapshot.
- `runs/statistics` under the run collection: it collides with `runs/:runId`.
- Arbitrary `createdAtFrom`/`createdAtBefore` ranges and time buckets: they
  make the cost unbounded and are not needed by any current screen.
- A 30-day window: it nears retention and quadruples the scanned rows.
- Materialised counters or rollups, and caching in Redis (see above).
- Approximate counts from planner statistics: they are neither exact nor
  workspace-scoped.
