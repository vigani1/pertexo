# ADR 055: Workspace inbox as per-workflow failure threads, read on demand

- **Status:** accepted
- **Date:** 2026-09-29
- **Amended:** 2026-10-09 under ADR 069

> **Amendment note (2026-10-09, ADR 069).** Every feature switch is on: the
> worker always records terminal failures for the inbox, and the
> `WORKSPACE_INBOX_PRODUCER` flag described below is gone.
- **Supersedes:** ADR 054's delivery model — audience capture, per-recipient
  fan-out, per-entry retention, resumable read-all and source resume. ADR 054's
  product rules below remain.
- **Related:** ADR 004 (session and authorization), ADR 013 (retention, legal
  hold and purge), ADR 022 (external failure alerts)

## Context

ADR 054 delivers a failed run as one entry per eligible person. Every failure
freezes an audience, then copies the notice to each recipient in leased,
fenced pages of 100. It works, but it scales with failures × recipients:

- 50 admins and a workflow failing every minute write 72,000 entries a day,
  each kept for 30 days, and every one is a separate unread item.
- The write path needs audience capture, fan-out leases, fences, backoff,
  exhaustion, an operator resume command, and per-entry and per-receipt
  cleanup. It had shipped three inactive increments without a usable inbox.
- Read-all over an unbounded population needed a resumable background
  operation with its own status resource.

Failure notices are workspace-wide alerts to a role, not personal messages.
Systems that serve that shape at scale (issue trackers, error monitors) group
events by subject and compute each reader's view on demand.

## Decision

### Product rules kept from ADR 054

- Recipients are people who can currently read runs in an **active**
  workspace as an owner, admin or operator, with an active account. The shared
  role policy grants them the `notification:read` capability; the database
  enforces the same rule on every read.
- Sources are newly occurring terminal `failed`, `timed_out` and
  `outcome_unknown` runs. Cancellation, success, step progress and history
  before activation produce nothing. A replay is a new run.
- Reading a notice does not acknowledge or resolve the incident.
- External failure alerts (ADR 022) stay independent.

### One thread per failing workflow

A notice is a **thread**: one per workspace and workflow. It records how many
times the workflow has failed, its first and latest failure, and the latest
run and failure kind. A new failure updates the thread and gives it a new
revision, which makes it unread again for everyone.

Individual failures stay one click away: the thread links to its latest run
and to the workflow's failed runs. Storage and the inbox's length grow with
the number of failing workflows, never with failures × people, so a noisy
workflow is one notice rather than a flood.

### Write path: one insert, in the run's own transaction

When a run commits a terminal failure, the same transaction inserts one
`workspace_inbox_events` row: workspace, workflow, run, terminal event
sequence, kind and time, unique on `(workspace, run, terminal sequence)`.
It is insert-only: no thread row, counter or outbox row is touched, so a burst
of concurrent failures in one workflow never contends on a hot row and never
slows run completion. The checkpoint revision already makes the terminal
commit exactly-once; the unique key is defence in depth.

The worker writes events only while its `WORKSPACE_INBOX_PRODUCER` flag is on.
It is off by default. Turning it on starts with new failures only; there is
no backfill. Turning it off stops new events; everything else keeps working.

### Aggregation: a bounded, idempotent fold

A worker loop calls one database function every few seconds. The function
takes up to a bounded number of pending events across workspaces
(`FOR UPDATE SKIP LOCKED`), groups them by workflow, upserts each thread once
in workflow order, then deletes those events, all in one transaction. So:

- Each failure is folded exactly once. A crash rolls back both the thread
  change and the deletion.
- Several workers can run the loop at once; they take disjoint events, and
  concurrent updates to one thread serialize on its row briefly.
- A burst of N failures costs one thread update per workflow per batch, not N.
- Revisions come from one database sequence: monotonic, contention-free, and
  only compared, never summed. Events are a work queue, not history; runs and
  run events remain the record.

### Read model: computed on read, private read state

Threads are shared by the workspace's eligible readers. Each person's state is
one `workspace_inbox_reads` row per thread they have read, holding the thread
revision they read. A thread is unread when it has no read row or a newer
revision. So:

- **Single read** records the revision the reader saw, never above the thread's
  current revision, and never moves backwards. A failure that arrives after
  the reader looked keeps the thread unread.
- **Read-all** takes the revision the reader's inbox showed and marks every
  visible thread at or below it read, in one statement. Threads updated
  afterwards stay unread. Its cost is bounded by the workspace's number of
  failing workflows, so no background operation is needed.
- **Unread count** counts visible threads without a current read, bounded by
  the same number.
- A person who becomes eligible sees the workspace's current threads; a person
  who loses eligibility sees none, and regains their unexpired read state if
  eligibility returns.

Threads are visible for 30 days after their latest failure.

### Authorization

Row-level security enforces everything; the API capability only decides what
to show:

- The API role reads threads only through the existing eligibility function:
  active workspace, active user, active eligible membership, and the actor is
  the session's user.
- Read rows are the actor's own; the API may insert and raise them, never
  lower them.
- The worker may only insert events, within its tenant context.
- Aggregation and cleanup run through owner functions with narrow owner
  policies, following the existing cross-workspace scanner convention.

### Retention, holds and deletion

- The loop deletes threads, with their read rows, 30 days after their latest
  failure, in bounded batches, and skips workspaces under a legal hold.
- Events are deleted when folded. A pending event is deleted with its run,
  through a cascading reference, so run retention and purge never wait on the
  inbox.
- Workspace purge removes reads, threads and events before workflows, runs and
  memberships, as explicit participants rather than cascades.

### Live updates

After a fold commits, the worker publishes a bounded "inbox changed" hint on a
per-workspace Redis channel. The API streams hints over SSE to eligible
readers, rechecking authorization under ADR 004's session and watchdog rules.
Browsers refetch the summary and list, so a missed hint loses nothing: focus,
reconnect and a slow background refetch recover. A hint never carries notice
content.

### Retiring ADR 054's delivery machinery

None of it was ever activated, so its tables are empty. A forward migration
drops its capture and fan-out functions and its source, audience,
recipient-state and entry tables, refusing to run if any hold rows, and
rewrites the workspace purge list. The eligibility function is kept. The
published list, summary and read contracts change to the thread shape before
any client uses them.

## Consequences

- Each failure costs one insert and a share of one batched update, however
  many people can see it.
- A workspace's inbox is bounded by its failing workflows. A noisy workflow is
  one unread thread with a count, not a flood.
- The design needs no audience capture, fan-out leases or backoff, no source
  resume command, no per-entry retention and no read-all operation.
- A failure appears in the inbox after the next fold, within seconds rather
  than in the run's transaction.
- The inbox shows a workflow's failure count and latest failure, not every
  failed run; the runs list remains the per-run view.
- Per-person muting, subscriptions for builders, and other notice kinds are
  later additions to the same model (a thread per subject).

## Alternatives considered

- **ADR 054's per-recipient copies:** exact per-person history, but write
  amplification and machinery scale with failures × recipients.
- **Updating the thread in the run's transaction:** simplest, but concurrent
  failures of one workflow would all serialize on its thread row, slowing runs
  exactly during an incident.
- **One outbox job per failure:** low latency, but one queue job per failure
  under bursts; the batched fold coalesces them.
- **A per-person read-all watermark:** O(1), but cannot tell threads read
  individually from threads read in bulk without extra rules; bounded per-thread
  rows are simpler and still cheap.
