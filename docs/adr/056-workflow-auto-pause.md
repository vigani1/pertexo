# ADR 056: Pausing triggers of a workflow that keeps failing

- **Status:** accepted
- **Date:** 2026-09-30
- **Related:** ADR 014 and ADR 048 (schedules and their occurrences), ADR 026
  and ADR 045 (webhook ingress and its delivery log), ADR 033 and ADR 034
  (activation and lifecycle), ADR 055 (terminal failures folded per workflow),
  [F26](../feature-plans/26-workflow-auto-pause.md)

## Context

Schedules and webhooks start runs whether or not the workflow works. A workflow
whose integration broke keeps failing on every fire and every delivery,
spending run capacity, provider quota and downstream data until someone
notices. The inbox (ADR 055) now tells people a workflow is failing, but nothing
stops it.

People can already turn a schedule off or disable a webhook endpoint, and
ADR 034 protects that choice: reconciliation never re-enables a resource a
person disabled. An automatic stop must not be confused with that choice, or
resuming would turn on something a person had turned off.

The failure count must not be a counter updated in every run's terminal
transaction: a noisy workflow would serialize its runs on that row, the
contention ADR 055 avoided for the inbox.

## Decision

### What counts

A workflow's **failure streak** is the number of consecutive runs, started by
one of its schedules or webhooks, that ended `failed`, `timed_out` or
`outcome_unknown`, ordered by when they ended. A `succeeded` run started by a
schedule or webhook resets it to zero. `canceled` runs neither count nor reset:
a person stopped them. Runs started manually, through the API or as replays
neither count nor reset; they are how people test a fix, and their outcome says
nothing about whether the triggers work. `outcome_unknown` counts because a
workflow that keeps ending in an unknown state needs a person as much as one
that keeps failing. Once F09 exists, errors a workflow handles itself are not
failures.

### The rule

A workflow pauses when its streak reaches its threshold. The workspace default
is 10; people with `workspace:manage` (owners under the current role policy) can set it between 3
and 100, and people with `workflow:update` can override it per workflow within
the same range or turn auto-pause off for that workflow. These are operational
settings on the workflow and workspace rows, not part of a published version:
changing them never requires publishing. Turning auto-pause off, or changing a
threshold, is audited. A threshold change applies to the next evaluation; it
never pauses or resumes retroactively.

A failure rate over a window (as Zapier does) was rejected: it needs a history
per workflow instead of one number, takes days to react to a hard break, and
reads less plainly than "10 failures in a row".

### Paused is its own state

A pause is recorded on the workflow as **trigger pause state** — `paused` with
the reason (`consecutive_failures`), the streak and the last counted run, the
time, and a pause revision — separate from lifecycle, activation, trigger
status and schedule status. Pausing never changes a trigger, endpoint or
schedule row. Resuming therefore restores exactly what the pause stopped: a
schedule a person turned off stays off, and a disabled endpoint stays disabled.

While paused:

- **Schedules** keep their leases and recurrence. Each due occurrence is
  recorded with the new outcome `paused`, with no run, and the schedule
  advances to its next occurrence. Occurrences that fall due while paused are
  never run afterwards, whatever the misfire policy: resuming continues from the
  next future occurrence, so a long pause does not end in a burst.
- **Webhooks** keep resolving their endpoint. After the signature and replay
  checks of ADR 026, the transaction that would accept a new delivery finds the
  workflow paused and refuses it with **HTTP 423** and the problem code
  `webhook.workflow_paused`, recorded in the delivery log with the
  new outcome `paused`, no run and `signature_check = verified`. An exact retry
  of a delivery accepted before the pause still answers `replayed` with its
  earlier run. Only a sender that proved the signature learns the workflow is
  paused; unverified requests get the responses they get today. Senders that
  retry will see 423 until someone resumes; deliveries refused while paused are
  not replayed later.
- **Manual runs, API runs and replays** still start, so people can test a fix.
- **Runs already queued, running or waiting** finish normally.

Archiving and restoring (ADR 034) leave the pause state as it is; the
evaluator never pauses a workflow that is not `active`.

### Evaluation: asynchronous, bounded, exactly once

When a run started by a schedule or webhook reaches a terminal state, the
same transaction inserts one row into an insert-only outcome log: workspace,
workflow, run, whether it counts as a failure, and when it ended, unique per
run. As with ADR 055, no workflow row or counter is touched there.

