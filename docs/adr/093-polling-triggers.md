# ADR 093: Polling triggers keep a durable position

- **Status:** proposed
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
position starts uninitialized, then holds either an empty baseline or one
bounded, opaque adapter position. HTTP stores a single 32-byte SHA-256 hash of
the typed canonical key of the latest handled item. The position identifies a
boundary in an ordered feed. ADR 084 key windows are the sole item deduplication
mechanism.

**Start at the first successful observation.** On the first poll, record the
current head or an empty feed and start zero runs. A new publication gets a new
baseline. Retire the old claim and fence its commits against the current
publication. Resume on the same publication keeps the position. This follows
the new-items default in [Zapier](https://docs.zapier.com/integrations/reference/transfer)
and the current-time initialization of
[n8n's Gmail trigger](https://github.com/n8n-io/n8n/blob/master/packages/nodes-base/nodes/Google/Gmail/GmailTrigger.node.ts).
[Make's polling modules](https://developers.make.com/custom-apps-documentation/app-components/modules/trigger)
also persist a position and support explicit historical starts. Pertexo starts
with zero historical items.

**Fetch, admit, advance.** Claim in a short database transaction, then fetch
outside it. HTTP reads from the newest end until it proves it reached the
stored item or the end of a previously empty feed. Validate the bounded range
before opening admission transactions. Process oldest first. Each tenant
transaction holds the workspace admission fence and ADR 084 coordination lock,
then checks current publication, pause state and the live lease token. Commit
run admission, outbox, key-window charge and position together. A live charged
key already proves acceptance in this trigger's scope. Stop at the first
unaccepted item, including capacity or concurrency deferral. The next poll
starts from the committed prefix.

A crash before admission leaves the item eligible on refetch. A crash inside
admission rolls back all of its writes. A crash after commit leaves the item at
or behind the committed position and the run in the outbox. A replacement lease
fences late workers. These guarantees cover items the source continues to
expose in stable order. An unreachable position or a fetch limit reached before
proving the range produces a visible failure and holds the position.

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
batch. A long outage or an incompatible feed can leave the committed position
outside the accessible range, requiring intervention. Publication starts a
new observation window, so users should expect items already visible at that
baseline to be skipped.
