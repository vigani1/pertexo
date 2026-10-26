# ADR 076: Durable authenticated human tasks

- **Status:** accepted under the owner's autonomous feature instruction
- **Date:** 2026-10-15
- **Plan:** [F10 Approvals](../feature-plans/10-human-approvals.md)
- **Amended:** 2026-10-26 by [F50 timeout paths](../feature-plans/50-task-timeout-paths.md)

> **Amendment note (2026-10-26, F50).** Expiry is still `pending_task.expired`
> by default, and every step saved before F50 keeps that. An Approval or Request
> input may instead choose `onExpiry: 'continue'`: expiry then settles as a
> success on a `timed_out` output port, and the expiry sweep records the
> timed-out output on the task row (`output_ref` on an expired approval or
> input request) in the same transaction, so every reader takes a task's output
> from one place. Capacity refusal, cancellation and late decisions are unchanged.

## Context

F10 needs a human decision to pause a run for seven days by default. F11 then
needs member input at the same boundary. Existing Wait is a timed suspension;
Call already separates a short declaration attempt from an immutable logical
result. Inbox read state, worker leases and process timers cannot authorize or
own a human response. Configured ordinary run deadlines are bounded by one hour, and ordinary
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
read access. By default, the initiating human cannot decide Approval tasks, including in
Call descendants; the captured per-step `allowStarterToDecide` setting may
explicitly permit that human while retaining all other eligibility checks; ordinary replay binds its new initiator. Automated starts have
no human initiator. Operator replay preserves source attribution. F11 request
input will use the same pending-task owner with its own explicit audience and
self-response policy, not a second decision store.

A decision locks current authority, the run and task in the existing workspace
lock order. Database time must precede expiry; committed cancellation or terminal
state prevents acceptance. One atomic resolution records the decision, optional
plain comment, deciding user, recorded display name and timestamp, audit and
normal coordinator outbox.
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

### Deadline clarification from current admission code

The optional caller deadline is an absolute wall deadline, while the published
`maxRunDurationMs` is an execution budget. Preserve the caller deadline separately:
human waiting pauses only the execution budget, with operational deadline equal
to the absolute deadline while paused. A caller deadline still cancels waiting
on time; a run originally without a budget stays unlimited. Calls inherit the
parent's absolute deadline separately from its temporary execution deadline, so
an inherited one-hour budget never becomes an accidental seven-day approval cap.
Existing Call slot handoff remains: the parent regains its slot when the child
finishes; a long human wait releases the shared workspace slot, and each suspended
ancestor must satisfy its workflow cap before child work resumes.

Already declared, unstarted sibling Calls share their parent's human pause:
restore their remaining recorded deadline when the parent resumes, bounded by
its restored budget and absolute deadline. Do not revive a Call whose deadline
had already expired before the pause. Accepted children keep their own durable
paused clocks and their immutable Call identity.

## Consequences

### Amendment: captured mapped context (2026-10-15)

The declaration may carry mapped, named scalar details, bounded to 20 fields and
8 KiB. They are captured once with the task in the checkpoint transaction and
shown as plain text to authorized task/Inbox readers. They are retained run data,
never email, audit or error-workflow payload. The separate context column keeps
dynamic data outside immutable task setup and its 16 KiB configuration bound.
Matching readers must precede publishing mappings; older tasks have empty context.

Approvals and the already requested F11 input interactions have one durable
response mechanism. Decision output remains reproducible, authorization stays
current, and long human waits neither occupy workers nor starve active slots.
This adds explicit checkpoint control/result identities and requires matching API
and worker readers before first publication. Rollback must settle/cancel pending
human runs and retain compatible readers for served history; turning off a UI
control cannot make an old worker understand these records.

### Amendment: starter choice and recorded names (2026-10-16)

The owner approved a per-step opt-in to starter decisions, default off. The
choice belongs to immutable task setup, not mutable workflow settings. The same
TypeScript eligibility owner serves discovery, decisions, Inbox and mail. A
prospective editor hint counts the full current audience through the existing
authoring authority; directory search or its first page cannot determine that
someone would be the only decider. The hint is advisory because automated and
other-member starts can have another initiator.

New approval results capture `decidedByName` under the existing locked user
authority, using the decision's database-time query. Later profile edits do not
rewrite the recorded output or its displayed name. Earlier output may omit the
field; retain its existing current-name display fallback without fabricating a
historical value. No new table, role, service or executor identity is introduced.

### Amendment: context authoring and short lists (2026-10-16)

A named detail may be a plain scalar or a list of at most 20 plain scalars.
Nested lists and objects remain invalid. Keep the existing maximum of 20 named
details, 8 KiB total, immutable capture, authorized reads and email exclusions.
Deploy matching context readers before publishing list-valued mappings.

Approval and Request input share label/value authoring rows in the existing
inspector, with the normal value picker and advanced expressions. Persist the
existing literal-object or JSONata mapping, never a second mapping format or
editor metadata. Reuse the already pinned JSONata parser to recognize simple
object expressions without evaluating them in the browser. Imported whole-object
or dynamic-key mappings remain unchanged and editable in Inputs. Each row can
read a literal, run input, earlier step output, workspace variable or expression;
the JSONata runtime's existing context and server evaluation bounds still apply.


### Amendment: machine callbacks through the pending-task owner (2026-10-21)

The owner approved F46's callback task kind and prepared state. Existing Approval
and Request input authorization and decider requirements remain unchanged.
Callback tasks are authenticated by a per-run/per-Wait capability, optionally
strengthened with the existing webhook HMAC or header-secret protocol. They are
not human tasks and never enter the human task list or Inbox audience.

A sending step can prepare a task before Wait runs. Preparation commits before
the credential is delivered; an early accepted response is retained without
advancing the workflow. Wait binds that same task to its exact invocation and
starts its required, at-most-thirty-day timeout. The existing task-result,
checkpoint, wakeup, expiry, clock and capacity owners settle it once. Prepared
and answered-but-unbound tasks consume the existing pending-task allowance.

Only token hashes and derivation key versions are stored. Purpose-specific,
versioned application keys reproduce the URL and optional authentication secret
after restart. Existing expression mappings carry references; materialization
occurs only in the sending attempt's bounded runtime context. External HTTP
steps suppress credential-bearing input capture and redact known echoes before
returning or writing response data. Data/file/Code mappings and workflow results
cannot read this binding. This is a bounded credential-delivery capability, not
a general information-flow/taint subsystem.

Callbacks lock the run and task in the existing order; a first valid response
commits its bounded output and wakeup together. Duplicates return 409, and
expired, canceled or terminal runs return 410 after authentication. Cancellation,
skipped scopes, retention and workspace purge close or remove unused prepared
callbacks. Replay gets new credentials. Whole-workflow draft tests issue live
callback credentials and pause at an unpinned callback Wait; pinned steps remain
samples and timed Waits complete immediately. Single-step previews never issue
callback credentials. Deploy matching readers before publishing callback mode.

The owner chose the invitation-token key pattern exactly: `CALLBACK_TOKEN_KEY`,
`CALLBACK_TOKEN_KEY_VERSION` and `CALLBACK_TOKEN_PREVIOUS_KEYS`, using the existing
fresh-install secret generator, startup refusal and separate backup-key supply.
