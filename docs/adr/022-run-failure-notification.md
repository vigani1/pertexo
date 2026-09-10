# ADR 022: Durable run failure notification intent

- **Status:** accepted
- **Date:** 2026-08-24

## Context

Phase 5 requires bounded safe failure notification, while Slack and email are
Phase 6 provider slices. Ordinary nodes run only through successful reachable
topology and would make notification failure part of the failed workflow,
creating recursive and ambiguous outcome semantics. Notification therefore
needs a durable execution-domain boundary without becoming alternate scheduler
state.

## Decision

Failure notification is a channel-neutral execution capability, not a workflow
node, error edge, or handler subgraph. No node definition, executor epoch, or
node-catalog cohort is added. A future graph-visible error handler requires a
separate structured orchestration decision.

When a coordinator first commits a run as `failed`, `timed_out`, or
`outcome_unknown`, the same PostgreSQL transaction commits the terminal
checkpoint and event, immutable notification intent, identifier-only outbox
delivery, and coordinator inbox completion. Success and explicit cancellation
create no failure intent. The unique logical identity is run ID, terminal event
sequence, and policy version. Duplicate or stale coordinator work cannot create
a second intent.

The immutable V1 context has `schemaVersion: 1`, canonical run/workflow/version
identities, terminal event sequence and status, trigger type, bounded start and
completion timestamps, one deterministic primary failure, and total failure
count. Primary failure is a strict union. When failed invocation state exists,
selection uses status severity (`outcome_unknown`, then `timed_out`, then
`failed`) followed by canonical invocation-key order, and the existing node
shape contains only node ID, invocation key, node status, attempt number, and
bounded `safeErrorCode`. A run that times out before any invocation exists uses
the run-level shape `{ source: 'run', runStatus: 'timed_out', safeErrorCode }`;
it does not invent a node. Keeping the existing node shape unchanged preserves
V1 contexts already stored before this clarification. The canonical context is
at most 4,096 UTF-8 bytes.

The context never contains run or node inputs, outputs, artifacts, graph/config
JSON, connection identifiers or secrets, provider request/response bodies or
headers, error summaries, exception text, stack traces, user labels, or actor
identity. Queue payloads carry only schema version, workspace ID, intent ID,
outbox ID, and optional trace context. Consumers reload and checksum the
workspace-scoped immutable context from PostgreSQL.

Delivery is separate from run truth. Its bounded V1 result is delivered,
definite failure, retry, or outcome unknown, with only a safe error code,
possibly-dispatched flag, and optional bounded opaque provider reference.
At-least-once dispatch follows ADR 007: durable intent/destination identity,
stable provider idempotency key when supported, a pre-call dispatch marker,
bounded retry for safe/idempotent delivery, and `outcome_unknown` for unsafe
ambiguous dispatch. Delivery state never changes or delays the original run,
checkpoint, invocation outcomes, or event sequence, and delivery failure never
creates another notification.

Phase 5 supplies the versioned intent/result contracts, atomic persistence,
transport consumer, and narrow injected delivery capability with recovery
proofs. Provider-specific Slack/email destinations are added in Phase 6 without
changing intent identity or run semantics. The capability remains disabled
until its consumer is readiness-advertised; producer activation and rollback
follow additive transport compatibility rather than node compatibility.

The run-level timeout shape is an additive-reader, then additive-writer rollout:

1. R0 is the predecessor artifact: it writes and strictly reads only the node
   primary-failure shape.
2. R1 retains the predecessor writer and deploys the dual-shape reader to every
   notification-consuming worker cohort. The repository's pinned predecessor
   and candidate fixtures must both pass the R1 reader before rollout proceeds.
   `FAILURE_NOTIFICATION_RUN_TIMEOUT_CONTEXT_ENABLED` is absent or exactly
   `false`, which is the fail-safe default, on every coordinator producer.
3. R2 enables the coordinator's run-level timeout writer only after R1 is fully
   deployed and its notification consumer readiness is healthy by setting
   `FAILURE_NOTIFICATION_RUN_TIMEOUT_CONTEXT_ENABLED=true` on coordinator
   producers. R2 retains the dual-shape reader. Values other than the exact
   strings `true` and `false` fail worker configuration before startup.

The API pins notification policy but neither reads nor writes notification
context, and the dispatcher transports only identifiers. The worker artifact
contains both the coordinator producer and delivery consumer, so release
activation—not queue routing—must enforce the R1-before-R2 order. Generic node
compatibility epochs and readiness do not advertise notification-context reader
support and cannot be used as evidence for this activation. The gate suppresses
only creation of a node-free run-timeout notification intent; it does not alter
terminal run/event persistence or predecessor node-primary notification intents.

During overlap, an R0 reader encountering the candidate shape must fail closed
before claiming the intent. PostgreSQL remains authoritative: the intent stays
pending and a dual-reader worker can claim it without creating another intent.
After a claimed worker restarts, ordinary recovery emits another identifier-only
outbox delivery for the same immutable intent and context. The mixed-version
integration proof covers this rejection, takeover, restart, recovery, and
redelivery path.

R2 rollback first sets the producer gate back to `false` on all coordinators and
may otherwise roll back only to R1. Rollback past R1 is forbidden while any candidate
shape can remain in an intent, unpublished outbox row, queue delivery, retry,
or retained replay population. Removing the run-level reader requires the
inventory's production zero-result evidence across the full retention and
redelivery window; stored context is never rewritten in place. These are
repository rollout requirements, not claims that a deployment has occurred.

Before intent creation, failure-blocked descendants must settle explicitly so
the run cannot remain nonterminal merely because an ordinary downstream node is
unreachable after failure. Completion order cannot choose notification context.

## Consequences

Terminal run truth is atomic and independent from notification delivery, and
safe context cannot leak provider material. The trade-off is a separate durable
intent/delivery lifecycle and deferred channel adapters rather than a visually
composable failure node.

## Rejected alternatives

- A `core.failure_notification` node or ordinary error edge.
- Delaying terminal run commit until notification delivery.
- Retrying or revising the failed workflow from notification state.
- Choosing the primary failure by arrival or completion time.
- Queueing the full context, graph, error summary, or provider body.
- Recursive notification when notification delivery fails.
- Shipping Slack or email semantics in Phase 5.
