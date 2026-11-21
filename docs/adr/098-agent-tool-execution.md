# ADR 098 — The workflow engine owns agent tool continuations

- **Status:** proposed
- **Date:** 2026-11-21
- **Feature:** [F61](../feature-plans/61-ai-agent-step.md)
- **Related:** [ADR 094](094-model-steps.md), [F08](../feature-plans/08-subworkflows.md),
  [F10](../feature-plans/10-human-approvals.md)

## Context

A tool call can produce a durable effect, suspend for a person or wait for
a child. A worker may disappear while any of those actions is in progress.
The engine already models these events with invocations, attempts, task
decisions, checkpoints and receipts.

## Decision

Represent a model turn and a chosen tool as ordinary engine-scheduled
work within the Agent invocation. The AI integration executor performs
one bounded inference and returns a validated proposal or final result.
The engine's pure coordinator decides the next transition. Use the parent
invocation identity and persisted turn/call ordinal to derive stable child
invocation identities through the existing invocation scheme. A model's
tool call ID is protocol correlation data. The run versions pin the tool
definition, setup and bindings. Scheduled work carries the resolved
invocation identity and inputs.

Store an additive checkpoint continuation with a tagged phase for a model
turn, proposed call, approval wait, running tool or completion. Keep
the running budget and bounded receipt/output references there.
Store model and tool values under ordinary run-data retention. Commit the
proposal and budget with the checkpoint revision check before scheduling
its tool. Persist task creation or attempt admission and the corresponding
wake/outbox fact with the transition. Approval binds the exact pinned tool
and validated arguments. Resumption consumes its existing decision once.
A rejection, expiry or cancelled parent stops the proposed write. Every
new call needs its own decision unless publication allows that tool.

Use the same mapping/input admission, execution registry, lease,
connection dispatch guard, attempt completion receipt, retry decision and
audit/attempt attribution as for ordinary steps. A Call target enters
through existing child admission and completion paths. Normal workspace
capacity counts the actual attempts and child runs. While waiting on a tool
or approval, the Agent orchestration holds no attempt lease or slot.
Attribution records the initiating run, Agent invocation and tool identity
without recording credentials or raw arguments in audit.

A replacement coordinator resumes from the committed phase. Redelivery
consumes accepted completion receipts and never regenerates a committed
choice. Before dispatch a lease loss can use normal attempt recovery.
After dispatch an unreceipted write uses the step's existing retry class and
uncertain-effect handling. Only the normal provider idempotency guarantees
can justify retrying that effect. A still-uncommitted inference can repeat
within attempt and budget limits, with its previous reservation retained
for an unknown charge. Explicit full-run replay starts a new execution and
can take different actions. Surface effect and approval history in both runs.

## Alternatives and consequences

- An executor-local loop loses its position on lease loss and would need a
  second scheduler, approval bridge and effect ledger to preserve behavior.
- Compiling an arbitrary branching graph from every model reply would expand
  the workflow's authority beyond versioned tool bindings. The continuation
  schedules only precompiled work.
- The checkpoint change requires readers and recovery tests before enabling
  new writers. Existing versions remain readable. Rollback first disables
  new Agent admissions, with compatible workers draining retained runs.
