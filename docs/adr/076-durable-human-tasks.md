# ADR 076: Durable authenticated human tasks

- **Status:** accepted under the owner's autonomous feature instruction
- **Date:** 2026-10-15
- **Plan:** [F10 Approvals](../feature-plans/10-human-approvals.md)

## Context

F10 needs a human decision to pause a run for seven days by default. F11 then
needs member input at the same boundary. Existing Wait is a timed suspension;
Call already separates a short declaration attempt from an immutable logical
result. Inbox read state, worker leases and process timers cannot authorize or
own a human response. Ordinary run deadlines are at most one hour, and ordinary
waiting runs consume active capacity.

## Decision

An Approval declares one workspace/run/version/invocation-bound pending task.
The declaration attempt validates config and succeeds; the coordinator puts the
logical step into `human_task` wait and persists its task with the checkpoint.
A task-owned result reference separates the eventual decision from the immutable
declaration attempt, following the existing Call boundary. The pure engine owns
branch selection and expiry failure handling. No worker sleeps and no new queue,
service, package or database role is introduced.

The audience is captured roles and/or named member IDs, default owner/admin.
Eligibility always requires current active membership, user, workspace and run
read access. The initiating human cannot decide Approval tasks, including in
Call descendants; ordinary replay binds its new initiator. Automated starts have
no human initiator. Operator replay preserves source attribution. F11 request
input will use the same pending-task owner with its own explicit audience and
self-response policy, not a second decision store.

A decision locks current authority, the run and task in the existing workspace
lock order. Database time must precede expiry; committed cancellation or terminal
state prevents acceptance. One atomic resolution records the decision, optional
plain comment, deciding user and timestamp, audit and normal coordinator outbox.
Idempotent retries return that command's result; another decision cannot replace
it. Membership loss, read state, stale UI, automation tokens or an unguessable ID
are never a decision capability. Decision and comment are ordinary retained step
output, visible to authorized run readers.

Expiry defaults to seven days, bounded from one hour to thirty days. It is a
fixed `pending_task.expired` failure, not rejection or a run timeout. Extend ADR
073's strict failure-value contract with exact human-task expiry/capacity pairs,
separately from routable executor failures, so failure links can handle expiry.
Approval's normal branches are `approved` and `rejected`. Existing linear
handler restrictions remain. F09 step recovery does not reuse human decisions
until it has explicit decision-prefix evidence; full replay creates fresh tasks.

Quiescent human waiting pauses the remaining run deadline and releases active
capacity. Ordinary timed Wait/retry behavior stays unchanged. The run retains
status `waiting`, with durable human-wait start and remaining execution budget;
the shared SQL capacity count and admission fence enforce normal reacquisition
before worker work resumes. Active siblings keep the original deadline. Calls
propagate human quiescence and restore ancestor budgets/caps through ordinary
wakeups without cross-run lock cycles. Expiry/cancellation can settle without an
active slot, while any handler or continuation must reacquire one.

Outstanding pending tasks are bounded by the workspace's existing queued-run
allowance (default 100), under its admission counter. An over-budget declaration
becomes an explicit `pending_task.capacity_exceeded` failure; it cannot stall
checkpoint commits. Lowering the allowance preserves existing tasks. This is a
pending-task budget, not an extra charge to the ordinary run queue.

The existing due-node scanner owns expiry wakeups, with the node's persisted due
marker; only typed task facts settle the logical step, never a due worker retry.
Pending tasks close on cancellation, Stop or scope pruning. Run input and files
remain available to live human runs. Task/comment history follows run-detail
retention and workspace purge. No email, anonymous approval, escalation,
reassignment or multi-person voting is included.

## Consequences

Approvals and the already requested F11 input interactions have one durable
response mechanism. Decision output remains reproducible, authorization stays
current, and long human waits neither occupy workers nor starve active slots.
This adds explicit checkpoint control/result identities and requires matching API
and worker readers before first publication. Rollback must settle/cancel pending
human runs and retain compatible readers for served history; turning off a UI
control cannot make an old worker understand these records.
