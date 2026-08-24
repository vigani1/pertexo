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
count. Primary failure selection uses status severity (`outcome_unknown`, then
`timed_out`, then `failed`) followed by canonical invocation-key order. It may
contain only node ID, invocation key, node status, attempt number, and bounded
`safeErrorCode`. The canonical context is at most 4,096 UTF-8 bytes.

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
