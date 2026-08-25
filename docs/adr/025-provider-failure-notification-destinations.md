# ADR 025: Provider failure-notification destinations

- **Status:** accepted
- **Date:** 2026-08-25

## Context

ADR 022 defines durable run-failure notification as an execution capability,
not a workflow node. Phase 6 now has complete Slack and Resend provider clients,
but it still needs user-manageable destinations, immutable delivery identity,
connection fencing, and provider-specific outcome behavior.

The Phase 5 intent already pins a destination ID, destination config version,
side-effect class, safe context, and provider idempotency key. Provider delivery
must resolve that exact immutable configuration rather than a mutable latest
record, and failure-notification settings must not enter graph topology.

## Decision

V1 adds workspace-scoped failure-notification destination identities and
immutable config versions. A destination is one of:

- `slack`: one existing `slack`/`slack_bot_token` connection and one strict
  Slack channel ID; side-effect class `unsafe`.
- `email`: one existing `email`/`resend_api_key` connection and one normalized
  recipient mailbox; side-effect class `idempotent_with_key`.

Destination config versions are append-only. Update creates the next version
under an optimistic expected-version check; it never mutates an older version.
Disable prevents new runs from pinning the destination and prevents any
accepted intent that has not already committed its provider-dispatch fence from
sending provider bytes. It preserves the run pin, intent identity, immutable
version history, and audit truth rather than deleting or rewriting them.
Deleting destination or version history is outside Phase 6 retention
processing.

Each workflow may reference at most one enabled destination through a
workspace-scoped workflow policy. The policy is control-plane state separate
from draft and published graph JSON. Run acceptance locks the workflow policy,
active destination, exact current config version, matching active connection,
and active workspace in its transaction. It pins ADR 022 policy version 1 and
the provider's fixed side-effect class into the run. Existing runs and intents
never switch when the policy, destination, or connection later changes.

The API provides authorized create, append-version, enable/disable, read/list,
and workflow-policy set/clear operations. Management requires
`connection:manage`; reads and policy selection require workspace-scoped
workflow edit authority. Requests use strict versioned contracts, optimistic
configuration version checks, command idempotency, audit events, and
not-found disclosure across workspace boundaries. Responses never expose
credentials or encrypted-secret metadata.

Delivery loads the immutable destination version and resolves the pinned
connection secret just in time. Immediately before provider bytes, one
PostgreSQL transaction verifies active workspace, enabled destination and exact
version, connection identity/auth/current secret version, and intent dispatch
ownership. Destination disable is serialized on the destination row against
that final transition. If disable commits first, load/fence fails closed and no
provider bytes are sent; if `dispatching` commits first, disable cannot
time-travel to cancel bytes and the outcome follows that persisted dispatch
truth. Connection disable, rotation, reauthorization, or revocation also fails
closed rather than silently changing credentials. No provider call is made
after a failed fence.

Slack delivery reuses the fixed `chat.postMessage` client and deterministic safe
text rendered only from ADR 022 context. It records dispatch before the call,
never retries an ambiguous possibly dispatched result, and returns
`outcome_unknown`. Definite rate-limit or service-unavailable rejection may be
retried only before possible acceptance.

Email delivery reuses the fixed Resend client, pinned sender connection, and
recipient config. It sends one bounded plain-text message with the intent's
stable provider idempotency key. Retry uses identical sender, recipient,
subject, body, credential version, and key within the accepted retry horizon.
An unresolved changed credential or payload becomes `outcome_unknown`; it is
never replayed under a new provider account.

Provider references are bounded opaque Slack message timestamps or Resend UUIDs.
Safe errors use the existing delivery vocabulary. Destination targets,
connection IDs, message text, credentials, provider bodies, and headers never
enter queue payloads, telemetry attributes, logs, run events, or safe errors.
Delivery failure never changes or delays terminal run truth and never creates a
recursive notification.

The worker advertises notification readiness only when the destination store,
envelope encryption, fixed-origin clients, consumer, and both provider adapters
are composed. Activation is additive; disabling the consumer stops new delivery
claims while PostgreSQL intents and due recovery remain authoritative.

## Consequences

Users can route run failures to Slack or email without adding graph nodes, and
every intent remains reproducible against immutable configuration. Connection
rotation cannot create duplicate delivery under a different credential. The
trade-offs are one destination per workflow, one channel or recipient per
destination version, and no templates, fan-out lists, escalation chains, or
provider fallback in V1.

## Rejected alternatives

- A `failure_notification` node, error edge, or recursive notification workflow.
- Storing destination targets directly on runs without immutable destination
  identity and version history.
- Resolving the latest destination or connection version during retry.
- Sharing the graph-visible Slack/email executor invocation contract directly
  with the channel-neutral delivery consumer.
- Multiple destinations, fallback chains, templates, HTML, or arbitrary message
  content in V1.
- Retrying ambiguous Slack delivery or changed-credential Resend delivery.
