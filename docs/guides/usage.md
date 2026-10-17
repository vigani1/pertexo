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
links require the existing workflow-read permission. There is no billing, quota
editor or lifetime reporting in this page.

Coordinated trigger events appear as a separate activity count. Each new business
event counts once, including events later replaced or refused; exact transport
retries and worker scans do not add usage. These events can also start ordinary
runs, so the counts are separate measures. See [event coordination](event-coordination.md).
