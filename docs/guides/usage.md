# Usage and trends

Open **Usage** to see current active-run slots, queued runs, charged file storage
and file count. Running work and reserved dispatcher slots consume active
capacity. Tests use the same capacity. Figures are a snapshot, not a reservation
for the next run. Skipped trigger events are counted separately from runs.

The Inbox warns owners, admins and operators when a workspace reaches **80%** of
an active-slot, queue, file-storage or file-count limit. Each limit has its own
warning. Remaining above the threshold does not repeat it; falling below and
crossing again starts a new warning episode. Existing limit-reached notices stay.
Personal email settings apply, including immediate messages and digests; see
[notifications](notifications.md). Observation and delivery are best effort: a
brief spike wholly between checks can be missed. A zero limit is already reached,
not an approaching limit. Warnings do not change capacity or admission behavior.

Choose **View trends** for the last **30 or 90 UTC calendar days**, including the
partial current day. The daily thread chart shows outcomes; **Daily data** gives
exact counts and durations in a keyboard-scrollable table. The page also shows
average and slowest elapsed duration, the ten busiest workflows and the ten with
the most failures. Failed, timed-out and unknown-outcome runs count as failures.
Canceled runs remain a separate outcome.

Trends exclude tests. Actual child, replay and error-workflow runs count once;
step retries within one run do not add runs. A run belongs to the day it started
being recorded, and its current outcome appears in the next snapshot. Completed
runs with a start time contribute completion-minus-start elapsed duration. This
includes waits and excludes the queue before starting. Missing duration is shown
as unavailable, never zero.

The page reads retained run summaries, including after detailed inputs/outputs
expire. It cannot reconstruct deleted history or dates before the workspace
existed. The coverage and snapshot labels explain what is available. Data refreshes
while the page is visible; **Refresh** requests a fresh snapshot. A temporary read
failure marks an old snapshot stale; losing access removes it. Workflow names and
links require the existing workflow-read permission. There is no billing or lifetime
reporting in this page.

## Capacity an operator sets

These are instance settings, read when the API starts and applied to every
workspace, new and existing. Set them in the API's environment (`api.env` on the
single server) and restart the API. A value that isn't a whole number stops the
API at startup, and the error names the setting.

| Setting | Default | What it limits, per workspace |
|---|---|---|
| `WORKSPACE_ACTIVE_RUN_LIMIT` | 20 | Runs working at once. A timed Wait doesn't count; see [concurrency](concurrency.md). |
| `WORKSPACE_QUEUED_RUN_LIMIT` | 10,000 | Runs waiting to start. Past it, new runs are refused. |
| `WORKSPACE_FILE_LIMIT` | 10,000 | Stored files. Past it, new files are refused. |
| `WEBHOOK_ENDPOINT_BURST_LIMIT` | 600 | POSTs a minute to one webhook endpoint. Past it, senders get 429. |

The defaults suit a server with about 4 CPU cores and 8 GB of memory. On a small
one (2 cores, 4 GB) start with `WORKSPACE_ACTIVE_RUN_LIMIT=5`,
`WORKSPACE_QUEUED_RUN_LIMIT=1000` and `WEBHOOK_ENDPOINT_BURST_LIMIT=120`, and raise
them while memory and database load stay comfortable. Active runs are what cost
most: each holds worker and database time, so a small server slows down long
before the queue fills. Lowering a limit doesn't stop work already running. A
workflow's own **Runs at once** still applies inside these limits.

## Other activity

Coordinated trigger events appear as a separate activity count. Each new business
event counts once, including events later replaced or refused; exact transport
retries and worker scans do not add usage. These events can also start ordinary
runs, so the counts are separate measures. See [event coordination](event-coordination.md).