A worker loop calls one owner function every few seconds. It takes up to a
bounded number of pending outcomes across workspaces (`FOR UPDATE SKIP
LOCKED`), groups them per workflow in end order, locks each workflow's streak
row once, applies the outcomes, and deletes them, all in one transaction. When
a streak reaches the threshold of an `active` workflow with auto-pause on that
is not already paused, the same transaction records the pause and its audit
fact. A crash rolls everything back; several workers take disjoint outcomes and
serialize briefly on a workflow's streak row, so a burst of concurrent failures
pauses exactly once.

The streak row keeps only the current count and the last counted run. It is
deleted with its workflow and by workspace purge (ADR 013); outcome rows live
seconds.

### Resuming

`POST /v1/workspaces/:workspaceId/workflows/:workflowId/resume` takes
`{expectedPauseRevision}` and follows ADR 034's lifecycle command rules:
session, CSRF, exactly one `Idempotency-Key`, and `workflow:publish`, because
resuming changes what production admits (owners, admins and builders hold it,
the same people as `workflow:update`). A stale revision is a typed conflict; a
workflow that is not paused is a no-op. Resuming clears the pause, resets the
streak to zero and appends an audit fact in one transaction. It never touches a
trigger, endpoint or schedule.

The pause revision is a canonical positive decimal string in JSON, preserving
the database's bigint precision. Operational settings have their own revision,
independent of drafts, workflow lifecycle and pause state; the workspace default
uses the workspace revision. Exact command retries replay the accepted snapshot
before rechecking the historical revision, without rewriting older authoring
receipts. Clients reload current authority after a command or conflict.

Resume records a terminal-time cutoff: outcomes that ended before the resume
are consumed without rebuilding the cleared streak, including delayed commits.
Runs still in flight can contribute when they end after resume. The evaluator,
resume and settings commands share workflow serialization; workspace default
changes serialize against evaluation. The evaluator rechecks current settings
and lifecycle under the workflow lock before recording a pause. Resume does not
lock or delete pending outcome rows, avoiding an outcome-queue/producer lock
cycle. A no-op resume changes neither the streak, cutoff, revision nor audit.

There is no automatic resume.

### Notices

The pause transaction records everything a notice needs: the reason, the
streak, the last counted run and the time. Telling people is F27's notice kinds
work: the pause notice and the optional warning two failures before the
threshold arrive with it. Until then the workflow shows a paused banner with
the reason and a Resume action, the schedule and webhook histories show
`paused` entries, and the inbox thread (ADR 055) already shows the failures
that led to the pause.

### Rollout

The worker's `WORKFLOW_AUTO_PAUSE` is `off`, `observe` or `enforce`, and the
code default is `off`. In `observe` the producer and evaluator run and export
would-pause metrics, but no workflow pauses. The deployment moves from observe
to enforce after the metrics look right. Setting it back to `off` or `observe`
stops new pauses; existing pauses stay until someone resumes. The evaluator
reports readiness and lag like the inbox fold.

## Consequences

- A broken workflow stops its schedules and webhooks after a bounded number of
  failures, without slowing any run, and people choose when it starts again.
- Two new outcome values reach public contracts: the schedule occurrence
  outcome `paused` and the webhook delivery outcome `paused` (HTTP 423). The
  delivery log's check constraint binds `paused` to 423, a verified signature
  and no run.
- Every schedule- or webhook-started run pays one small insert at its terminal
  transaction, including successes, because successes reset the streak.
- A sender whose retries run out while a workflow is paused loses those
  deliveries. That is the cost of stopping a broken workflow; people see each
  refusal in the delivery log.
- Until F27 ships notice kinds, a pause is visible on the workflow and in the
  trigger histories but is not pushed to the inbox as its own notice.

## Alternatives considered

- **Disable the triggers.** Reuses existing state but makes the pause
  indistinguishable from a person's choice, so resuming could turn on a trigger
  someone turned off, contradicting ADR 034.
- **Count in the run's transaction.** Simple, but serializes a noisy workflow's
  runs on one row.
- **Skip paused schedules instead of recording them.** Leaves no trace of what
  the pause stopped and lets the misfire policy fire a burst on resume.
- **Answer paused webhooks with 503.** Invites retries that look like an outage
  and collides with ADR 045's unrecorded regional-pause 503; a distinct 423
  after verification says what happened.
- **Pause on a failure rate.** See the rule above.
