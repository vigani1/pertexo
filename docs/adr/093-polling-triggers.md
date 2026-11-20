# ADR 093: Polling triggers keep a durable position

- **Status:** accepted
- **Date:** 2026-11-20
- **Related:** [ADR 014](014-schedule-timezone-dst-misfire.md),
  [ADR 048](048-schedule-fire-history-and-next-runs.md),
  [ADR 056](056-workflow-auto-pause.md),
  [ADR 084](084-durable-trigger-event-coordination.md)
- **Feature:** [F54](../feature-plans/54-polling-triggers.md)

## Context

Polling observes a remote feed whose items can outlive a worker process. A
schedule occurrence identifies a time, while a poll can yield zero or more items.
The position must survive worker loss and reflect the items whose runs Pertexo
has committed.

## Decision

**One position per published trigger.** Add `app.trigger_polls`, keyed by
`(workspace_id, trigger_id)`, with a composite foreign key to the materialized
trigger, tenant row security and the existing trigger cleanup lifecycle. The
row owns the position, next due time, lease and poll failure streak. The
position starts uninitialized. A completed baseline gives it a bounded
seen-set, including an empty set for an empty feed. Store the set as an ordered
array of 32-byte SHA-256 hashes of typed canonical item keys on the poll row.
`POLL_MAX_SEEN_KEYS` holds 1,000 keys, ten times the per-poll item cap. Append
newly recorded keys and evict the oldest recorded keys when the array fills.
The bounded array keeps reads and updates under the existing poll-row lock
and avoids separate row cleanup. ADR 084 key windows remain optional
business-key policies for webhook and form events. Polling uses the seen-set
for item identity.

**Start at the first successful observation.** On the first poll, record
every key in the fetched head and start zero runs. A new publication gets a new
baseline. Retire the old claim and fence its commits against the current
publication. Resume on the same publication keeps the position. This follows
the new-items default in [Zapier](https://docs.zapier.com/integrations/reference/transfer)
and the current-time initialization of
[n8n's Gmail trigger](https://github.com/n8n-io/n8n/blob/master/packages/nodes-base/nodes/Google/Gmail/GmailTrigger.node.ts).
[Make's polling modules](https://developers.make.com/custom-apps-documentation/app-components/modules/trigger)
also persist a position and support explicit historical starts. Pertexo starts
with zero historical items.

**Fetch, admit, record.** Claim in a short database transaction, then fetch
outside it. Read the head within the page and item caps, stopping early at a
nonempty page containing only keys in the seen-set read for the claim. Validate the
fetched items within those caps before admission. Keep the first occurrence
of each key and offer unseen items in reverse feed order. Each item transaction
holds the workspace admission fence and checks the current publication,
pause state and live lease token. Run admission, the outbox and the seen-set
append commit together. Use a deterministic admission command identity per
published trigger and item key to prevent a second run while the admission
receipt is available. Stop at the first deferred item and leave it unseen
for the next poll.

A crash before admission leaves the item eligible on refetch. A crash inside
admission rolls back all of its writes. A crash after commit leaves both the
item's seen key and the run's outbox event. A replacement lease fences late
workers. Items still have to appear in a later fetched head to be retried.

**Reuse the scanner and auto-pause.** Extend `createScheduleTriggerScanner` and
`scanDueSchedules` in `schedules/schedule-scanner.store.ts` with polling claims,
using the database-time bounded lease protocol behind `claimDueScheduleRows`
and `retireScheduleClaim`. The existing worker trigger scan drives both kinds.
Poll cadence is independent of cron occurrence and misfire rules. Confirmed auth
loss pauses immediately. Repeated poll failures honor the effective auto-pause
setting and threshold. Both use the existing workflow trigger pause state, audit and
resume, with poll evidence that identifies the trigger and safe failure code.
No run is required to record that evidence.

**Bound the work.** Own the one-minute interval floor in the polling config
schema. Own the five-page and 100-item caps in the polling scanner and pass
them to the fetch adapter. Keep the HTTP response and deadline bounds from the
secure request path. Each successful poll schedules one new due time from
database time, including after downtime.

## Consequences

A poll can commit progress even when capacity is smaller than the fetched
batch. Keys must be unique and stable. Feed order determines admission order
within a poll. A newest-first feed starts the oldest candidate first. An unseen
item beyond an all-seen page may be missed, including when a feed reorders.
New items beyond the page or item cap can be missed. Poll often enough to keep
new items within the fetched head. An evicted key can start a run again if it
reappears after its admission receipt is gone. A new publication skips items
visible in its new baseline.
