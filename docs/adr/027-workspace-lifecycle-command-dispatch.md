# ADR 027: Workspace lifecycle command dispatch

- **Status:** accepted
- **Date:** 2026-08-26

## Context

ADR 013 makes the external control ledger authoritative for workspace deletion,
restore, legal hold, purge start, and deletion completion. The tenant-facing API
currently performs deletion and restore directly in PostgreSQL. Giving that API
the maintenance database credential and generic ledger append credential would
collapse the production privilege boundary: compromise of a public process could
forge legal-hold, purge, or completion records even if TypeScript exposes only
request and restore methods.

Deletion and restore also have an unavoidable external-I/O crash window. A client
response cannot truthfully claim the lifecycle transition completed until both
ledger regions agree and PostgreSQL has projected the command and its local side
effects.

## Decision

Workspace deletion and restore are asynchronous control operations. The public
API may create and read a durable, tenant-scoped lifecycle intent through narrow
API-role database functions, but it receives neither maintenance credentials nor
control-ledger credentials. Creating an intent returns `202 Accepted` with an
operation resource. Exact idempotency-key replay returns the same operation;
changed command material conflicts.

A separate lifecycle-command worker is the only normal command writer. It owns a
dedicated restricted database credential, the dual-region ledger append
credentials, and no HTTP listener. It claims bounded intents with expiring leases
and monotonic fencing, reconciles the workspace to exact dual-ledger high water,
appends the exact request or restore record, projects it with required local side
effects, and records the immutable operation result. A crash or ambiguous append
leaves the intent retryable with the same command ID, occurrence time, actor,
reason, and request fingerprint.

The lifecycle command role is distinct from the broad recovery-maintenance role.
It may execute only intent claim/checkpoint and deletion-request/restore command
functions. It cannot place or release legal holds, enumerate all workspaces,
start purge, complete deletion, run migrations, mutate control tables directly,
or assume API, worker, owner, migration, or recovery-maintenance roles. The API
cannot claim or complete intents. Serving workers cannot create lifecycle intents.

The operation states are `pending`, `running`, `completed`, and `failed`.
External outage, timeout, partial regional append, process interruption, and
projection rollback remain retryable and do not become terminal failures.
`failed` is reserved for stable command rejection such as changed replay material,
lost authorization under the workspace lock, or an invalid lifecycle transition.
Bounded safe error codes may be exposed; credentials, ledger records, deletion
reasons, and tenant payloads are not returned by the operation resource.

The API does not mutate workspace lifecycle state when it accepts an intent.
Workspace state changes only when the authoritative ledger record is projected.
Clients poll the operation resource and use the resulting workspace reference
after completion. This means acceptance is durable but not equivalent to access
revocation. Product UI must represent the operation as pending until completion.

Deletion request time is generated once by PostgreSQL when the intent is created;
the default recovery deadline is exactly 30 days after that time. V1 no longer
accepts a caller-selected purge deadline. Restore uses a canonical server-owned
reason because its public endpoint has no request body. Authorization is checked
when the API creates the intent and checked again under the workspace lifecycle
lock before append. Restore returns the workspace to `suspended` and never
reactivates sessions, keys, connections, triggers, runs, or subscriptions.

Deployment keeps the lifecycle-command worker stopped during regional restore
until the restore-before-serve reconciliation gate has completed. Normal command
processing never repairs an unrelated one-sided ledger tail; only exact retry of
the matching durable command may heal its missing regional copy.

## Consequences

The public API remains least-privileged and cannot forge destructive control
history. Command retries have a durable identity before external I/O, and
operation status distinguishes accepted intent from completed projection.

The trade-off is an additional worker role, queue/outbox delivery path, operation
resource, and asynchronous client flow. Access revocation begins after command
projection rather than in the API transaction, so command backlog age requires a
tight alert and availability objective. The worker and its credentials become a
production deployment and recovery dependency.

## Rejected alternatives

- Giving the API maintenance and dual-ledger credentials and relying on a narrow
  in-process interface as the security boundary.
- Keeping direct PostgreSQL lifecycle mutation and treating the external ledger
  as an eventually consistent audit copy.
- Returning a synchronous success before dual-region append and PostgreSQL
  projection are both proven.
- Adding purge or legal-hold command authority to the lifecycle-command worker.
- Silently accepting a caller-provided purge deadline that is not authoritative.
